// src/providers/rabbitmq/rabbitmq-client.ts
import * as amqplib from "amqplib";
import { v4 as uuidv4 } from "uuid";
import { MessagingClient } from "../../core/messaging-client";
import {
  Message,
  MessageHandler,
  MessageOptions,
  SubscriptionOptions,
} from "../../core/types";
import {
  ConnectionError,
  PublishError,
  SubscriptionError,
} from "../../core/errors";
import { RabbitMQConfig, RabbitMQEvents } from "./types";
import { EventEmitter } from "events";

type SubscribeOptions = SubscriptionOptions & { ackMode: "auto" | "manual" };

interface Subscription {
  type: "standard" | "fanout" | "dlx";
  topic: string;
  handler: MessageHandler;
  options: SubscribeOptions & { dlxRoutingKey?: string };
  /** Queue name as requested by the caller (before getQueueName). */
  queueName?: string;
  dlxExchange?: string;
  dlxQueue?: string;
  /** Set while a consumer is active on the current channel. */
  consumerTag?: string;
}

/** Tracks whether a delivery was already acked/nacked, so it is never settled twice. */
interface Settlement {
  done: boolean;
  settle(action: () => void): void;
}

/**
 * A client for interacting with a RabbitMQ message broker.
 */
export class RabbitMQClient extends MessagingClient {
  protected connection: amqplib.Connection | null = null;
  private channel: amqplib.ConfirmChannel | null = null;
  private connectPromise: Promise<void> | null = null;
  private hasConnectedOnce = false;
  private closedByUser = false;
  private subscriptions: Map<string, Subscription> = new Map();
  private reconnectCallback: (() => void) | null = null;
  private rabbitEventEmitter: EventEmitter = new EventEmitter();
  protected config: RabbitMQConfig;
  private reconnectAttempts: number = 0;
  private isConnectionPermanentlyDown: boolean = false;
  private reconnectTimeout?: NodeJS.Timeout;
  private connectionMonitorInterval?: NodeJS.Timeout;

  constructor(private rabbitConfig: RabbitMQConfig) {
    super({
      reconnectInterval: 5000,
      ...rabbitConfig,
    });
    this.config = {
      reconnectInterval: 5000,
      ...rabbitConfig,
    };

    // Start connection monitoring
    this.startConnectionMonitor();
  }

  /**
   * Registers a listener for a specific event.
   * @param {RabbitMQEvents} event - The event to listen for.
   * @param {(...args: any[]) => void} listener - The listener function to call when the event is emitted.
   */
  public on(event: RabbitMQEvents, listener: (...args: any[]) => void): void {
    this.rabbitEventEmitter.on(event, listener);
  }

  /**
   * Removes a listener for a specific event.
   * @param {RabbitMQEvents} event - The event to stop listening for.
   * @param {(...args: any[]) => void} listener - The listener function to remove.
   */
  public off(event: RabbitMQEvents, listener: (...args: any[]) => void): void {
    this.rabbitEventEmitter.off(event, listener);
  }

  /**
   * Handles errors that occur during message processing.
   * @param {Error} error - The error that occurred.
   * @param {string} context - Additional context about where the error occurred.
   */
  public handleError(error: Error, context: string): void {
    this.log("error", `${context}: ${error.message}`);
    this.emitEvent("error", error);
  }

  /**
   * Emit a lifecycle event. An "error" with no listener would make EventEmitter throw
   * (crashing the process from inside amqplib callbacks), so it is only logged then.
   */
  private emitEvent(event: RabbitMQEvents, ...args: any[]): void {
    if (event === "error" && this.rabbitEventEmitter.listenerCount("error") === 0) {
      return;
    }
    this.rabbitEventEmitter.emit(event, ...args);
  }

  /**
   * Set a callback function for reconnection events.
   */
  public onReconnect(callback: () => void): void {
    this.reconnectCallback = callback;
  }

  /**
   * amqplib only reads frameMax, heartbeat and vhost from the URL (query string and path)
   * when given a string URL, so config values have to be written into it.
   * Explicit config wins over the URL; the URL wins over defaults.
   */
  private buildConnectionUrl(): string {
    const url = new URL(this.rabbitConfig.url);
    const setParam = (key: string, value: number | undefined, fallback: number) => {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      } else if (!url.searchParams.has(key)) {
        url.searchParams.set(key, String(fallback));
      }
    };

    // amqplib defaults frameMax to 4096; RabbitMQ 4.1+ rejects anything below 8192.
    setParam("frameMax", this.rabbitConfig.frameMax, 131072);
    setParam("heartbeat", this.rabbitConfig.heartbeat, 60);
    if (this.rabbitConfig.vhost !== undefined) {
      url.pathname = `/${encodeURIComponent(this.rabbitConfig.vhost)}`;
    }
    return url.toString();
  }

  /**
   * Generate or use a specified exchange name.
   */
  private getExchangeName(eventType?: string): string {
    if (this.rabbitConfig.getExchangeName) {
      return this.rabbitConfig.getExchangeName(eventType || "");
    }
    return eventType ? `events.${eventType}` : this.rabbitConfig.exchange;
  }

  private getQueueName(eventType: string, queueName?: string): string {
    if (this.rabbitConfig.getQueueName) {
      return this.rabbitConfig.getQueueName(eventType, queueName);
    }
    return queueName || `${eventType}.queue`;
  }

  /**
   * Create an exchange (fanout or topic).
   */
  private async createExchange(
    eventType?: string,
    exchangeType: string = this.rabbitConfig.exchangeType || "topic"
  ): Promise<void> {
    await this.ensureConnected();

    if (!this.channel) {
      throw new ConnectionError("Failed to establish connection to RabbitMQ");
    }

    const exchangeName = this.getExchangeName(eventType);
    await this.channel.assertExchange(exchangeName, exchangeType, {
      durable: true,
      ...this.rabbitConfig.exchangeOptions,
    });
  }

  /**
   * Publish a message to a fanout exchange.
   */
  public async publishToFanout<T>(
    eventType: string,
    message: T,
    options: MessageOptions = {}
  ): Promise<boolean> {
    await this.createExchange(eventType, "fanout");
    return this.publish("", message, options, eventType); // Fanout exchanges ignore the routing key
  }

  /**
   * Subscribe to events from a fanout exchange.
   */
  public async subscribeToFanout<T>(
    eventType: string,
    handler: MessageHandler<T>,
    queueName: string,
    options: SubscribeOptions = {
      ackMode: "manual",
    }
  ): Promise<string> {
    return this.addSubscription(
      {
        type: "fanout",
        topic: eventType,
        handler: handler as MessageHandler,
        queueName,
        options,
      },
      { requireConnection: true }
    );
  }

  /**
   * Sets up a dead letter exchange and queue, if configured.
   * If no DLX is configured, this method does nothing.
   * @private
   */
  private async setupDeadLetterExchange(ch: amqplib.Channel): Promise<void> {
    if (!this.config.deadLetterExchange) {
      return;
    }

    // Create the Dead Letter Exchange
    await ch.assertExchange(this.config.deadLetterExchange, "topic", {
      durable: true,
      autoDelete: false,
      ...this.rabbitConfig.exchangeOptions,
    });

    // Create the Dead Letter Queue if configured
    if (this.config.deadLetterQueue) {
      await ch.assertQueue(this.config.deadLetterQueue, {
        durable: true,
        arguments: {
          ...(this.rabbitConfig.queueOptions?.arguments || {}),
        },
      });

      // Use specific routing key if provided, otherwise use "#" as default
      const routingKey = this.config.deadLetterRoutingKey || "#";

      // Bind the DLQ to the DLX with the specified routing key
      await ch.bindQueue(
        this.config.deadLetterQueue,
        this.config.deadLetterExchange,
        routingKey
      );

      this.log(
        "info",
        `Dead Letter Queue '${this.config.deadLetterQueue}' bound to exchange '${this.config.deadLetterExchange}' with routing key '${routingKey}'`
      );
    }
  }

  /**
   * Connects to the RabbitMQ server.
   *
   * Never rejects: if the broker is unreachable, reconnection is scheduled in the background
   * (see `maxReconnectAttempts`) and callers can check `isConnected()` / listen for events.
   * Concurrent callers share the same in-flight attempt.
   */
  public async connect(): Promise<void> {
    if (this.channel) {
      return;
    }
    if (!this.connectPromise) {
      this.closedByUser = false;
      if (!this.connectionMonitorInterval) {
        this.startConnectionMonitor();
      }
      this.connectPromise = this.establishConnection().finally(() => {
        this.connectPromise = null;
      });
    }
    return this.connectPromise;
  }

  /**
   * Wait for a usable channel: joins an in-flight attempt, or starts one unless a
   * backoff retry is already scheduled.
   */
  private async ensureConnected(): Promise<void> {
    if (this.channel || this.isConnectionPermanentlyDown) {
      return;
    }
    if (this.connectPromise || !this.reconnectTimeout) {
      await this.connect();
    }
  }

  private async establishConnection(): Promise<void> {
    let conn: amqplib.Connection | undefined;
    try {
      conn = await amqplib.connect(this.buildConnectionUrl(), {
        timeout: this.rabbitConfig.connectionTimeout,
      });
      // Listen before anything else can fail: an 'error' without a listener crashes the process.
      const openedConn = conn;
      openedConn.on("error", (error: Error) => this.handleConnectionError(error));
      openedConn.once("close", () => this.handleConnectionClose(openedConn));

      const ch = await openedConn.createConfirmChannel();
      ch.on("error", (error: Error) => this.handleChannelError(error));
      ch.once("close", () => this.handleChannelClose(ch));

      const prefetch = Math.max(1, this.rabbitConfig.prefetch || 10);
      await ch.prefetch(prefetch);

      await ch.assertExchange(
        this.rabbitConfig.exchange,
        this.rabbitConfig.exchangeType || "topic",
        { durable: true, ...this.rabbitConfig.exchangeOptions }
      );

      await this.setupDeadLetterExchange(ch);

      if (this.closedByUser) {
        // close()/gracefulShutdown() ran while we were connecting: don't adopt this connection.
        openedConn.removeAllListeners("close");
        await openedConn.close().catch(() => {});
        return;
      }

      this.connection = openedConn;
      this.channel = ch;
      this.isConnectionPermanentlyDown = false;

      const isReconnect = this.hasConnectedOnce;
      this.hasConnectedOnce = true;
      // Snapshot before notifying: subscribe() calls from listeners set themselves up.
      const pending = Array.from(this.subscriptions.entries());
      this.emitEvent("connected");

      const resubscribed = await this.resubscribeAll(pending);
      // Only a fully healthy connection resets the backoff; otherwise a subscription that
      // keeps breaking the channel would reconnect forever.
      if (resubscribed) {
        this.reconnectAttempts = 0;
      }

      if (isReconnect) {
        this.emitEvent("reconnected");
        try {
          this.reconnectCallback?.();
        } catch (error: any) {
          this.log("error", `onReconnect callback failed: ${error.message}`);
        }
      }
    } catch (error: any) {
      this.log("error", `Connection error: ${error.message}`);
      this.emitEvent("error", error);

      if (conn && conn !== this.connection) {
        // Setup failed after the socket opened: discard this connection ourselves.
        conn.removeAllListeners("close");
        conn.close().catch(() => {});
        this.handleReconnectError(error);
      } else if (!conn) {
        this.handleReconnectError(error);
      }
      // Otherwise the connection was live and its close handler schedules the reconnect.
    }
  }

  /**
   * Publishes a message to a specified topic.
   * @param {string} topic - The topic to which the message will be published.
   * @param {T} message - The message to publish.
   * @param {MessageOptions} [options={}] - Additional options for the message (e.g., TTL, priority).
   * @param {string} [eventType] - Optional event type for categorizing the message.
   * @returns {Promise<boolean>} A promise that resolves to true if the message was published successfully, otherwise false.
   * @throws {Error} Throws an error if the publishing fails.
   */
  public async publish<T>(
    topic: string,
    message: T,
    options: MessageOptions = {},
    eventType?: string
  ): Promise<boolean> {
    if (this.isConnectionPermanentlyDown) {
      this.log(
        "warn",
        "Message not sent - RabbitMQ connection is permanently down"
      );
      return false;
    }

    await this.ensureConnected();

    if (!this.channel) {
      return false;
    }

    try {
      const exchangeName = this.getExchangeName(eventType);
      const content = Buffer.from(JSON.stringify(message));

      return this.channel.publish(exchangeName, topic, content, {
        persistent: true,
        contentType: "application/json",
        expiration: options.ttl?.toString(),
        priority: options.priority,
        ...options,
      });
    } catch (error: any) {
      this.log("error", `Failed to publish message: ${error.message}`);
      return false;
    }
  }

  /**
   * Subscribes to a specified topic.
   * If the client is not connected yet, the subscription is registered and set up on connect.
   * @param {string} topic - The topic to subscribe to.
   * @param {MessageHandler<T>} handler - The callback function to handle incoming messages.
   * @param {SubscriptionOptions} [options={ ackMode: 'manual' }] - Options for the subscription, including acknowledgment mode.
   * @returns {Promise<string>} A promise that resolves to a subscription ID, stable across reconnects.
   * @throws {SubscriptionError} If the broker rejects the queue or binding.
   */
  public async subscribe<T>(
    topic: string,
    handler: MessageHandler<T>,
    options: SubscribeOptions = {
      ackMode: "manual",
    }
  ): Promise<string> {
    return this.addSubscription(
      {
        type: "standard",
        topic,
        handler: handler as MessageHandler,
        queueName: options.queueName,
        options,
      },
      { requireConnection: false }
    );
  }

  /**
   * Subscribes to a specified topic and enables Dead Letter Exchange (DLX) for failed messages.
   * @param {string} topic - The topic to subscribe to.
   * @param {MessageHandler<T>} handler - The callback function to handle incoming messages.
   * @param {string} dlxExchange - The name of the dead letter exchange.
   * @param {string} dlxQueue - The name of the dead letter queue.
   * @param {SubscriptionOptions} [options={ ackMode: 'manual' }] - Options for the subscription, including acknowledgment mode.
   * @returns {Promise<string>} A promise that resolves to a subscription ID.
   * @throws {Error} Throws an error if the subscription fails.
   */
  public async subscribeWithDLX<T>(
    topic: string,
    handler: MessageHandler<T>,
    dlxExchange: string,
    dlxQueue: string,
    options: SubscribeOptions & {
      dlxRoutingKey?: string; // Add optional routing key
    } = {
      ackMode: "manual",
    }
  ): Promise<string> {
    return this.addSubscription(
      {
        type: "dlx",
        topic,
        handler: handler as MessageHandler,
        queueName: options.queueName,
        dlxExchange,
        dlxQueue,
        options,
      },
      { requireConnection: true }
    );
  }

  private async addSubscription(
    sub: Subscription,
    { requireConnection }: { requireConnection: boolean }
  ): Promise<string> {
    if (sub.options.retry && !sub.queueName) {
      throw new SubscriptionError(
        `Retry for ${sub.topic} requires a queueName, so retried messages have a durable queue to return to`
      );
    }

    if (requireConnection) {
      await this.ensureConnected();
      if (!this.channel) {
        throw new SubscriptionError("Failed to establish connection to RabbitMQ");
      }
    }

    const subscriptionId = uuidv4();
    this.subscriptions.set(subscriptionId, sub);

    if (!this.channel) {
      if (this.isConnectionPermanentlyDown) {
        this.log(
          "warn",
          "RabbitMQ connection is permanently down - subscription registered but inactive"
        );
      } else {
        this.log(
          "info",
          "RabbitMQ connection not available, subscription will be established when connected"
        );
        this.ensureConnected();
      }
      return subscriptionId;
    }

    try {
      await this.setupConsumer(subscriptionId, sub);
    } catch (error: any) {
      // Don't keep it: it would break the channel again on every reconnect.
      this.subscriptions.delete(subscriptionId);
      this.log("error", `Failed to subscribe to topic ${sub.topic}: ${error.message}`);
      throw new SubscriptionError(`Failed to subscribe to ${sub.topic}: ${error.message}`);
    }
    return subscriptionId;
  }

  /** Declare the subscription's queues and bindings and start consuming on the current channel. */
  private async setupConsumer(subscriptionId: string, sub: Subscription): Promise<void> {
    const ch = this.channel;
    if (!ch) return;

    const queue = await this.declareTopology(ch, sub);
    const { consumerTag } = await ch.consume(
      queue,
      this.createMessageHandler(ch, sub, queue),
      // Always explicit acks: "auto" means the client acks after the handler succeeds.
      { noAck: false }
    );

    if (this.subscriptions.get(subscriptionId) !== sub) {
      // Unsubscribed while we were setting up.
      await ch.cancel(consumerTag).catch(() => {});
      return;
    }
    sub.consumerTag = consumerTag;
  }

  private async declareTopology(ch: amqplib.Channel, sub: Subscription): Promise<string> {
    const { options } = sub;
    let queue: string;

    if (sub.type === "fanout") {
      const exchangeName = this.getExchangeName(sub.topic);
      // Declare it here too: consumers often start before any publisher has created it.
      await ch.assertExchange(exchangeName, "fanout", {
        durable: true,
        ...this.rabbitConfig.exchangeOptions,
      });
      ({ queue } = await ch.assertQueue(this.getQueueName(sub.topic, sub.queueName), {
        exclusive: !sub.queueName,
        durable: !!sub.queueName,
        autoDelete: !sub.queueName,
      }));
      await ch.bindQueue(queue, exchangeName, "");
    } else {
      // Queue arguments must stay exactly as before: RabbitMQ refuses (406) to redeclare
      // an existing queue with different arguments.
      let queueArgs: Record<string, unknown> = { ...(options.arguments || {}) };

      if (sub.type === "dlx") {
        const dlxRoutingKey = this.dlxRoutingKey(sub);
        await ch.assertExchange(sub.dlxExchange!, "topic", { durable: true });
        await this.assertQueueIfMissing(ch, sub.dlxQueue!, { durable: true });
        await ch.bindQueue(sub.dlxQueue!, sub.dlxExchange!, dlxRoutingKey);
        queueArgs = {
          "x-dead-letter-exchange": sub.dlxExchange,
          "x-dead-letter-routing-key": dlxRoutingKey,
          ...(options.arguments || {}),
        };
      } else if (this.config.deadLetterExchange) {
        queueArgs = {
          ...queueArgs,
          "x-dead-letter-exchange": this.config.deadLetterExchange,
          "x-dead-letter-routing-key":
            this.config.deadLetterMessageRoutingKey || sub.topic,
        };
      }

      ({ queue } = await ch.assertQueue(this.getQueueName(sub.topic, sub.queueName), {
        exclusive: options.exclusive ?? !sub.queueName,
        durable: options.durable ?? !!sub.queueName,
        autoDelete: options.autoDelete ?? !sub.queueName,
        arguments: queueArgs,
      }));

      // Use custom exchange name if provided, otherwise use the default
      const exchangeName = options.exchangeName || this.getExchangeName();
      if (options.exchangeName) {
        await ch.assertExchange(
          exchangeName,
          options.exchangeType || this.rabbitConfig.exchangeType || "topic",
          {
            durable: true,
            ...this.rabbitConfig.exchangeOptions,
          }
        );
      }
      await ch.bindQueue(queue, exchangeName, sub.topic);
    }

    if (options.retry) {
      await this.declareRetryQueues(ch, sub, queue);
    }
    return queue;
  }

  /**
   * One queue per delay. Messages sit there until the queue's TTL expires, then the broker
   * dead-letters them through the default exchange straight back to the consumer's queue,
   * so other queues bound to the same routing key never see the retry.
   * (A per-queue TTL avoids head-of-line blocking that per-message TTLs have.)
   */
  private async declareRetryQueues(
    ch: amqplib.Channel,
    sub: Subscription,
    queue: string
  ): Promise<void> {
    const retry = sub.options.retry!;
    for (const delay of new Set(retry.delays)) {
      await ch.assertQueue(this.retryQueueName(queue, delay), {
        durable: sub.options.durable ?? true,
        arguments: {
          "x-message-ttl": delay,
          "x-dead-letter-exchange": "",
          "x-dead-letter-routing-key": queue,
        },
      });
    }

    const target = this.deadLetterTarget(sub, queue, sub.topic);
    if (target?.exchange === "") {
      await this.assertQueueIfMissing(ch, target.routingKey, { durable: true });
    }
  }

  /**
   * Declare a queue only if it does not exist yet. Used for dead-letter queues, which older
   * versions declared with different arguments; redeclaring those would fail with 406.
   */
  private async assertQueueIfMissing(
    ch: amqplib.Channel,
    name: string,
    options: amqplib.Options.AssertQueue
  ): Promise<void> {
    if (!this.connection) {
      throw new ConnectionError("Not connected to RabbitMQ");
    }
    // A 404 from checkQueue closes the channel it ran on, so probe on a throwaway one.
    const probe = await this.connection.createChannel();
    probe.on("error", () => {});
    try {
      await probe.checkQueue(name);
      await probe.close();
      return;
    } catch {
      // Missing queue: the probe channel is already closed by the broker.
    }
    await ch.assertQueue(name, options);
  }

  private retryQueueName(queue: string, delay: number): string {
    return `${queue}.retry.${delay}`;
  }

  private dlxRoutingKey(sub: Subscription): string {
    return sub.options.dlxRoutingKey || "#";
  }

  /** Where a message goes when it will not be retried (any more), or null to requeue. */
  private deadLetterTarget(
    sub: Subscription,
    queue: string,
    originalRoutingKey: string
  ): { exchange: string; routingKey: string } | null {
    if (sub.type === "dlx") {
      return { exchange: sub.dlxExchange!, routingKey: this.dlxRoutingKey(sub) };
    }
    const retry = sub.options.retry;
    if (retry?.deadLetterQueue) {
      return { exchange: "", routingKey: retry.deadLetterQueue };
    }
    if (this.config.deadLetterExchange) {
      return {
        exchange: this.config.deadLetterExchange,
        routingKey: this.config.deadLetterMessageRoutingKey || originalRoutingKey,
      };
    }
    if (retry) {
      return { exchange: "", routingKey: `${queue}.dlq` };
    }
    return null;
  }

  /**
   * Move messages from a dead-letter queue back to the queue they failed in, with a fresh
   * retry budget. Use it once the cause of the failures is fixed.
   * @param deadLetterQueue - The queue holding parked messages.
   * @param options.limit - Maximum number of messages to move (default: all).
   * @param options.targetQueue - Override the destination (default: the queue each message failed in).
   * @returns The number of messages moved.
   */
  public async replayDeadLetters(
    deadLetterQueue: string,
    options: { limit?: number; targetQueue?: string } = {}
  ): Promise<number> {
    await this.ensureConnected();
    const ch = this.channel;
    if (!ch) {
      throw new ConnectionError("Failed to establish connection to RabbitMQ");
    }

    const limit = options.limit ?? Infinity;
    let moved = 0;
    while (moved < limit) {
      const msg = await ch.get(deadLetterQueue, { noAck: false });
      if (!msg) break;

      const headers = { ...(msg.properties.headers || {}) };
      const target =
        options.targetQueue ??
        headers["x-original-queue"] ??
        headers["x-death"]?.[0]?.queue;
      if (!target) {
        ch.nack(msg, false, true);
        this.log(
          "warn",
          `Stopped replaying ${deadLetterQueue}: message has no original queue; pass targetQueue`
        );
        break;
      }

      for (const key of [
        "x-retry-count",
        "x-error",
        "x-error-stack",
        "x-failed-at",
        "x-original-queue",
        "x-death",
      ]) {
        delete headers[key];
      }
      await this.publishConfirmed(ch, "", target, msg, headers);
      ch.ack(msg);
      moved++;
    }
    return moved;
  }

  /**
   * Unsubscribe from a previously subscribed topic.
   * Works while disconnected too: the subscription is not restored on reconnect.
   * @param subscriptionId - The ID of the subscription to unsubscribe from
   * @throws {SubscriptionError} If cancelling the consumer fails
   */
  public async unsubscribe(subscriptionId: string): Promise<void> {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) {
      return;
    }
    this.subscriptions.delete(subscriptionId);

    if (!this.channel || !subscription.consumerTag) {
      return;
    }
    try {
      await this.channel.cancel(subscription.consumerTag);
    } catch (error: any) {
      throw new SubscriptionError(`Failed to unsubscribe: ${error.message}`);
    }
  }

  /**
   * Closes the connection to RabbitMQ, releasing all resources.
   *
   * This method is idempotent; it will not throw an error if the connection
   * is already closed.
   */
  public async close(): Promise<void> {
    this.closedByUser = true;
    this.stopTimers();
    this.reconnectAttempts = 0;
    await this.closeConnection();
  }

  private stopTimers(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }
    if (this.connectionMonitorInterval) {
      clearInterval(this.connectionMonitorInterval);
      this.connectionMonitorInterval = undefined;
    }
  }

  /** Close channel and connection without triggering the reconnect path. */
  private async closeConnection(): Promise<void> {
    const ch = this.channel;
    const conn = this.connection;
    // Clear first so the close handlers see a stale reference and stay quiet.
    this.channel = null;
    this.connection = null;
    this.clearConsumerTags();

    if (ch) {
      await ch.close().catch((error) => {
        this.log("warn", `Error closing channel: ${error}`);
      });
    }
    if (conn) {
      await conn.close().catch((error) => {
        this.log("warn", `Error closing connection: ${error}`);
      });
      this.emitEvent("disconnected");
    }
  }

  /**
   * Gracefully shuts down the RabbitMQ client.
   *
   * Initiates a graceful shutdown process by first checking for any in-progress messages.
   * If there are messages being processed, it waits for them to complete or until the
   * specified timeout is reached. Once all messages are processed or timeout occurs,
   * it closes the channel and connection to RabbitMQ. Logs the shutdown process and
   * handles any errors that occur during the shutdown.
   *
   * @param timeout - The maximum time in milliseconds to wait for in-progress messages
   *                  to complete before forcing a shutdown. Defaults to 5000ms.
   * @returns A promise that resolves when the shutdown process completes.
   */

  public async gracefulShutdown(timeout: number = 5000): Promise<void> {
    this.log("info", "Starting graceful shutdown...");

    // Prevent reconnection attempts and new publishes
    this.closedByUser = true;
    this.isConnectionPermanentlyDown = true;
    this.stopTimers();

    // No active connection, nothing to clean up
    if (!this.connection || !this.channel) {
      this.log("info", "No active connection to close");
      await this.closeConnection();
      return;
    }

    if (this.inProgressMessages > 0) {
      this.log(
        "info",
        `Waiting for ${this.inProgressMessages} messages to complete...`
      );

      try {
        await Promise.race([
          // Wait for in-progress messages to complete
          new Promise<void>((resolve) => {
            const checkInterval = setInterval(() => {
              if (this.inProgressMessages === 0) {
                clearInterval(checkInterval);
                resolve();
              }
            }, 100);
          }),
          // Or timeout
          new Promise<void>((_, reject) => {
            setTimeout(() => {
              reject(new Error("Shutdown timeout exceeded"));
            }, timeout);
          }),
        ]);
      } catch (error) {
        this.log(
          "warn",
          `Shutdown timed out after ${timeout}ms, forcing close.`
        );
        // Continue with shutdown even after timeout
      }
    }

    await this.closeConnection();
  }

  private inProgressMessages = 0;

  /**
   * Creates the consumer callback for a subscription.
   *
   * Acks go to the channel that delivered the message: delivery tags are per channel, and
   * acking an old tag on a new channel after a reconnect is a 406 that kills the channel.
   *
   * In "auto" mode the message is acked after the handler resolves. In "manual" mode the
   * handler settles it via ack/nack/reject. If the handler throws (in either mode) and has
   * not settled the message, it is retried, dead-lettered or requeued (see handleFailure).
   */
  private createMessageHandler(ch: amqplib.ConfirmChannel, sub: Subscription, queue: string) {
    const { handler } = sub;
    const { ackMode } = sub.options;

    return async (msg: amqplib.ConsumeMessage | null) => {
      if (!msg) {
        return;
      }

      this.inProgressMessages++;
      const settlement: Settlement = {
        done: false,
        settle: (action) => {
          if (settlement.done) return;
          settlement.done = true;
          try {
            action();
          } catch (error: any) {
            // The channel closed under us; the broker will redeliver.
            this.log("warn", `Could not settle message: ${error.message}`);
          }
        },
      };

      try {
        const headers = msg.properties.headers || {};
        let content: unknown;
        try {
          content = JSON.parse(msg.content.toString());
        } catch (error: any) {
          this.handleError(error, `Unparseable message on ${queue}`);
          await this.handleFailure(ch, sub, queue, msg, error, false, settlement);
          return;
        }

        const message: Message = {
          content,
          routingKey: headers["x-original-routing-key"] ?? msg.fields.routingKey,
          options: {
            headers: msg.properties.headers,
            contentType: msg.properties.contentType,
            contentEncoding: msg.properties.contentEncoding,
            correlationId: msg.properties.correlationId,
            replyTo: msg.properties.replyTo,
            messageId: msg.properties.messageId,
            timestamp: msg.properties.timestamp,
          },
          originalMessage: msg,
          timestamp: new Date(msg.properties.timestamp),
          messageId: msg.properties.messageId,
          retryCount: Number(headers["x-retry-count"] ?? 0),
          ack: async () => {
            if (ackMode === "manual") settlement.settle(() => ch.ack(msg));
          },
          nack: async (requeue: boolean = true) => {
            if (ackMode === "manual") settlement.settle(() => ch.nack(msg, false, requeue));
          },
          reject: async (requeue: boolean = false) => {
            if (ackMode === "manual") settlement.settle(() => ch.reject(msg, requeue));
          },
        };

        try {
          await handler(message);
        } catch (error: any) {
          this.handleError(
            error instanceof Error ? error : new Error(String(error)),
            "Error processing message"
          );
          const retryable = !sub.options.retry?.nonRetryable?.(error);
          await this.handleFailure(ch, sub, queue, msg, error, retryable, settlement);
          return;
        }

        if (ackMode === "auto") {
          settlement.settle(() => ch.ack(msg));
        }
      } finally {
        this.inProgressMessages--;
      }
    };
  }

  /**
   * A message failed. In order of preference:
   * 1. retry: publish to the next retry queue (delayed redelivery to this queue only),
   * 2. dead-letter: publish to the subscription's DLX / global DLX / parking queue,
   * 3. otherwise requeue (or drop unparseable messages, which can never succeed).
   * The original is acked only after the broker confirms the copy, so nothing is lost.
   */
  private async handleFailure(
    ch: amqplib.ConfirmChannel,
    sub: Subscription,
    queue: string,
    msg: amqplib.ConsumeMessage,
    error: unknown,
    retryable: boolean,
    settlement: Settlement
  ): Promise<void> {
    if (settlement.done) {
      return; // The handler already acked/nacked it.
    }

    const retry = sub.options.retry;
    const headers: Record<string, any> = { ...(msg.properties.headers || {}) };
    const retryCount = Number(headers["x-retry-count"] ?? 0);
    headers["x-original-routing-key"] ??= msg.fields.routingKey;
    headers["x-original-queue"] = queue;

    try {
      if (retry && retryable && retryCount < retry.delays.length) {
        headers["x-retry-count"] = retryCount + 1;
        await this.publishConfirmed(
          ch,
          "",
          this.retryQueueName(queue, retry.delays[retryCount]),
          msg,
          headers
        );
        settlement.settle(() => ch.ack(msg));
        return;
      }

      const target = this.deadLetterTarget(sub, queue, headers["x-original-routing-key"]);
      if (target) {
        headers["x-retry-count"] = retryCount;
        headers["x-error"] = error instanceof Error ? error.message : String(error);
        if (error instanceof Error && error.stack) {
          headers["x-error-stack"] = error.stack;
        }
        headers["x-failed-at"] = new Date().toISOString();
        await this.publishConfirmed(ch, target.exchange, target.routingKey, msg, headers);
        settlement.settle(() => ch.ack(msg));
        return;
      }
    } catch (publishError: any) {
      this.log(
        "error",
        `Failed to move message out of ${queue}: ${publishError.message}; requeueing`
      );
      settlement.settle(() => ch.nack(msg, false, true));
      return;
    }

    if (retryable) {
      // No retry or dead-letter configured: requeue for immediate redelivery.
      settlement.settle(() => ch.nack(msg, false, true));
    } else {
      this.log(
        "error",
        `Rejecting unprocessable message on ${queue} (configure retry or a DLX to keep it)`
      );
      settlement.settle(() => ch.reject(msg, false));
    }
  }

  /** Publish a copy of a delivered message and wait for the broker to confirm it. */
  private publishConfirmed(
    ch: amqplib.ConfirmChannel,
    exchange: string,
    routingKey: string,
    msg: amqplib.Message,
    headers: Record<string, any>
  ): Promise<void> {
    // userId must match the connection's user or the broker closes the channel.
    const { userId, clusterId, headers: _headers, ...properties } = msg.properties as any;
    return new Promise((resolve, reject) => {
      try {
        ch.publish(exchange, routingKey, msg.content, { ...properties, headers }, (err) =>
          err ? reject(err) : resolve()
        );
      } catch (error) {
        reject(error);
      }
    });
  }

  private handleConnectionError(error: Error): void {
    // amqplib always emits 'close' after 'error'; reconnection is scheduled from there.
    this.log("error", `RabbitMQ connection error: ${error.message}`);
    this.emitEvent("error", error);
  }

  private handleConnectionClose(conn: amqplib.Connection): void {
    if (conn !== this.connection) {
      return;
    }
    this.log("info", "RabbitMQ connection closed");
    this.connection = null;
    this.channel = null;
    this.clearConsumerTags();
    this.emitEvent("disconnected");

    if (!this.closedByUser && !this.isConnectionPermanentlyDown) {
      this.handleReconnectError(new Error("Connection closed unexpectedly"));
    }
  }

  private handleChannelError(error: Error): void {
    // amqplib emits 'close' after 'error'; recovery happens there.
    this.log("error", `RabbitMQ channel error: ${error.message}`);
    this.emitEvent("error", error);
  }

  /**
   * The server closed our channel (e.g. 406 PRECONDITION_FAILED) while the connection
   * stayed open. Recycle the whole connection so the normal reconnect path restores
   * the channel and all subscriptions.
   */
  private handleChannelClose(ch: amqplib.Channel): void {
    if (ch !== this.channel) {
      return;
    }
    this.channel = null;
    if (this.closedByUser) {
      return;
    }
    this.log("warn", "RabbitMQ channel closed unexpectedly, recycling connection");
    this.connection?.close().catch(() => {
      // Already closing; its close handler takes over.
    });
  }

  private clearConsumerTags(): void {
    for (const sub of this.subscriptions.values()) {
      sub.consumerTag = undefined;
    }
  }

  /** Restore consumers after a (re)connect, keeping every subscription id. */
  private async resubscribeAll(pending: [string, Subscription][]): Promise<boolean> {
    let allOk = true;
    for (const [id, sub] of pending) {
      if (this.subscriptions.get(id) !== sub || sub.consumerTag) {
        continue; // Unsubscribed meanwhile, or already set up by subscribe().
      }
      try {
        await this.setupConsumer(id, sub);
      } catch (error: any) {
        this.log("error", `Failed to resubscribe to ${sub.topic}: ${error.message}`);
        allOk = false;
      }
    }
    return allOk;
  }

  private startConnectionMonitor(): void {
    if (this.connectionMonitorInterval) {
      clearInterval(this.connectionMonitorInterval);
    }

    this.connectionMonitorInterval = setInterval(() => {
      if (this.isConnectionPermanentlyDown) {
        this.log("info", "Periodic connection health check");
        this.attemptRecovery();
      }
    }, 300000); // Every 5 minutes
  }

  public async attemptRecovery(): Promise<void> {
    if (this.isConnectionPermanentlyDown) {
      this.log("info", "Attempting manual RabbitMQ connection recovery");
      this.isConnectionPermanentlyDown = false;
      this.reconnectAttempts = 0;
      await this.connect();
    }
  }

  public getConnectionStatus(): {
    connected: boolean;
    permanentFailure: boolean;
    retryCount: number;
  } {
    return {
      connected: !!this.connection,
      permanentFailure: this.isConnectionPermanentlyDown,
      retryCount: this.reconnectAttempts,
    };
  }

  /**
   * Handles error during reconnection attempts by applying exponential backoff
   * and eventually marking the connection as permanently down after maximum attempts.
   */
  private handleReconnectError(error: Error): void {
    const cfg = this.rabbitConfig;
    const initial = !this.hasConnectedOnce;
    const maxAttempts = initial
      ? cfg.initialConnectionRetries ?? cfg.maxReconnectAttempts ?? 10
      : cfg.maxReconnectAttempts ?? 10;

    if (this.reconnectAttempts >= maxAttempts) {
      if (!this.isConnectionPermanentlyDown) {
        this.isConnectionPermanentlyDown = true;
        this.log(
          "error",
          `Max reconnect attempts reached (${error.message}). RabbitMQ connection is offline. Server remains operational.`
        );
        this.emitEvent("connection_permanently_down");
      }
      return;
    }

    this.reconnectAttempts++;
    const delay =
      initial && cfg.initialConnectionDelay !== undefined
        ? cfg.initialConnectionDelay
        : Math.min(
            (cfg.reconnectInterval ?? 2000) *
              Math.pow(cfg.reconnectBackoffMultiplier ?? 2, this.reconnectAttempts - 1),
            cfg.maxReconnectDelay ?? 30000
          );

    this.log(
      "warn",
      `Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${maxAttempts})`
    );

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = undefined;
      this.connect();
    }, delay);
  }
}

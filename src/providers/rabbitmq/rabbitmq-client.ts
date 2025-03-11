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

/**
 * A client for interacting with a RabbitMQ message broker.
 */
export class RabbitMQClient extends MessagingClient {
  protected connection: amqplib.Connection | null = null;
  private channel: amqplib.Channel | null = null;
  private connecting = false;
  private subscriptions: Map<
    string,
    {
      topic: string;
      handler: MessageHandler;
      consumerTag?: string;
      queueName?: string;
      type: "standard" | "fanout" | "dlx";
      dlxExchange?: string;
      dlxQueue?: string;
      options?: SubscriptionOptions;
    }
  > = new Map();
  private reconnectCallback: (() => void) | null = null;
  private rabbitEventEmitter: EventEmitter = new EventEmitter();
  private logLevel: "info" | "warn" | "error" = "info";
  protected config: RabbitMQConfig;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectBaseDelay: number = 1000;
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
    this.rabbitEventEmitter.emit("error", error as Error);
  }

  /**
   * Set a callback function for reconnection events.
   */
  public onReconnect(callback: () => void): void {
    this.reconnectCallback = callback;
  }

  /**
   * Sets the logging level for the RabbitMQ client.
   * @param {"info" | "warn" | "error"} level - The logging level to set.
   */
  public setLogLevel(level: "info" | "warn" | "error"): void {
    this.logLevel = level;
  }

  /**
   * Log messages based on the current log level.
   */
  private log(level: "info" | "warn" | "error", message: string): void {
    const timestamp = new Date().toISOString();
    if (
      this.logLevel === "info" ||
      (this.logLevel === "warn" && level !== "info") ||
      level === "error"
    ) {
      console[level](`[${timestamp}] [RabbitMQClient] ${message}`);
    }
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
    if (!this.channel) {
      await this.connect();
    }

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
   * Create a dynamic queue for the microservice.
   */
  private async createDynamicQueue(
    eventType: string,
    queueName: string,
    queueOptions: amqplib.Options.AssertQueue = {}
  ): Promise<string> {
    if (!this.channel) {
      await this.connect();
    }

    if (!this.channel) {
      throw new ConnectionError("Failed to establish connection to RabbitMQ");
    }

    const exchangeName = this.getExchangeName(eventType);
    const dynamicQueueName = this.getQueueName(eventType, queueName);
    const { queue } = await this.channel.assertQueue(dynamicQueueName, {
      exclusive: !queueName,
      durable: !!queueName,
      autoDelete: !queueName,
      ...queueOptions,
    });

    // Bind the queue to the exchange
    await this.channel.bindQueue(queue, exchangeName, "");

    return queue;
  }

  /**
   * Subscribe to events from a fanout exchange using a dynamic queue.
   */
  public async subscribeToFanout<T>(
    eventType: string,
    handler: MessageHandler<T>,
    queueName: string,
    options: SubscriptionOptions & { ackMode: "auto" | "manual" } = {
      ackMode: "manual",
    }
  ): Promise<string> {
    const subscriptionId = uuidv4();

    const queue = await this.createDynamicQueue(eventType, queueName);

    // Start consuming messages
    const { consumerTag } = await this.channel!.consume(
      queue,
      this.createMessageHandler(subscriptionId, handler, options.ackMode),
      { noAck: options.ackMode === "auto" }
    );

    // Store subscription with unique ID
    this.subscriptions.set(subscriptionId, {
      topic: eventType,
      handler,
      consumerTag,
      queueName: queue,
      type: "fanout",
      options,
    });

    return subscriptionId;
  }

  /**
   * Sets up a dead letter exchange and queue, if configured.
   * If no DLX is configured, this method does nothing.
   * @private
   */
  private async setupDeadLetterExchange(): Promise<void> {
    if (!this.channel || !this.config.deadLetterExchange) {
      return;
    }

    try {
      // Create the Dead Letter Exchange
      await this.channel.assertExchange(
        this.config.deadLetterExchange,
        "topic",
        {
          durable: true,
          autoDelete: false,
          ...this.rabbitConfig.exchangeOptions,
        }
      );

      // Create the Dead Letter Queue if configured
      if (this.config.deadLetterQueue) {
        await this.channel.assertQueue(this.config.deadLetterQueue, {
          durable: true,
          arguments: {
            ...(this.rabbitConfig.queueOptions?.arguments || {}),
          },
        });

        // Use specific routing key if provided, otherwise use "#" as default
        const routingKey = this.config.deadLetterRoutingKey || "#";

        // Bind the DLQ to the DLX with the specified routing key
        await this.channel.bindQueue(
          this.config.deadLetterQueue,
          this.config.deadLetterExchange,
          routingKey
        );

        this.log(
          "info",
          `Dead Letter Queue '${this.config.deadLetterQueue}' bound to exchange '${this.config.deadLetterExchange}' with routing key '${routingKey}'`
        );
      }
    } catch (error: any) {
      this.log(
        "error",
        `Failed to setup Dead Letter Exchange: ${error.message}`
      );
    }
  }

  /**
   * Connects to the RabbitMQ server.
   * @returns {Promise<void>} A promise that resolves when the connection is established.
   * @throws {Error} Throws an error if the connection fails.
   */
  public async connect(): Promise<void> {
    if (this.connection || this.connecting) {
      return;
    }

    this.connecting = true;

    const attemptConnection = async () => {
      try {
        const conn = await amqplib.connect(this.rabbitConfig.url, {
          heartbeat: this.rabbitConfig.heartbeat || 60,
          vhost: this.rabbitConfig.vhost || "/",
          timeout: this.rabbitConfig.connectionTimeout,
        });
        this.connection = conn;

        const ch = await conn.createChannel();
        this.channel = ch;

        const prefetch = Math.max(1, this.rabbitConfig.prefetch || 10);
        await ch.prefetch(prefetch);

        await ch.assertExchange(
          this.rabbitConfig.exchange,
          this.rabbitConfig.exchangeType || "topic",
          { durable: true, ...this.rabbitConfig.exchangeOptions }
        );

        if (this.config.deadLetterExchange) {
          await this.setupDeadLetterExchange();
        }

        conn.on("error", this.handleConnectionError.bind(this));
        conn.on("close", this.handleConnectionClose.bind(this));

        this.connecting = false;
        this.reconnectAttempts = 0;

        // Reset permanent failure flag if connection is successful
        if (this.isConnectionPermanentlyDown) {
          this.isConnectionPermanentlyDown = false;
        }

        this.rabbitEventEmitter.emit("connected");

        if (this.subscriptions.size > 0) {
          await this.resubscribeAll();
        }
      } catch (error: any) {
        this.connecting = false;
        this.rabbitEventEmitter.emit("error", error);

        this.log("error", `Connection error: ${error.message}`);

        // Use the handleReconnectError method for consistent retry handling
        this.handleReconnectError(error);
      }
    };

    // Start connection attempt
    await attemptConnection();
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

    if (!this.channel) {
      try {
        await this.connect();
      } catch (error) {
        this.log("error", `Failed to connect for message publishing: ${error}`);
        return false;
      }
    }

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
   * @param {string} topic - The topic to subscribe to.
   * @param {MessageHandler<T>} handler - The callback function to handle incoming messages.
   * @param {SubscriptionOptions} [options={ ackMode: 'manual' }] - Options for the subscription, including acknowledgment mode.
   * @returns {Promise<string>} A promise that resolves to a subscription ID.
   * @throws {Error} Throws an error if the subscription fails.
   */
  public async subscribe<T>(
    topic: string,
    handler: MessageHandler<T>,
    options: SubscriptionOptions & { ackMode: "auto" | "manual" } = {
      ackMode: "manual",
    }
  ): Promise<string> {
    try {
      // Generate a subscription ID
      const subscriptionId = uuidv4();

      // Store the subscription
      this.subscriptions.set(subscriptionId, {
        topic,
        handler: handler as MessageHandler,
        type: "standard",
        options,
      });

      // Try to set up the subscription if we're connected
      if (this.channel) {
        try {
          await this.setupSubscription(subscriptionId, topic, handler, options);
        } catch (error) {
          this.log("error", `Failed to setup subscription: ${error}`);
          // Don't throw, just log the error
        }
      } else {
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
          // Trigger connection attempt if not already connecting
          if (!this.connecting) {
            this.connect().catch((error) => {
              this.log("error", `Failed to initiate connection: ${error}`);
            });
          }
        }
      }

      return subscriptionId;
    } catch (error: any) {
      this.log(
        "error",
        `Failed to subscribe to topic ${topic}: ${error.message}`
      );
      throw new SubscriptionError(`Failed to subscribe: ${error.message}`);
    }
  }

  // New helper method to setup subscription
  private async setupSubscription<T>(
    subscriptionId: string,
    topic: string,
    handler: MessageHandler<T>,
    options: SubscriptionOptions & { ackMode: "auto" | "manual" }
  ): Promise<void> {
    if (!this.channel) return;

    const queueName = this.getQueueName(topic, options.queueName);

    // Use custom exchange name if provided, otherwise use the default
    const exchangeName = options.exchangeName || this.getExchangeName();

    // Set up queue with DLX if configured
    const queueOptions: amqplib.Options.AssertQueue = {
      exclusive: options.exclusive ?? !options.queueName,
      durable: options.durable ?? !!options.queueName,
      autoDelete: options.autoDelete ?? !options.queueName,
      arguments: {
        ...(options.arguments || {}),
      },
    };

    // Add DLX configuration if available
    if (this.config.deadLetterExchange) {
      // Determine the routing key for dead-lettered messages
      const deadLetterRoutingKey =
        this.config.deadLetterMessageRoutingKey || topic;

      queueOptions.arguments = {
        ...queueOptions.arguments,
        "x-dead-letter-exchange": this.config.deadLetterExchange,
        "x-dead-letter-routing-key": deadLetterRoutingKey,
      };
    }

    const { queue } = await this.channel.assertQueue(queueName, queueOptions);

    // Bind to the specified exchange (custom or default)
    await this.channel.bindQueue(queue, exchangeName, topic);

    // Create message handler with proper acknowledgment mode
    const messageHandler = this.createMessageHandler(
      subscriptionId,
      handler as MessageHandler,
      options.ackMode
    );

    // Set up consumer
    const { consumerTag } = await this.channel.consume(queue, messageHandler, {
      noAck: options.ackMode === "auto",
    });

    // Update subscription with consumer tag and queue name
    const subscription = this.subscriptions.get(subscriptionId);
    if (subscription) {
      subscription.consumerTag = consumerTag;
      subscription.queueName = queue;
    }
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
    options: SubscriptionOptions & {
      ackMode: "auto" | "manual";
      dlxRoutingKey?: string; // Add optional routing key
    } = {
      ackMode: "manual",
    }
  ): Promise<string> {
    const subscriptionId = uuidv4();

    if (!this.channel) {
      await this.connect();
    }

    if (!this.channel) {
      throw new SubscriptionError("Failed to establish connection to RabbitMQ");
    }

    try {
      // Create DLX exchange and queue with topic type
      await this.channel.assertExchange(dlxExchange, "topic", {
        durable: true,
      });
      await this.channel.assertQueue(dlxQueue, {
        durable: true,
        arguments: {
          ...(options.arguments || {}),
        },
      });

      // Use specific routing key if provided, otherwise use "#" as default
      const dlxRoutingKey = options.dlxRoutingKey || "#";

      // Use specific routing key pattern for DLX binding
      await this.channel.bindQueue(dlxQueue, dlxExchange, dlxRoutingKey);

      // Create main queue with DLX settings
      const queueName = this.getQueueName(topic, options.queueName);

      const { queue: queueCreated } = await this.channel.assertQueue(
        queueName,
        {
          exclusive: options.exclusive ?? !options.queueName,
          durable: options.durable ?? !!options.queueName,
          autoDelete: options.autoDelete ?? !options.queueName,
          arguments: {
            "x-dead-letter-exchange": dlxExchange,
            "x-dead-letter-routing-key": dlxRoutingKey, // Use proper routing key format
            ...(options.arguments || {}),
          },
        }
      );

      // Use custom exchange name if provided, otherwise use the default
      const exchangeName = options.exchangeName || this.getExchangeName();

      await this.channel.bindQueue(queueCreated, exchangeName, topic);

      // Start consuming messages
      const { consumerTag } = await this.channel.consume(
        queueCreated,
        this.createMessageHandler(subscriptionId, handler, options.ackMode),
        { noAck: options.ackMode === "auto" }
      );

      // Store the subscription
      this.subscriptions.set(subscriptionId, {
        topic,
        handler: handler as MessageHandler,
        consumerTag,
        queueName: queueCreated,
        type: "dlx",
        dlxExchange,
        dlxQueue,
        options,
      });

      return subscriptionId;
    } catch (error: any) {
      throw new SubscriptionError(
        `Failed to subscribe to topic ${topic}: ${error.message}`
      );
    }
  }

  /**
   * Unsubscribe from a previously subscribed topic.
   * @param subscriptionId - The ID of the subscription to unsubscribe from
   * @throws {SubscriptionError} If the subscription ID is invalid or unsubscribing fails
   */
  public async unsubscribe(subscriptionId: string): Promise<void> {
    if (!this.channel) {
      return;
    }

    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription || !subscription.consumerTag) {
      return;
    }

    try {
      await this.channel.cancel(subscription.consumerTag);
      this.subscriptions.delete(subscriptionId);
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
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
    this.reconnecting = false;
    this.reconnectAttempts = 0;

    if (this.channel) {
      try {
        await this.channel.close();
      } catch (error) {
        console.error("Error closing channel:", error);
      }
      this.channel = null;
    }

    if (this.connection) {
      try {
        await this.connection.close();
      } catch (error) {
        this.log("error", `Error closing connection: ${error}`);
      }
      this.connection = null;
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

    // Stop connection monitor
    if (this.connectionMonitorInterval) {
      clearInterval(this.connectionMonitorInterval);
      this.connectionMonitorInterval = undefined;
    }

    // Mark the client as permanently down to prevent reconnection attempts
    this.isConnectionPermanentlyDown = true;

    // Clear any pending reconnection timeouts
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }

    // No active connection, nothing to clean up
    if (!this.connection || !this.channel) {
      this.log("info", "No active connection to close");
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

    try {
      if (this.channel) {
        await this.channel.close();
      }
      if (this.connection) {
        await this.connection.close();
      }
    } catch (error) {
      this.handleError(
        error instanceof Error ? error : new Error(String(error)),
        "Error during graceful shutdown"
      );
    } finally {
      this.channel = null;
      this.connection = null;
    }
  }

  private inProgressMessages = 0;

  /**
   * Creates a message handler for a subscription.
   *
   * @param subscriptionId - The ID of the subscription.
   * @param handler - The callback function to handle incoming messages.
   * @param ackMode - The acknowledgment mode for the subscription. If set to "auto",
   *                 the message is acknowledged automatically after the handler
   *                 completes. If set to "manual", the message is not acknowledged
   *                 until the handler explicitly acknowledges it.
   * @returns A function that processes incoming messages and handles errors.
   */
  private createMessageHandler<T>(
    subscriptionId: string,
    handler: MessageHandler<T>,
    ackMode: "auto" | "manual"
  ) {
    return async (msg: amqplib.ConsumeMessage | null) => {
      if (!msg || !this.channel) {
        return;
      }

      this.inProgressMessages++;
      try {
        const content = JSON.parse(msg.content.toString());

        const message: Message<T> = {
          content,
          routingKey: msg.fields.routingKey,
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
          ack: async () => {
            if (ackMode === "manual" && this.channel) {
              await this.channel.ack(msg);
            }
          },
          nack: async (requeue: boolean = true) => {
            if (ackMode === "manual" && this.channel) {
              await this.channel.nack(msg, false, requeue);
            }
          },
          reject: async (requeue: boolean = false) => {
            if (ackMode === "manual" && this.channel) {
              await this.channel.reject(msg, requeue);
            }
          },
        };

        // Execute the handler
        await Promise.resolve(handler(message));

        // Acknowledge the message
        if (ackMode === "auto" && this.channel) {
          this.channel.ack(msg); // Manually acknowledge the message
        }
      } catch (error: any) {
        this.handleError(error as Error, "Error processing message");
        // Reject the message and requeue it
        if (ackMode === "manual" && this.channel) {
          if (this.config.deadLetterExchange) {
            try {
              // Clone the message with error details
              const errorMsg = Buffer.from(msg.content);
              const errorHeaders = { ...(msg.properties.headers || {}) };

              // Add error details to headers
              errorHeaders["x-error"] = error.message;
              errorHeaders["x-error-stack"] = error.stack;
              errorHeaders["x-original-routing-key"] = msg.fields.routingKey;
              errorHeaders["x-failed-at"] = new Date().toISOString();

              // Publish directly to DLX with updated headers
              await this.channel.publish(
                this.config.deadLetterExchange,
                msg.fields.routingKey,
                errorMsg,
                {
                  ...msg.properties,
                  headers: errorHeaders,
                }
              );

              // Acknowledge the original message
              await this.channel.ack(msg);
            } catch (publishError) {
              // If direct publishing fails, fall back to reject
              this.channel.reject(msg, false);
            }
          } else {
            // No DLX, use regular nack
            this.channel.nack(msg, false, true);
          }
        }
      } finally {
        this.inProgressMessages--;
      }
    };
  }

  private handleConnectionError(error: Error): void {
    this.log("error", `RabbitMQ connection error: ${error.message}`);
    this.rabbitEventEmitter.emit("error", error);

    // Clear any existing reconnection timeout
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    // Use the new reconnect error handler
    this.handleReconnectError(error);
  }

  private handleConnectionClose(): void {
    if (this.connection) {
      this.log("info", "RabbitMQ connection closed");
      this.rabbitEventEmitter.emit("disconnected");
      this.connection = null;
      this.channel = null;

      // Clear any existing reconnection timeout
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
      }

      // Use the handleReconnectError if not caused by a graceful shutdown
      if (!this.isConnectionPermanentlyDown) {
        const error = new Error("Connection closed unexpectedly");
        this.handleReconnectError(error);
      }
    }
  }

  private reconnecting = false;

  private scheduleReconnect(): void {
    if (this.reconnecting || this.connection) return;

    this.reconnecting = true;

    // Reset connection state
    this.connection = null;
    this.channel = null;

    // Start new connection attempt
    this.connect();
    this.reconnecting = false;
  }

  private async resubscribeAll(): Promise<void> {
    const subscriptions = Array.from(this.subscriptions.entries());

    // Clear existing subscriptions since we'll recreate them
    this.subscriptions.clear();

    for (const [id, sub] of subscriptions) {
      try {
        if (sub.type === "dlx" && sub.dlxExchange && sub.dlxQueue) {
          await this.subscribeWithDLX(
            sub.topic,
            sub.handler,
            sub.dlxExchange,
            sub.dlxQueue,
            sub.options as SubscriptionOptions & { ackMode: "auto" | "manual" }
          );
        } else if (sub.type === "fanout" && sub.queueName) {
          await this.subscribeToFanout(
            sub.topic,
            sub.handler,
            sub.queueName,
            sub.options as SubscriptionOptions & { ackMode: "auto" | "manual" }
          );
        } else {
          await this.subscribe(
            sub.topic,
            sub.handler,
            sub.options as SubscriptionOptions & { ackMode: "auto" | "manual" }
          );
        }
      } catch (error) {
        this.log("error", `Failed to resubscribe to ${sub.topic}: ${error}`);
      }
    }
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
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      if (!this.isConnectionPermanentlyDown) {
        this.isConnectionPermanentlyDown = true;
        this.log(
          "error",
          "Max reconnect attempts reached. RabbitMQ connection is offline. Server remains operational."
        );
        this.rabbitEventEmitter.emit("connection_permanently_down");
      }
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      this.reconnectBaseDelay * Math.pow(2, this.reconnectAttempts),
      30000 // 30s max delay
    );

    this.log(
      "warn",
      `Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${
        this.maxReconnectAttempts
      })`
    );

    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.reconnectTimeout = setTimeout(() => {
      this.connect();
    }, delay);
  }
}

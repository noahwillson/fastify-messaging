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
  private connection: amqplib.Connection | null = null;
  private channel: amqplib.Channel | null = null;
  private connecting = false;
  private subscriptions: Map<
    string,
    {
      topic: string;
      handler: MessageHandler;
      consumerTag?: string;
      queueName?: string;
    }
  > = new Map();
  private reconnectCallback: (() => void) | null = null;
  private rabbitEventEmitter = new EventEmitter();
  private logLevel: "info" | "warn" | "error" = "info";

  constructor(private rabbitConfig: RabbitMQConfig) {
    super(rabbitConfig);
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
   * Handles errors that occur during message processing.
   * @param {Error} error - The error that occurred.
   * @param {string} context - Additional context about where the error occurred.
   */
  public handleError(error: Error, context: string): void {
    this.log("error", `${context}: ${error.message}`);
    this.rabbitEventEmitter.emit("error", error);
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
    const { queue } = await this.channel.assertQueue(queueName, {
      exclusive: false,
      durable: true,
      autoDelete: false,
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
    const queue = await this.createDynamicQueue(eventType, queueName);

    // Start consuming messages
    const { consumerTag } = await this.channel!.consume(
      queue,
      this.createMessageHandler(eventType, handler, options.ackMode),
      { noAck: options.ackMode === "auto" }
    );

    return consumerTag;
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

    try {
      this.connecting = true;

      // Use the correct connect method
      const conn = await amqplib.connect(this.rabbitConfig.url);
      this.connection = conn;

      // Create channel
      const ch = await conn.createChannel();
      this.channel = ch;

      // Set prefetch count
      await ch.prefetch(this.rabbitConfig.prefetch || 10);

      // Create exchange
      await ch.assertExchange(
        this.rabbitConfig.exchange,
        this.rabbitConfig.exchangeType || "topic",
        { durable: true, ...this.rabbitConfig.exchangeOptions }
      );

      // Setup connection event handlers
      conn.on("error", this.handleConnectionError.bind(this));
      conn.on("close", this.handleConnectionClose.bind(this));

      this.connecting = false;
      this.rabbitEventEmitter.emit("connected");

      // Resubscribe to events if reconnecting
      if (this.subscriptions.size > 0) {
        await this.resubscribeAll();
      }
    } catch (error: any) {
      this.connecting = false;
      console.error("Failed to connect to RabbitMQ:", error);
      this.scheduleReconnect();
      throw new ConnectionError(
        `Failed to connect to RabbitMQ: ${error.message}`
      );
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
    if (!this.channel) {
      await this.connect();
    }

    if (!this.channel) {
      throw new PublishError("Failed to establish connection to RabbitMQ");
    }

    try {
      const exchangeName = this.getExchangeName(eventType);
      const content = Buffer.from(JSON.stringify(message));

      return this.channel.publish(exchangeName, topic, content, {
        persistent: true,
        contentType: "application/json",
        expiration: options.ttl?.toString(), //set TTL
        priority: options.priority,
        ...options,
      });
    } catch (error: any) {
      throw new PublishError(`Failed to publish message: ${error.message}`);
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
    if (!this.channel) {
      await this.connect();
    }

    if (!this.channel) {
      throw new SubscriptionError("Failed to establish connection to RabbitMQ");
    }

    try {
      // Generate a subscription ID
      const subscriptionId = uuidv4();

      // Create a queue
      const queueName = this.getQueueName(topic, options.queueName);

      // Create a queue
      const { queue: queueCreated } = await this.channel.assertQueue(
        queueName,
        {
          exclusive: options.exclusive ?? !options.queueName,
          durable: options.durable ?? !!options.queueName,
          autoDelete: options.autoDelete ?? !options.queueName,
          arguments: options.arguments,
        }
      );

      // Bind the queue to the exchange with the topic
      await this.channel.bindQueue(
        queueCreated,
        this.rabbitConfig.exchange,
        topic
      );

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
      });

      return subscriptionId;
    } catch (error: any) {
      throw new SubscriptionError(
        `Failed to subscribe to topic ${topic}: ${error.message}`
      );
    }
  }

  public async subscribeWithDLX<T>(
    topic: string,
    handler: MessageHandler<T>,
    dlxExchange: string,
    dlxQueue: string,
    options: SubscriptionOptions & { ackMode: "auto" | "manual" } = {
      ackMode: "manual",
    }
  ): Promise<string> {
    if (!this.channel) {
      await this.connect();
    }

    if (!this.channel) {
      throw new SubscriptionError("Failed to establish connection to RabbitMQ");
    }

    try {
      // Create DLX exchange and queue
      await this.channel.assertExchange(dlxExchange, "fanout", {
        durable: true,
      });
      await this.channel.assertQueue(dlxQueue, { durable: true });
      await this.channel.bindQueue(dlxQueue, dlxExchange, "");

      // Create main queue with DLX settings
      const queueName = this.getQueueName(topic, options.queueName);

      const { queue: queueCreated } = await this.channel.assertQueue(
        queueName,
        {
          exclusive: options.exclusive ?? !options.queueName,
          durable: options.durable ?? !!options.queueName,
          autoDelete: options.autoDelete ?? !options.queueName,
          arguments: {
            "x-dead-letter-exchange": dlxExchange, // Route failed messages to DLX
          },
        }
      );

      // Bind the queue to the exchange with the topic
      await this.channel.bindQueue(
        queueCreated,
        this.rabbitConfig.exchange,
        topic
      );

      // Start consuming messages
      const { consumerTag } = await this.channel.consume(
        queueCreated,
        this.createMessageHandler(uuidv4(), handler, options.ackMode),
        { noAck: options.ackMode === "auto" }
      );

      // Store the subscription
      this.subscriptions.set(consumerTag, {
        topic,
        handler: handler as MessageHandler,
        consumerTag,
        queueName: queueCreated,
      });

      return consumerTag;
    } catch (error: any) {
      throw new SubscriptionError(
        `Failed to subscribe to topic ${topic}: ${error.message}`
      );
    }
  }

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

  public async close(): Promise<void> {
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

  public async gracefulShutdown(timeout: number = 5000): Promise<void> {
    this.log("info", "Shutting down gracefully...");

    const waitForMessages = new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        this.log("info", `In-progress messages: ${this.inProgressMessages}`);
        if (this.inProgressMessages === 0) {
          clearInterval(interval);
          resolve();
        }
      }, 100);
    });

    await Promise.race([
      waitForMessages,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Shutdown timeout")), timeout)
      ),
    ]);

    if (this.channel) {
      await this.channel.close();
      this.channel = null;
    }

    if (this.connection) {
      await this.connection.close();
      this.connection = null;
    }
  }

  private inProgressMessages = 0;

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
        };

        // Execute the handler
        await Promise.resolve(handler(message));

        // Acknowledge the message
        if (ackMode === "manual") {
          this.channel.ack(msg); // Manually acknowledge the message
        }
      } catch (error: any) {
        this.handleError(error, "Error processing message");
        // Reject the message and requeue it
        if (ackMode === "manual") {
          this.channel.nack(msg, false, true); // Requeue the message
        }
      } finally {
        this.inProgressMessages--;
      }
    };
  }

  private handleConnectionError(error: Error): void {
    this.log("error", `RabbitMQ connection error: ${error.message}`);
    this.rabbitEventEmitter.emit("error", error);
    this.scheduleReconnect();
  }

  private handleConnectionClose(): void {
    if (this.connection) {
      this.log("info", "RabbitMQ connection closed");
      this.rabbitEventEmitter.emit("disconnected");
      this.connection = null;
      this.channel = null;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    setTimeout(async () => {
      this.log("info", "Attempting to reconnect to RabbitMQ...");
      try {
        await this.connect();
        if (this.reconnectCallback) {
          this.reconnectCallback(); // Call the reconnect callback
        }
        this.rabbitEventEmitter.emit("reconnected");
      } catch (error) {
        this.log("error", `Failed to reconnect to RabbitMQ: ${error}`);
        this.scheduleReconnect(); // Retry reconnection
      }
    }, this.config.reconnectInterval);
  }

  private async resubscribeAll(): Promise<void> {
    const subscriptions = Array.from(this.subscriptions.entries());

    // Clear existing subscriptions since we'll recreate them
    this.subscriptions.clear();

    for (const [id, { topic, handler, queueName }] of subscriptions) {
      try {
        // Resubscribe with the same handler and queue name if available
        await this.subscribe(topic, handler, {
          queueName,
          durable: !!queueName,
          autoDelete: !queueName,
          ackMode: "manual",
        });
      } catch (error) {
        this.log("error", `Failed to resubscribe to ${topic}: ${error}`);
      }
    }
  }
}

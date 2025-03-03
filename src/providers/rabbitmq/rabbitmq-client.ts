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
import { RabbitMQConfig } from "./types";

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

  constructor(private rabbitConfig: RabbitMQConfig) {
    super(rabbitConfig);
  }

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
        { durable: true }
      );

      // Setup connection event handlers
      conn.on("error", this.handleConnectionError.bind(this));
      conn.on("close", this.handleConnectionClose.bind(this));

      this.connecting = false;

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

  public async publish<T>(
    topic: string,
    message: T,
    options: MessageOptions = {}
  ): Promise<boolean> {
    if (!this.channel) {
      await this.connect();
    }

    if (!this.channel) {
      throw new PublishError("Failed to establish connection to RabbitMQ");
    }

    try {
      const content = Buffer.from(JSON.stringify(message));

      return this.channel.publish(this.rabbitConfig.exchange, topic, content, {
        persistent: true,
        contentType: "application/json",
        ...options,
      });
    } catch (error: any) {
      throw new PublishError(`Failed to publish message: ${error.message}`);
    }
  }

  public async subscribe<T>(
    topic: string,
    handler: MessageHandler<T>,
    options: SubscriptionOptions = {}
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
      const queueName = options.queueName || "";
      const { queue: queueCreated } = await this.channel.assertQueue(
        queueName,
        {
          exclusive: options.exclusive ?? !options.queueName,
          durable: options.durable ?? !!options.queueName,
          autoDelete: options.autoDelete ?? !options.queueName,
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
        this.createMessageHandler(subscriptionId, handler),
        { noAck: false }
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
        console.error("Error closing connection:", error);
      }
      this.connection = null;
    }
  }

  private createMessageHandler<T>(
    subscriptionId: string,
    handler: MessageHandler<T>
  ) {
    return async (msg: amqplib.ConsumeMessage | null) => {
      if (!msg || !this.channel) {
        return;
      }

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
        this.channel.ack(msg);
      } catch (error) {
        console.error(`Error processing message: ${error}`);

        // Reject the message and requeue it
        if (this.channel) {
          this.channel.nack(msg, false, true);
        }
      }
    };
  }

  private handleConnectionError(error: Error): void {
    console.error("RabbitMQ connection error:", error);
    this.scheduleReconnect();
  }

  private handleConnectionClose(): void {
    if (this.connection) {
      console.log("RabbitMQ connection closed");
      this.connection = null;
      this.channel = null;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    setTimeout(() => {
      console.log("Attempting to reconnect to RabbitMQ...");
      this.connect().catch((error) => {
        console.error("Failed to reconnect to RabbitMQ:", error);
      });
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
        });
      } catch (error) {
        console.error(`Failed to resubscribe to ${topic}:`, error);
      }
    }
  }
}

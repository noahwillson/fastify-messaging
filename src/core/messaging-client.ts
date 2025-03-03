// src/core/messaging-client.ts
import {
  Message,
  MessageHandler,
  MessageOptions,
  MessagingConfig,
  SubscriptionOptions,
} from "./types";

export abstract class MessagingClient {
  protected config: MessagingConfig;

  constructor(config: MessagingConfig) {
    this.config = {
      reconnectInterval: 5000,
      ...config,
    };
  }

  /**
   * Connect to the messaging system
   */
  public abstract connect(): Promise<void>;

  /**
   * Publish a message to the messaging system
   */
  public abstract publish<T>(
    topic: string,
    message: T,
    options?: MessageOptions
  ): Promise<boolean>;

  /**
   * Subscribe to messages from the messaging system
   */
  public abstract subscribe<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscriptionOptions
  ): Promise<string>; // Returns subscription ID

  /**
   * Unsubscribe from messages
   */
  public abstract unsubscribe(subscriptionId: string): Promise<void>;

  /**
   * Close the connection to the messaging system
   */
  public abstract close(): Promise<void>;
}

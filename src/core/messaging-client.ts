// src/core/messaging-client.ts
import {
  Message,
  MessageHandler,
  MessageOptions,
  MessagingConfig,
  SubscriptionOptions,
} from "./types";

import { EventEmitter } from "events";

/**
 * Abstract class that defines the interface for a messaging client.
 * This class provides a blueprint for implementing specific messaging systems (e.g., RabbitMQ, Kafka, Redis).
 */
export abstract class MessagingClient {
  protected config: MessagingConfig;
  private eventEmitter = new EventEmitter();
  protected connection: any | null = null;

  constructor(config: MessagingConfig) {
    this.config = {
      reconnectInterval: 5000,
      ...config,
    };
  }

  /**
   * Listen for lifecycle events
   * @param event - The event to listen for ("connected", "disconnected", "reconnected", "error")
   * @param listener - The callback function to execute when the event is emitted
   */
  public on(
    event: "connected" | "disconnected" | "reconnected" | "error",
    listener: (...args: any[]) => void
  ): void {
    this.eventEmitter.on(event, listener);
  }

  /**
   * Check if the client is currently connected to the messaging system.
   * @returns {boolean} True if the client is connected, false otherwise.
   */
  public isConnected(): boolean {
    return this.connection !== null;
  }

  /**
   * Emit lifecycle events
   * @param event - The event to emit ("connected", "disconnected", "reconnected", "error")
   * @param args - Additional arguments to pass to the event listener
   */
  protected emit(
    event: "connected" | "disconnected" | "reconnected" | "error",
    ...args: any[]
  ): void {
    this.eventEmitter.emit(event, ...args);
  }

  /**
   * Connect to the messaging system
   */
  public abstract connect(): Promise<void>;

  /**
   * Publish a message to the messaging system
   * @param topic - The topic or routing key to publish the message to
   * @param message - The message to publish
   * @param options - Additional options for the message (e.g., TTL, priority)
   */
  public abstract publish<T>(
    topic: string,
    message: T,
    options?: MessageOptions
  ): Promise<boolean>;

  /**
   * Publish a message to a fanout exchange.
   * @param eventType - The name of the fanout exchange to publish to
   * @param message - The message to be published
   * @param options - Additional options for the message (e.g., TTL, priority)
   * @returns A promise that resolves to a boolean indicating if the message was successfully published
   */

  public abstract publishToFanout<T>(
    eventType: string,
    message: T,
    options?: MessageOptions
  ): Promise<boolean>;

  /**
   * Subscribe to messages from the messaging system
   * @param topic - The topic or routing key to subscribe to
   * @param handler - The callback function to process incoming messages
   * @param options - Additional options for the subscription (e.g., queue name, acknowledgment mode)
   */
  public abstract subscribe<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscriptionOptions
  ): Promise<string>; // Returns subscription ID

  /**
   * Subscribe to messages from a fanout exchange
   * @param eventType - The name of the fanout exchange
   * @param handler - The callback function to process incoming messages
   * @param queueName - The name of the queue to subscribe to
   * @param options - Additional options for the subscription (e.g., acknowledgment mode)
   */
  public abstract subscribeToFanout<T>(
    eventType: string,
    handler: MessageHandler<T>,
    queueName: string,
    options?: SubscriptionOptions
  ): Promise<string>;

  /**
   * Subscribe to messages from a dead letter exchange (DLX).
   * The messages will be re-routed to the specified DLX exchange and queue.
   * @param topic - The topic or routing key to subscribe to
   * @param handler - The callback function to process incoming messages
   * @param dlxExchange - The name of the dead letter exchange
   * @param dlxQueue - The name of the dead letter queue
   * @param options - Additional options for the subscription (e.g., acknowledgment mode)
   */
  public abstract subscribeWithDLX<T>(
    topic: string,
    handler: MessageHandler<T>,
    dlxExchange: string,
    dlxQueue: string,
    options?: SubscriptionOptions
  ): Promise<string>;

  /**
   * Set a callback function to be executed when the messaging client reconnects to the underlying messaging system.
   * @param callback - The callback function to execute when the client reconnects
   */
  public abstract onReconnect(callback: () => void): void;

  /**
   * Unsubscribe from messages
   * @param subscriptionId - The ID of the subscription to unsubscribe from
   */
  public abstract unsubscribe(subscriptionId: string): Promise<void>;

  /**
   * Close the connection to the messaging system
   */
  public abstract close(): Promise<void>;

  /**
   * Gracefully shut down the messaging client
   * @param timeout - The maximum time to wait for in-progress messages to complete
   */
  public abstract gracefulShutdown(timeout?: number): Promise<void>;

  /**
   * Handle errors in a consistent way
   * @param error - The error to handle
   * @param context - Additional context about where the error occurred
   */
  protected handleError(error: Error, context: string): void {
    console.error(`[MessagingClient] ${context}: ${error.message}`);
    this.emit("error", error);
  }
}

import { ConnectionError } from "./errors";
import { MessagingClient } from "./messaging-client";
import {
  MessageHandler,
  MessageOptions,
  MessagingLogger,
  SubscriptionOptions,
} from "./types";

/** The messaging API that framework adapters expose (fastify.messaging, req.messaging). */
export interface Messaging {
  client: MessagingClient;
  isConnected(): boolean;
  getConnectionStatus(): ReturnType<MessagingClient["getConnectionStatus"]>;
  publish<T>(topic: string, message: T, options?: MessageOptions): Promise<boolean>;
  publishToFanout<T>(
    eventType: string,
    message: T,
    options?: MessageOptions
  ): Promise<boolean>;
  subscribe<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscriptionOptions
  ): Promise<string>;
  subscribeToFanout<T>(
    eventType: string,
    handler: MessageHandler<T>,
    queueName: string,
    options?: SubscriptionOptions
  ): Promise<string>;
  subscribeWithDLX<T>(
    topic: string,
    handler: MessageHandler<T>,
    dlxExchange: string,
    dlxQueue: string,
    options?: SubscriptionOptions
  ): Promise<string>;
  unsubscribe(subscriptionId: string): Promise<void>;
  onReconnect(callback: () => void): void;
}

export function createMessaging(client: MessagingClient): Messaging {
  return {
    client,
    isConnected: () => client.isConnected(),
    getConnectionStatus: () => client.getConnectionStatus(),
    publish: client.publish.bind(client),
    publishToFanout: client.publishToFanout.bind(client),
    subscribe: client.subscribe.bind(client),
    subscribeToFanout: client.subscribeToFanout.bind(client),
    subscribeWithDLX: client.subscribeWithDLX.bind(client),
    unsubscribe: client.unsubscribe.bind(client),
    onReconnect: client.onReconnect.bind(client),
  };
}

export interface StartOptions {
  /** Throw (and stop reconnecting) if the broker is unreachable. Default false. */
  requireConnection?: boolean;
  /** Logger for the client, used only if it does not have one already. */
  logger?: MessagingLogger;
}

/** Shared startup for framework adapters: wire the logger, connect, optionally fail fast. */
export async function startClient(
  client: MessagingClient,
  { requireConnection = false, logger }: StartOptions
): Promise<void> {
  if (logger && !client.getLogger()) {
    client.setLogger(logger);
  }

  // Never rejects: on failure the client schedules reconnects in the background.
  await client.connect();

  if (requireConnection && !client.isConnected()) {
    // Stop the background reconnects, or they would keep the process alive after startup failed.
    await client.close();
    throw new ConnectionError(
      "Could not connect to the message broker (requireConnection is set)"
    );
  }
}

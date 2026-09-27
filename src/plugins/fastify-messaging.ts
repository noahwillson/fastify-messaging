import { FastifyPluginAsync, FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { MessagingClient } from "../core/messaging-client";
import { ConnectionError } from "../core/errors";
import {
  MessageHandler,
  MessageOptions,
  SubscriptionOptions,
} from "../core/types";

export interface FastifyMessagingOptions {
  client: MessagingClient;
  /**
   * Fail plugin registration (and so `app.ready()` / `listen()`) when the broker is
   * unreachable at startup. Default false: the app boots and the client keeps reconnecting
   * in the background.
   */
  requireConnection?: boolean;
  /**
   * Route client logs to `fastify.log` unless the client already has a logger.
   * Default true.
   */
  useFastifyLogger?: boolean;
  /** Max ms to wait for in-flight messages when the app closes. Default 5000. */
  shutdownTimeout?: number;
}

export interface FastifyMessaging {
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

declare module "fastify" {
  interface FastifyInstance {
    messaging: FastifyMessaging;
  }
}

/**
 * Fastify plugin for integrating RabbitMQ messaging capabilities.
 * @param {FastifyInstance} fastify - The Fastify instance.
 * @param {FastifyMessagingOptions} options - Options for the plugin, including the messaging client.
 */
const fastifyMessaging: FastifyPluginAsync<FastifyMessagingOptions> = async (
  fastify: FastifyInstance,
  options: FastifyMessagingOptions
) => {
  const { client, requireConnection = false, useFastifyLogger = true } = options;

  if (useFastifyLogger && !client.getLogger()) {
    client.setLogger(fastify.log.child({ plugin: "fastify-messaging" }));
  }

  // Never rejects: on failure the client schedules reconnects in the background.
  await client.connect();

  if (requireConnection && !client.isConnected()) {
    // Stop the background reconnects, or they would keep the process alive after boot failed.
    await client.close();
    throw new ConnectionError(
      "fastify-messaging: could not connect to the message broker (requireConnection is set)"
    );
  }

  const messaging: FastifyMessaging = {
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
  fastify.decorate("messaging", messaging);

  // Close connection when Fastify closes
  fastify.addHook("onClose", async () => {
    await client.gracefulShutdown(options.shutdownTimeout);
  });
};

export default fp(fastifyMessaging, {
  name: "fastify-messaging",
  fastify: "4.x || 5.x",
});

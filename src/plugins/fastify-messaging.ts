import { FastifyPluginAsync, FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { MessagingClient } from "../core/messaging-client";
import { createMessaging, Messaging, startClient } from "../core/messaging";

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

/** `fastify.messaging`; the same API the Express adapter exposes. */
export interface FastifyMessaging extends Messaging {}

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
  const { client, requireConnection, useFastifyLogger = true } = options;

  await startClient(client, {
    requireConnection,
    logger: useFastifyLogger
      ? fastify.log.child({ plugin: "fastify-messaging" })
      : undefined,
  });

  fastify.decorate("messaging", createMessaging(client));

  // Close connection when Fastify closes
  fastify.addHook("onClose", async () => {
    await client.gracefulShutdown(options.shutdownTimeout);
  });
};

export default fp(fastifyMessaging, {
  name: "fastify-messaging",
  fastify: "4.x || 5.x",
});

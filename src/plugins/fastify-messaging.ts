import { FastifyPluginAsync, FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { MessagingClient } from "../core/messaging-client";
import {
  MessageHandler,
  MessageOptions,
  SubscriptionOptions,
} from "../core/types";

interface FastifyMessagingOptions {
  client: MessagingClient;
}

declare module "fastify" {
  interface FastifyInstance {
    messaging: {
      client: MessagingClient;
      publish<T>(
        topic: string,
        message: T,
        options?: MessageOptions
      ): Promise<boolean>;
      subscribe<T>(
        topic: string,
        handler: MessageHandler<T>,
        options?: SubscriptionOptions
      ): Promise<string>;
      unsubscribe(subscriptionId: string): Promise<void>;
    };
  }
}

const fastifyMessaging: FastifyPluginAsync<FastifyMessagingOptions> = async (
  fastify: FastifyInstance,
  options: FastifyMessagingOptions
) => {
  const { client } = options;

  // Connect to messaging system
  await client.connect();

  // Add client to Fastify instance
  fastify.decorate("messaging", {
    client,
    publish: client.publish.bind(client),
    subscribe: client.subscribe.bind(client),
    unsubscribe: client.unsubscribe.bind(client),
  });

  // Close connection when Fastify closes
  fastify.addHook("onClose", async () => {
    await client.close();
  });
};

export default fp(fastifyMessaging, {
  name: "fastify-messaging",
  fastify: "4.x",
});

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
    publishToFanout: client.publishToFanout.bind(client),
    subscribe: client.subscribe.bind(client),
    subscribeToFanout: client.subscribeToFanout.bind(client),
    subscribeWithDLX: client.subscribeWithDLX.bind(client),
    unsubscribe: client.unsubscribe.bind(client),
    onReconnect: client.onReconnect.bind(client),
  });

  // Close connection when Fastify closes
  fastify.addHook("onClose", async () => {
    await client.gracefulShutdown();
  });
};

export default fp(fastifyMessaging, {
  name: "fastify-messaging",
  fastify: "4.x",
});

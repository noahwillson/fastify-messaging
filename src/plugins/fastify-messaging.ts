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

/**
 * Fastify plugin for integrating RabbitMQ messaging capabilities.
 * @param {FastifyInstance} fastify - The Fastify instance.
 * @param {FastifyMessagingOptions} options - Options for the plugin, including the messaging client.
 */
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
    /**
     * Publishes a message to a specified topic.
     * @param {string} topic - The topic to which the message will be published.
     * @param {T} message - The message to publish.
     * @param {MessageOptions} [options={}] - Additional options for the message (e.g., TTL, priority).
     * @returns {Promise<boolean>} A promise that resolves to true if the message was published successfully, otherwise false.
     * @throws {Error} Throws an error if the publishing fails.
     */
    publish: client.publish.bind(client),
    /**
     * Publishes a message to a fanout exchange.
     * @param {string} eventType - The event type for categorizing the message.
     * @param {T} message - The message to publish.
     * @param {MessageOptions} [options={}] - Additional options for the message.
     * @returns {Promise<boolean>} A promise that resolves to true if the message was published successfully, otherwise false.
     * @throws {Error} Throws an error if the publishing fails.
     */
    publishToFanout: client.publishToFanout.bind(client),
    /**
     * Subscribes to a specified topic.
     * @param {string} topic - The topic to subscribe to.
     * @param {MessageHandler<T>} handler - The callback function to handle incoming messages.
     * @param {SubscriptionOptions} [options={}] - Options for the subscription, including acknowledgment mode.
     * @returns {Promise<string>} A promise that resolves to a subscription ID.
     * @throws {Error} Throws an error if the subscription fails.
     */
    subscribe: client.subscribe.bind(client),
    /**
     * Subscribes to a fanout exchange.
     * @param {string} eventType - The event type for categorizing the message.
     * @param {MessageHandler<T>} handler - The callback function to handle incoming messages.
     * @param {string} queueName - The name of the queue to subscribe to.
     * @param {SubscriptionOptions} [options={}] - Options for the subscription, including acknowledgment mode.
     * @returns {Promise<string>} A promise that resolves to a subscription ID.
     * @throws {Error} Throws an error if the subscription fails.
     */
    subscribeToFanout: client.subscribeToFanout.bind(client),
      /**
     * Subscribes with a Dead Letter Exchange (DLX).
     * @param {string} topic - The topic to subscribe to.
     * @param {MessageHandler<T>} handler - The callback function to handle incoming messages.
     * @param {string} dlxExchange - The Dead Letter Exchange name.
     * @param {string} dlxQueue - The Dead Letter Queue name.
     * @param {SubscriptionOptions} [options={}] - Options for the subscription, including acknowledgment mode.
     * @returns {Promise<string>} A promise that resolves to a subscription ID.
     * @throws {Error} Throws an error if the subscription fails.
     */
    subscribeWithDLX: client.subscribeWithDLX.bind(client),
    /**
     * Unsubscribes from a topic.
     * @param {string} subscriptionId - The ID of the subscription to unsubscribe from.
     * @returns {Promise<void>} A promise that resolves when the unsubscription is complete.
     * @throws {Error} Throws an error if the unsubscription fails.
     */
    unsubscribe: client.unsubscribe.bind(client),
    /**
     * Sets a callback function for reconnection events.
     * @param {() => void} callback - The callback function to execute when a reconnection occurs.
     */
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

// examples/consumer-service.ts
import Fastify from "fastify";
import { RabbitMQClient } from "../src/providers/rabbitmq/rabbitmq-client";
import { fastifyMessaging } from "../src";

interface OrderCreatedEvent {
  id: string;
  customerId: string;
  amount: number;
  timestamp: string;
}

async function start() {
  const fastify = Fastify({
    logger: true,
  });

  // Create a RabbitMQ client
  const messagingClient = new RabbitMQClient({
    url: process.env.RABBITMQ_URL || "amqp://localhost",
    exchange: "events",
    exchangeType: "topic",
  });

  // Register the messaging plugin
  await fastify.register(fastifyMessaging, {
    client: messagingClient,
  });

  // Subscribe to events
  const subscriptionId = await fastify.messaging.subscribe<OrderCreatedEvent>(
    "order.created",
    async (message) => {
      fastify.log.info(`Order created: ${message.content.id}`);
      // Process the order...
    },
    {
      queueName: "order-service-queue", // Optional: named queue for persistent subscriptions
      durable: true,
    }
  );

  fastify.log.info(
    `Subscribed to order.created events with ID: ${subscriptionId}`
  );

  await fastify.listen({ port: 3003, host: "0.0.0.0" });
}

start().catch((err) => {
  console.error("Error starting server:", err);
  process.exit(1);
});

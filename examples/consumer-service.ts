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

interface UserCreatedEvent {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

async function start() {
  const fastify = Fastify({
    logger: true,
  });

  // Create a RabbitMQ client
  const messagingClient = new RabbitMQClient({
    url: process.env.RABBITMQ_URL || "amqp://localhost",
    exchange: "ex.example",
    exchangeType: "topic",
    prefetch: 10,
    heartbeat: 60,
    deadLetterExchange: "dlx.example",
    deadLetterQueue: "dlq.example",
    getQueueName: (eventType, queueName) => {
      if (queueName) return queueName;
      return `service-${eventType}`;
    },
  });

  // Set up event handlers BEFORE connecting
  messagingClient.on("connected", () => {
    console.log("Connected to RabbitMQ");
  });

  messagingClient.on("disconnected", () => {
    console.log("Disconnected from RabbitMQ");
  });

  messagingClient.on("error", (error) => {
    console.error("RabbitMQ error:", error);
  });

  // Register the messaging plugin
  await fastify.register(fastifyMessaging, {
    client: messagingClient,
  });

  // Subscribe to events
  const subscriptionId = await fastify.messaging.subscribe<OrderCreatedEvent>(
    "order.created",
    async (message) => {
      try {
        fastify.log.info(`Order created: ${message.content.id}`);
        await message.ack();
      } catch (error) {
        fastify.log.error(`Error processing message: ${error}`);
        await message.nack(true);
      }
      // Process the order...
    },
    {
      // No queueName specified                   // Optional: named queue for persistent subscriptions
      durable: false, // No need to persist for this example
      autoDelete: true, // Delete the queue when the consumer disconnects
      ackMode: "manual", // Manual acknowledgment
    }
  );

  // Add a DLX consumer for failed messages
  await messagingClient.subscribe(
    "failed.order.created", // Format: failed.{original-topic}
    async (message) => {
      const headers = message.options?.headers || {};
      console.log("Processing failed message:");
      console.log("Error:", headers["x-error"]);
      console.log("Failed at:", headers["x-failed-at"]);
      console.log("Original content:", message.content);

      // Always acknowledge DLX messages when done processing
      await message.ack();
    },
    {
      queueName: "dlq.example", // Same as configured in the client
      durable: true,
      ackMode: "manual",
    }
  );

  console.log("Consumer started, waiting for messages...");

  fastify.log.info(
    `Subscribed to order.created events with ID: ${subscriptionId}`
  );

  process.on("SIGINT", async () => {
    console.log("Shutting down...");
    await messagingClient.gracefulShutdown(10000);
    process.exit(0);
  });

  await fastify.listen({ port: 3003, host: "0.0.0.0" });
}

start().catch((err) => {
  console.error("Error starting server:", err);
  process.exit(1);
});

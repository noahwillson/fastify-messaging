// examples/publisher-service.ts
import Fastify from "fastify";
import { RabbitMQClient } from "../src/providers/rabbitmq/rabbitmq-client";
import { fastifyMessaging } from "../src";

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

  // Example route that publishes an event
  fastify.post("/orders", async (request, reply) => {
    const order = request.body as any;

    // Process order...

    // Publish event
    await fastify.messaging.publish("order.created", {
      id: order.id,
      customerId: order.customerId,
      amount: order.amount,
      timestamp: new Date().toISOString(),
    });

    return { success: true, orderId: order.id };
  });

  await fastify.listen({ port: 3002, host: "0.0.0.0" });
}

start().catch((err) => {
  console.error("Error starting server:", err);
  process.exit(1);
});

// examples/publisher-service.ts
import Fastify from "fastify";
import { RabbitMQClient } from "../src/providers/rabbitmq/rabbitmq-client";
import { fastifyMessaging } from "../src";

// Define the payload type for type safety
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
    maxReconnectAttempts: 2,
  });

  // Get connection status for monitoring/health checks
  const mqStatus = messagingClient.getConnectionStatus();
  console.log(`RabbitMQ connected: ${mqStatus.connected}`);
  console.log(`Permanent failure: ${mqStatus.permanentFailure}`);
  console.log(`Retry count: ${mqStatus.retryCount}`);

  // Set up event handlers BEFORE connecting
  messagingClient.on("connected", () => {
    console.log("Connected to RabbitMQ");
  });

  messagingClient.on("disconnected", () => {
    console.log("Disconnected from RabbitMQ");
  });

  messagingClient.on("reconnected", () => {
    console.log("Reconnected to RabbitMQ - executing retry logic");
  });

  messagingClient.on("error", (error) => {
    console.error("RabbitMQ error:", error);
  });

  // Listen for connection status events
  messagingClient.on("connection_permanently_down", () => {
    console.log("RabbitMQ connection is permanently down");
    // Trigger alerts, notifications, or fallback mechanisms
  });

  // Set up reconnect callback
  messagingClient.onReconnect(async () => {
    console.log("Custom reconnect logic executing");
    // Implement any reconnection logic here
  });

  // Register the messaging plugin
  await fastify.register(fastifyMessaging, {
    client: messagingClient,
  });

  await messagingClient.attemptRecovery();

  fastify.post("/users", async (request, reply) => {
    const user = request.body as any;

    try {
      const userCreatedEvent: UserCreatedEvent = {
        id: "123",
        name: "John Doe",
        email: "john@example.com",
        createdAt: new Date().toISOString(),
      };

      await messagingClient.publish("user.created", userCreatedEvent, {
        persistent: true,
        headers: {
          source: "example-publisher",
          correlationId: "unique-correlation-id",
        },
      });

      console.log("Published user created event");
    } catch (error) {
      console.error("Error publishing event:", error);
    }

    return { success: true, userId: user.id };
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

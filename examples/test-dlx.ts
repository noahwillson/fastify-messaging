import Fastify from "fastify";
import { RabbitMQClient } from "../src/providers/rabbitmq/rabbitmq-client";
import { fastifyMessaging } from "../src";

async function testDeadLetterQueue() {
  const client = new RabbitMQClient({
    url: "amqp://localhost:5672",
    exchange: "test-exchange",
    exchangeType: "topic",
    deadLetterExchange: "dlx.exchange",
    deadLetterQueue: "dlq.inframodern.billing.orders",
    logLevel: "info",
  });

  // Set up connection state handlers
  client.on("connected", () => {
    console.log("Connected to RabbitMQ");
    // Start publishing messages once connected
    startPublishing(client);
  });

  client.on("error", (error) => {
    console.error("RabbitMQ error:", error.message);
  });

  client.on("disconnected", () => {
    console.log("Disconnected from RabbitMQ - will try to reconnect...");
  });

  try {
    // Set up subscriptions - they will become active when connection is established
    await client.subscribe(
      "orders.create",
      async (message) => {
        console.log("Received message in main queue:", message.content);

        // Simulate different types of failures
        const order = message.content as any;

        if (order.type === "invalid") {
          throw new Error("Invalid order type");
        }

        if (order.amount <= 0) {
          throw new Error("Invalid order amount");
        }

        if (!order.userId) {
          throw new Error("Missing user ID");
        }

        // If we get here, process the order
        console.log("Processing order:", order);
        await message.ack();
      },
      {
        ackMode: "manual",
        queueName: "orders-queue",
        durable: true,
        arguments: {
          "x-dead-letter-exchange": "dlx.exchange",
          "x-dead-letter-routing-key": "failed.orders.create",
        },
      }
    );

    // Set up Dead Letter Queue consumer
    await client.subscribe(
      "failed.orders.create",
      async (message) => {
        console.log("\n=== Dead Letter Queue Received Message ===");
        console.log("Failed message content:", message.content);
        console.log("Error details:", {
          error: message.options?.headers?.["x-error"] || "No error message",
          errorStack:
            message.options?.headers?.["x-error-stack"] || "No stack trace",
          originalRoute:
            message.options?.headers?.["x-original-routing-key"] || "No route",
          failedAt:
            message.options?.headers?.["x-failed-at"] ||
            new Date().toISOString(),
        });
        console.log("==========================================\n");
      },
      {
        ackMode: "manual",
        queueName: "dlx.queue",
        durable: true,
      }
    );

    // Initiate connection - this will keep trying in the background
    await client.connect();

    // Keep the application running
    process.on("SIGINT", async () => {
      console.log("\nGracefully shutting down...");
      await client.gracefulShutdown();
      process.exit(0);
    });
  } catch (error) {
    console.error("Setup error:", error);
    // Don't exit, let the application keep running
  }
}

// Separate function to handle message publishing
async function startPublishing(client: RabbitMQClient) {
  try {
    console.log("\nSending test messages...");

    // Test 1: Invalid order type
    await client.publish("orders.create", {
      type: "invalid",
      amount: 100,
      userId: "123",
    });

    // Wait a bit before sending next message
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Test 2: Invalid amount
    await client.publish("orders.create", {
      type: "regular",
      amount: -50,
      userId: "123",
    });

    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Test 3: Missing user ID
    await client.publish("orders.create", {
      type: "regular",
      amount: 100,
      userId: "",
    });

    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Test 4: Valid message (shouldn't go to DLQ)
    await client.publish("orders.create", {
      type: "regular",
      amount: 100,
      userId: "123",
    });
  } catch (error) {
    console.error("Error publishing messages:", error);
  }
}

// Run the test
console.log("Starting DLQ test...");
testDeadLetterQueue();

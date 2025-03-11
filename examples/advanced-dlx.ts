import { RabbitMQClient } from "../src/providers/rabbitmq/rabbitmq-client";

/**
 * This example demonstrates the advanced Dead Letter Exchange (DLX) features:
 * - Configurable routing keys for DLX bindings
 * - Custom routing keys for dead-lettered messages
 * - TTL for messages in Dead Letter Queues
 * - Microservice-specific DLQs with isolation
 */
async function testAdvancedDLX() {
  // Create a RabbitMQ client with advanced DLX configuration
  const client = new RabbitMQClient({
    url: "amqp://localhost:5672",
    exchange: "services-exchange",
    exchangeType: "topic",

    // Global DLX configuration
    deadLetterExchange: "dlx.services",
    deadLetterQueue: "dlq.global",
    deadLetterRoutingKey: "#", // Catch all failed messages
    deadLetterMessageRoutingKey: "failed.global", // Custom routing key for dead-lettered messages

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
    // 1. Set up a subscription with the global DLX
    await client.subscribe(
      "orders.created",
      async (message) => {
        console.log("Received order:", message.content);

        // Simulate an error for certain orders
        const order = message.content as any;
        if (order.amount <= 0) {
          console.log("Invalid order amount, rejecting message");
          await message.nack(false); // Send to DLQ
          return;
        }

        await message.ack();
      },
      {
        ackMode: "manual",
        queueName: "orders-service-queue",
      }
    );

    // 2. Set up a subscription with a service-specific DLX
    await client.subscribeWithDLX(
      "payments.processed",
      async (message) => {
        console.log("Received payment:", message.content);

        // Simulate an error for certain payments
        const payment = message.content as any;
        if (payment.status === "failed") {
          console.log("Failed payment, rejecting message");
          await message.nack(false); // Send to DLQ
          return;
        }

        await message.ack();
      },
      "dlx.payments", // Service-specific DLX
      "dlq.payments", // Service-specific DLQ
      {
        ackMode: "manual",
        queueName: "payments-service-queue",
        dlxRoutingKey: "payments.#", // Only catch payment-related failures
      }
    );

    // 3. Set up a consumer for the global DLQ
    await client.subscribe(
      "#", // Match all routing keys
      async (message) => {
        console.log("\n=== Global DLQ Received Message ===");
        console.log("Failed message content:", message.content);
        console.log("Routing key:", message.routingKey);
        console.log("==========================================\n");

        await message.ack();
      },
      {
        ackMode: "manual",
        queueName: "dlq.global",
        exchangeName: "dlx.services", // Use the DLX as the exchange
      }
    );

    // 4. Set up a consumer for the payments-specific DLQ
    await client.subscribe(
      "payments.#", // Match only payment-related routing keys
      async (message) => {
        console.log("\n=== Payments DLQ Received Message ===");
        console.log("Failed payment:", message.content);
        console.log("Routing key:", message.routingKey);
        console.log("==========================================\n");

        await message.ack();
      },
      {
        ackMode: "manual",
        queueName: "dlq.payments",
        exchangeName: "dlx.payments", // Use the payments DLX as the exchange
      }
    );

    // Initiate connection
    await client.connect();

    // Keep the application running
    process.on("SIGINT", async () => {
      console.log("\nGracefully shutting down...");
      await client.gracefulShutdown();
      process.exit(0);
    });
  } catch (error) {
    console.error("Setup error:", error);
  }
}

// Function to publish test messages
async function startPublishing(client: RabbitMQClient) {
  try {
    console.log("\nSending test messages...");

    // 1. Valid order (should be processed normally)
    await client.publish("orders.created", {
      id: "order-123",
      amount: 99.99,
      customerId: "customer-456",
    });
    console.log("Published valid order");

    // Wait a bit before sending next message
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 2. Invalid order (should go to global DLQ)
    await client.publish("orders.created", {
      id: "order-124",
      amount: -10.0, // Invalid amount
      customerId: "customer-456",
    });
    console.log("Published invalid order");

    // Wait a bit before sending next message
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 3. Valid payment (should be processed normally)
    await client.publish("payments.processed", {
      id: "payment-789",
      orderId: "order-123",
      amount: 99.99,
      status: "completed",
    });
    console.log("Published valid payment");

    // Wait a bit before sending next message
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 4. Failed payment (should go to payments-specific DLQ)
    await client.publish("payments.processed", {
      id: "payment-790",
      orderId: "order-124",
      amount: 50.0,
      status: "failed",
    });
    console.log("Published failed payment");
  } catch (error) {
    console.error("Error publishing messages:", error);
  }
}

// Run the example
console.log("Starting advanced DLX example...");
testAdvancedDLX();

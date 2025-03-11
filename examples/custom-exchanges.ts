import { RabbitMQClient } from "../src/providers/rabbitmq/rabbitmq-client";

/**
 * This example demonstrates how to use custom exchanges with the RabbitMQ client.
 * It shows how a single client instance can interact with multiple exchanges,
 * which is useful for multi-application scenarios.
 */
async function testCustomExchanges() {
  // Create a RabbitMQ client with a default exchange
  const client = new RabbitMQClient({
    url: "amqp://localhost:5672",
    exchange: "main-exchange",
    exchangeType: "topic",
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
    // 1. Subscribe to the default exchange
    await client.subscribe(
      "orders.created",
      async (message) => {
        console.log("Received order from main exchange:", message.content);
        await message.ack();
      },
      {
        ackMode: "manual",
        queueName: "orders-queue",
      }
    );

    // 2. Subscribe to a custom exchange (payments)
    await client.subscribe(
      "payments.processed",
      async (message) => {
        console.log(
          "Received payment from payments exchange:",
          message.content
        );
        await message.ack();
      },
      {
        ackMode: "manual",
        queueName: "payments-queue",
        exchangeName: "payments-exchange", // Custom exchange name
        exchangeType: "topic", // Exchange type
      }
    );

    // 3. Subscribe to a fanout exchange for broadcasts
    await client.subscribe(
      "", // Empty routing key for fanout exchanges
      async (message) => {
        console.log("Received broadcast message:", message.content);
        await message.ack();
      },
      {
        ackMode: "manual",
        queueName: "notifications-queue",
        exchangeName: "notifications-exchange",
        exchangeType: "fanout", // Different exchange type
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

// Function to publish messages to different exchanges
async function startPublishing(client: RabbitMQClient) {
  try {
    console.log("\nSending test messages to different exchanges...");

    // 1. Publish to the default exchange
    await client.publish("orders.created", {
      id: "order-123",
      amount: 99.99,
      customerId: "customer-456",
    });
    console.log("Published order to main exchange");

    // Wait a bit before sending next message
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 2. Publish to the payments exchange
    await client.publish(
      "payments.processed",
      {
        id: "payment-789",
        orderId: "order-123",
        amount: 99.99,
        status: "completed",
      },
      {}, // No special options
      "payments-exchange" // Specify the custom exchange
    );
    console.log("Published payment to payments exchange");

    // Wait a bit before sending next message
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 3. Publish to the fanout exchange
    await client.publishToFanout(
      "notifications-exchange", // The fanout exchange name
      {
        type: "broadcast",
        message: "System maintenance scheduled for tomorrow",
        priority: "high",
      }
    );
    console.log("Published broadcast to notifications exchange");
  } catch (error) {
    console.error("Error publishing messages:", error);
  }
}

// Run the example
console.log("Starting custom exchanges example...");
testCustomExchanges();

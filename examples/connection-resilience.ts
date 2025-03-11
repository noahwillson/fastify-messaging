import { RabbitMQClient } from "../src/providers/rabbitmq/rabbitmq-client";

/**
 * This example demonstrates the connection resilience features of the RabbitMQ client.
 * It shows how the application can remain operational even when RabbitMQ is unavailable,
 * and how to handle different connection states.
 *
 * To test this example:
 * 1. Start RabbitMQ
 * 2. Run this example
 * 3. Stop RabbitMQ to see how the client handles disconnection
 * 4. Start RabbitMQ again to see automatic recovery
 */
async function testConnectionResilience() {
  // Create a RabbitMQ client with connection resilience configuration
  const client = new RabbitMQClient({
    url: "amqp://localhost:5672",
    exchange: "resilience-exchange",
    exchangeType: "topic",

    // Connection resilience configuration
    maxReconnectAttempts: 5, // Maximum reconnection attempts before entering permanent down state
    reconnectBackoffMultiplier: 2, // Multiplier for exponential backoff
    maxReconnectDelay: 10000, // Maximum delay between reconnection attempts (10 seconds)

    logLevel: "info",
  });

  // Set up connection state handlers
  client.on("connected", () => {
    console.log("✅ Connected to RabbitMQ");
    displayConnectionStatus(client);

    // Try to publish a message when connected
    publishTestMessage(client, "Connected and publishing a message");
  });

  client.on("disconnected", () => {
    console.log("❌ Disconnected from RabbitMQ - will try to reconnect...");
    displayConnectionStatus(client);
  });

  client.on("error", (error) => {
    console.error("⚠️ RabbitMQ error:", error.message);
  });

  // Listen for the permanent down state
  client.on("connection_permanently_down", () => {
    console.log("🔴 RabbitMQ connection is permanently down");
    console.log("    The application will continue running");
    console.log(
      "    Publishing attempts will return false instead of throwing errors"
    );
    console.log(
      "    Recovery attempts will run in the background every 5 minutes"
    );

    displayConnectionStatus(client);

    // Try to publish a message when in permanent down state
    publishTestMessage(
      client,
      "Attempting to publish while connection is down"
    );

    // Schedule a manual recovery attempt after 15 seconds
    setTimeout(async () => {
      console.log("\n🔄 Attempting manual recovery...");
      await client.attemptRecovery();
    }, 15000);
  });

  // Set up a subscription - it will become active when connected
  await client.subscribe(
    "resilience.test",
    async (message) => {
      console.log("📨 Received message:", message.content);
      await message.ack();
    },
    {
      ackMode: "manual",
      queueName: "resilience-queue",
    }
  );

  // Initiate connection
  console.log("🔄 Initiating connection to RabbitMQ...");
  await client.connect();

  // Periodically display connection status and try to publish
  setInterval(() => {
    displayConnectionStatus(client);
    publishTestMessage(
      client,
      `Periodic message at ${new Date().toISOString()}`
    );
  }, 10000);

  // Keep the application running
  process.on("SIGINT", async () => {
    console.log("\n🛑 Gracefully shutting down...");
    await client.gracefulShutdown();
    process.exit(0);
  });
}

// Helper function to display connection status
function displayConnectionStatus(client: RabbitMQClient) {
  const status = client.getConnectionStatus();
  console.log("\n📊 Connection Status:");
  console.log(`    Connected: ${status.connected ? "Yes ✅" : "No ❌"}`);
  console.log(
    `    Permanent Failure: ${status.permanentFailure ? "Yes ⚠️" : "No"}`
  );
  console.log(`    Retry Count: ${status.retryCount}`);
  console.log("");
}

// Helper function to publish a test message
async function publishTestMessage(client: RabbitMQClient, message: string) {
  try {
    const result = await client.publish("resilience.test", {
      message,
      timestamp: new Date().toISOString(),
    });

    if (result) {
      console.log(`📤 Successfully published message: "${message}"`);
    } else {
      console.log(
        `❌ Failed to publish message: "${message}" (RabbitMQ unavailable)`
      );
    }
  } catch (error) {
    console.error(`⚠️ Error publishing message: ${error.message}`);
  }
}

// Run the example
console.log("🚀 Starting connection resilience example...");
testConnectionResilience();

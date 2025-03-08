# fastify-messaging

A flexible, extensible messaging framework for Fastify microservices that abstracts away the specific message broker implementation.

[![npm version](https://img.shields.io/npm/v/fastify-messaging.svg)](https://www.npmjs.com/package/fastify-messaging)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-blue)](https://www.typescriptlang.org/)

## Table of Contents

1. [Features](#features)
2. [Installation](#installation)
3. [Quick Start](#quick-start)
   - [Publisher Service](#publisher-service)
   - [Consumer Service](#consumer-service)
4. [API Reference](#api-reference)
   - [MessagingClient](#messagingclient)
   - [RabbitMQClient](#rabbitmqclient)
   - [fastifyMessaging](#fastifymessaging)
5. [Publishing Messages](#publishing-messages)
6. [Subscribing to Messages](#subscribing-to-messages)
7. [Advanced Features](#advanced-features)
   - [Fanout Exchanges](#fanout-exchanges)
   - [Dead Letter Exchanges](#dead-letter-exchanges-dlx)
   - [Event Handling](#event-handling)
   - [Graceful Shutdown](#graceful-shutdown)
8. [Topic Patterns (RabbitMQ)](#topic-patterns-rabbitmq)
9. [Error Handling](#error-handling)
10. [Creating a Custom Provider](#creating-a-custom-provider)
11. [Best Practices](#best-practices)
12. [Why Use This Package?](#why-use-this-package)
13. [Contributing](#contributing)
14. [License](#license)
15. [Acknowledgments](#acknowledgments)

## Features

- Abstract messaging interface that can be implemented by different providers
- Built-in RabbitMQ implementation with advanced features:
  - Multiple exchange types (topic, fanout)
  - Dead Letter Exchange (DLX) integration
  - Configurable logging levels
  - Event-driven connection lifecycle management
  - Graceful shutdown handling
- Fastify plugin for easy integration
- TypeScript support with generics for message types
- Automatic reconnection with configurable intervals
- Message TTL and priority support
- Manual/Auto message acknowledgment modes
- Prefetch configuration for message processing rate
- Dynamic exchange and queue name configuration
- Subscription management with queue options
- **New Features:**
  - **Reconnect Callback:** Set a callback function to be executed when the messaging client reconnects.
  - **Logging Levels:** Configurable logging levels for better observability.
  - **Dynamic Queue Creation:** Create dynamic queues for microservices.
  - **Subscription with DLX:** Subscribe to messages with Dead Letter Exchange (DLX) support.
  - **Fanout Exchange Subscription:** Subscribe to events from a fanout exchange using a dynamic queue.

## Installation

```bash
npm install fastify-messaging
```

## Quick Start

### Publisher Service

```typescript
import Fastify from "fastify";
import { RabbitMQClient, fastifyMessaging } from "fastify-messaging";

async function start() {
  const fastify = Fastify();

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

    // Publish event
    await fastify.messaging.publish("order.created", {
      id: order.id,
      customerId: order.customerId,
      amount: order.amount,
      timestamp: new Date().toISOString(),
    });

    return { success: true, orderId: order.id };
  });

  await fastify.listen({ port: 3000 });
}

start();
```

### Consumer Service

```typescript
import Fastify from "fastify";
import { RabbitMQClient, fastifyMessaging } from "fastify-messaging";

interface OrderCreatedEvent {
  id: string;
  customerId: string;
  amount: number;
  timestamp: string;
}

async function start() {
  const fastify = Fastify();

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
      queueName: "order-service-queue",
      durable: true,
    }
  );

  await fastify.listen({ port: 3001 });
}

start();
```

## API Reference

### MessagingClient

Abstract class that defines the messaging interface.

#### Methods

- `connect()`: Connect to the messaging system
- `publish<T>(topic: string, message: T, options?: MessageOptions)`: Publish a message
- `subscribe<T>(topic: string, handler: MessageHandler<T>, options?: SubscriptionOptions)`: Subscribe to messages
- `unsubscribe(subscriptionId: string)`: Unsubscribe from messages
- `close()`: Close the connection
- `on(event: RabbitMQEvents, listener)`: Listen to connection events
- `onReconnect(callback)`: Set reconnection callback
- `setLogLevel(level)`: Configure logging verbosity
- `publishToFanout(eventType, message, options)`: Publish to fanout exchange
- `subscribeToFanout(eventType, handler, queueName, options)`: Subscribe to fanout exchange
- `subscribeWithDLX(topic, handler, dlxExchange, dlxQueue, options)`: Subscribe with DLX
- `gracefulShutdown(timeout)`: Gracefully shutdown connection

### RabbitMQClient

Implementation of `MessagingClient` for RabbitMQ.

#### Constructor Options

```typescript
interface RabbitMQConfig {
  url: string; // RabbitMQ connection URL
  exchange: string; // Exchange name
  exchangeType?: string; // Exchange type (default: 'topic')
  exchangeOptions?: amqplib.Options.AssertExchange;
  prefetch?: number; // Prefetch count (default: 10)
  reconnectInterval?: number; // Reconnection interval in ms (default: 5000)
  vhost?: string; // Virtual host
  heartbeat?: number; // Heartbeat interval in seconds
  connectionTimeout?: number; // Connection timeout in ms
  getExchangeName?: (eventType: string) => string;
  getQueueName?: (eventType: string, queueName?: string) => string;
}
```

#### Example

```typescript
const client = new RabbitMQClient({
  url: "amqp://localhost",
  exchange: "events",
  exchangeType: "topic",
  prefetch: 10,
  reconnectInterval: 5000,
});

await client.connect();
```

### fastifyMessaging

Fastify plugin that integrates a messaging client with Fastify.

#### Options

```typescript
interface FastifyMessagingOptions {
  client: MessagingClient;
}
```

#### Example

```typescript
await fastify.register(fastifyMessaging, {
  client: messagingClient,
});
```

### Message Types

```typescript
// Message handler function
interface MessageHandler<T = any> {
  (message: Message<T>): Promise<void> | void;
}

// Message object passed to handlers
interface Message<T = any> {
  content: T; // The parsed message content
  routingKey: string; // The routing key/topic
  options?: MessageOptions; // Message metadata
  originalMessage?: any; // Provider-specific message object
}

// Options for publishing messages
interface MessageOptions {
  headers?: Record<string, string | number | boolean>;
  contentType?: string;
  contentEncoding?: string;
  persistent?: boolean;
  expiration?: string | number;
  priority?: number;
  correlationId?: string;
  replyTo?: string;
  messageId?: string;
  timestamp?: number;
  [key: string]: any;
  expiration?: string | number; // Message TTL
  priority?: number; // 0-9 priority levels
}

// Options for subscribing to messages
interface SubscriptionOptions {
  queueName?: string; // Name of the queue (default: auto-generated)
  exclusive?: boolean; // Whether the queue is exclusive (default: !queueName)
  durable?: boolean; // Whether the queue is durable (default: !!queueName)
  autoDelete?: boolean; // Whether the queue is auto-deleted (default: !queueName)
  prefetch?: number; // Prefetch count for this subscription
  ackMode?: "auto" | "manual";
  arguments?: any; // DLX configuration
  [key: string]: any;
}
```

## Publishing Messages

```typescript
// Basic publishing
await fastify.messaging.publish("user.created", {
  id: "123",
  name: "John Doe",
  email: "john@example.com",
});

// Publishing with options
await fastify.messaging.publish(
  "order.shipped",
  {
    orderId: "456",
    trackingNumber: "TRACK123",
  },
  {
    persistent: true,
    priority: 5,
    headers: {
      "x-retry-count": 0,
    },
  }
);
```

## Subscribing to Messages

```typescript
// Basic subscription
const subscriptionId = await fastify.messaging.subscribe(
  "user.created",
  async (message) => {
    console.log(`User created: ${message.content.id}`);
  }
);

// Subscription with a named queue (for persistent subscriptions)
const orderSubscriptionId = await fastify.messaging.subscribe(
  "order.*.created",
  async (message) => {
    console.log(`Order created: ${message.content.id}`);
  },
  {
    queueName: "order-processing-service",
    durable: true,
  }
);

// Unsubscribing
await fastify.messaging.unsubscribe(subscriptionId);
```

## Advanced Features

### Fanout Exchanges

```typescript
// Publisher
await client.publishToFanout("system.alerts", {
  severity: "critical",
  message: "Server down!",
});

// Subscriber
await client.subscribeToFanout(
  "system.alerts",
  (msg) => console.log("ALERT:", msg.content),
  "alerts-queue"
);
```

### Dead Letter Exchanges (DLX)

```typescript
await client.subscribeWithDLX(
  "payment.process",
  async (msg) => {
    // Process payment
  },
  "payments_dlx",
  "payments_dlx_queue",
  {
    queueName: "payments",
    arguments: {
      "x-message-ttl": 60000,
      "x-dead-letter-exchange": "payments_dlx",
    },
  }
);
```

### Event Handling

```typescript
client.on("connected", () => console.log("Connected to RabbitMQ"));
client.on("error", (err) => console.error("RabbitMQ error:", err));
client.on("reconnected", () => console.log("Reconnected successfully"));
```

### Graceful Shutdown

```typescript
process.on("SIGINT", async () => {
  await client.gracefulShutdown(10000);
  process.exit(0);
});
```

## Topic Patterns (RabbitMQ)

RabbitMQ supports topic patterns with wildcards:

- `*` (star) matches exactly one word
- `#` (hash) matches zero or more words

Examples:

- `order.created` - Matches only "order.created" events
- `order.*` - Matches "order.created", "order.updated", etc.
- `order.#` - Matches "order.created", "order.item.added", etc.
- `#` - Matches all messages

## Error Handling

The framework provides custom error classes for different types of errors:

```typescript
import {
  MessagingError,
  ConnectionError,
  PublishError,
  SubscriptionError,
} from "fastify-messaging";

try {
  await fastify.messaging.publish("order.created", { id: "123" });
} catch (error) {
  if (error instanceof PublishError) {
    // Handle publishing error
  } else if (error instanceof ConnectionError) {
    // Handle connection error
  } else {
    // Handle other errors
  }
}
```

## Creating a Custom Provider

You can create your own messaging provider by implementing the `MessagingClient` abstract class:

```typescript
import {
  MessagingClient,
  Message,
  MessageHandler,
  MessageOptions,
  SubscriptionOptions,
} from "fastify-messaging";

export class CustomMessagingClient extends MessagingClient {
  constructor(config: any) {
    super(config);
  }

  async connect(): Promise<void> {
    // Connect to your messaging system
  }

  async publish<T>(
    topic: string,
    message: T,
    options?: MessageOptions
  ): Promise<boolean> {
    // Publish a message
    return true;
  }

  async subscribe<T>(
    topic: string,
    handler: MessageHandler<T>,
    options?: SubscriptionOptions
  ): Promise<string> {
    // Subscribe to messages
    return "subscription-id";
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    // Unsubscribe from messages
  }

  async close(): Promise<void> {
    // Close the connection
  }
}
```

Then use it with Fastify:

```typescript
const messagingClient = new CustomMessagingClient({
  // Your custom configuration
});

await fastify.register(fastifyMessaging, {
  client: messagingClient,
});
```

## Best Practices

1. **Use TypeScript Interfaces for Events**: Define interfaces for your event types to ensure type safety.

```typescript
interface UserCreatedEvent {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

await fastify.messaging.publish<UserCreatedEvent>("user.created", {
  id: "123",
  name: "John Doe",
  email: "john@example.com",
  createdAt: new Date().toISOString(),
});
```

2. **Use Named Queues for Services**: When you want a service to receive all messages of a certain type, even if it's down temporarily, use a named queue.

```typescript
await fastify.messaging.subscribe<OrderCreatedEvent>(
  "order.created",
  handleOrderCreated,
  {
    queueName: "order-processing-service",
    durable: true,
  }
);
```

3. **Use Correlation IDs**: For request-reply patterns or tracking message flows across services.

```typescript
const correlationId = uuidv4();

await fastify.messaging.publish(
  "user.get",
  { userId: "123" },
  {
    correlationId,
    replyTo: "user-service.replies",
  }
);
```

4. **Handle Errors Properly**: Always wrap messaging operations in try-catch blocks.

```typescript
try {
  await fastify.messaging.publish("order.created", orderData);
} catch (error) {
  fastify.log.error("Failed to publish order.created event", error);
  // Implement fallback strategy or retry logic
}
```

5. **Use DLX for Critical Messages**: Ensure message reliability with dead letter exchanges.

6. **Manual Acknowledgments**: Use ackMode: 'manual' for guaranteed processing.

7. **Priority Queues**: Implement message prioritization for urgent tasks.

```typescript
// Example priority message
await client.publish("order.priority", orderData, {
  priority: 9,
  expiration: 3600000, // 1 hour TTL
});

// Example DLX configuration
await client.subscribeWithDLX(
  "invoice.generate",
  processInvoice,
  "invoice_dlx",
  "invoice_dlx_queue"
);
```

8. **Prefetch Tuning**: Adjust prefetch count based on consumer capacity.

9. **Connection Monitoring**: Use event listeners for connection state management.

10. **Structured Logging**: Utilize setLogLevel for production logging.

## Why Use This Package?

- **Abstraction**: Decouples your application code from the specific message broker implementation
- **Future-Proofing**: Switch message brokers without changing your application code
- **Simplicity**: Clean, intuitive API that's easy to use
- **Reliability**: Built-in reconnection and error handling
- **Type Safety**: Full TypeScript support with generics
- **Enterprise-Ready Features**: DLX, priority queues, TTL, and more
- **Production Resilience**: Automatic reconnection, graceful shutdown
- **Enhanced Observability**: Connection events and configurable logging
- **Flexible Patterns**: Support for both topic and fanout exchanges

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- [Fastify](https://www.fastify.io/) - The web framework used
- [amqplib](https://github.com/squaremo/amqp.node) - AMQP 0-9-1 library for Node.js

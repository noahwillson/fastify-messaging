# RabbitMQ Client Examples

This directory contains examples demonstrating various features of the RabbitMQ client.

## Running the Examples

To run any example:

```bash
npm run ts-node examples/example-name.ts
```

For example:

```bash
npm run ts-node examples/custom-exchanges.ts
```

## Available Examples

### Basic Examples

1. **Publisher Service** (`publisher-service.ts`)

   - Demonstrates a basic Fastify service that publishes messages to RabbitMQ
   - Shows how to set up the RabbitMQ client with Fastify
   - Includes error handling and event listeners

2. **Consumer Service** (`consumer-service.ts`)
   - Demonstrates a basic Fastify service that consumes messages from RabbitMQ
   - Shows how to subscribe to topics and handle messages
   - Includes error handling and acknowledgment

### Advanced Features

3. **Dead Letter Queue Test** (`test-dlx.ts`)

   - Demonstrates basic Dead Letter Exchange (DLX) functionality
   - Shows how to set up a DLX and DLQ
   - Includes error handling and message rejection

4. **Advanced DLX** (`advanced-dlx.ts`)

   - Demonstrates advanced Dead Letter Exchange features
   - Shows configurable routing keys for DLX bindings
   - Shows custom routing keys for dead-lettered messages
   - Demonstrates microservice-specific DLQs with isolation

5. **Custom Exchanges** (`custom-exchanges.ts`)

   - Demonstrates using multiple exchanges with a single client
   - Shows how to subscribe to different exchanges
   - Shows how to publish to different exchanges
   - Includes different exchange types (topic, fanout)

6. **Connection Resilience** (`connection-resilience.ts`)
   - Demonstrates connection resilience features
   - Shows how the application remains operational when RabbitMQ is down
   - Demonstrates permanent down state and automatic recovery
   - Shows how to monitor connection status

## Testing Scenarios

### Testing Connection Resilience

1. Start RabbitMQ
2. Run the connection resilience example
3. Stop RabbitMQ to see how the client handles disconnection
4. Start RabbitMQ again to see automatic recovery

### Testing Dead Letter Exchanges

1. Start RabbitMQ
2. Run the advanced DLX example
3. Observe how messages with errors are routed to the appropriate DLQs
4. Observe how different routing keys are used for different services

### Testing Custom Exchanges

1. Start RabbitMQ
2. Run the custom exchanges example
3. Observe how messages are published to and consumed from different exchanges
4. Observe how different exchange types (topic, fanout) behave

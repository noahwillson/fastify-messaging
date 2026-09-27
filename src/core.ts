// Framework-free entry point: `fastify-messaging/core`. Safe for Express and plain Node.
export { MessagingClient } from "./core/messaging-client";
export {
  Message,
  MessageHandler,
  MessageOptions,
  MessagingConfig,
  SubscriptionOptions,
  RetryOptions,
  MessagingLogger,
  LogLevel,
  PublishFunction,
} from "./core/types";
export type { Messaging } from "./core/messaging";
export {
  MessagingError,
  ConnectionError,
  PublishError,
  SubscriptionError,
} from "./core/errors";

// Provider exports
export { RabbitMQClient, RabbitMQConfig } from "./providers";

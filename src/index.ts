export { MessagingClient } from "./core/messaging-client";
export {
  Message,
  MessageHandler,
  MessageOptions,
  MessagingConfig,
  SubscriptionOptions,
} from "./core/types";
export {
  MessagingError,
  ConnectionError,
  PublishError,
  SubscriptionError,
} from "./core/errors";

// Provider exports
export { RabbitMQClient, RabbitMQConfig } from "./providers";

// Plugin exports
export { default as fastifyMessaging } from "./plugins/fastify-messaging";

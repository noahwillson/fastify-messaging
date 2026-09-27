// `fastify-messaging/fastify`: core plus the Fastify plugin.
export * from "./core";
export { default as fastifyMessaging } from "./plugins/fastify-messaging";
export type {
  FastifyMessaging,
  FastifyMessagingOptions,
} from "./plugins/fastify-messaging";

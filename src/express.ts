// `fastify-messaging/express`: core plus the Express adapter. Does not load Fastify.
export * from "./core";
export { expressMessaging } from "./plugins/express-messaging";
export type {
  ExpressAppLike,
  ExpressMessaging,
  ExpressMessagingOptions,
} from "./plugins/express-messaging";

// Root entry point: core plus the Fastify plugin (unchanged for existing users).
// Express and plain Node apps should import `fastify-messaging/express` or `/core`,
// which do not load Fastify or its types.
export * from "./fastify";

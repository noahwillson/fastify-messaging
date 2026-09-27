---
"fastify-messaging": minor
---

Fastify plugin: Fastify 5 support and new options.

- Supports Fastify 4 and 5 (the plugin used to throw `expected '4.x' fastify version` on Fastify 5).
- `requireConnection` makes `app.ready()`/`listen()` fail when the broker is unreachable, and stops background reconnects.
- Client logs go to `fastify.log` by default (`useFastifyLogger: false` to opt out). Any client now accepts a `logger` (pino/winston/console compatible) through config or `setLogger()`.
- `shutdownTimeout` is passed to `gracefulShutdown()` on `app.close()`.
- `fastify.messaging` adds `isConnected()` and `getConnectionStatus()`; `FastifyMessagingOptions` and `FastifyMessaging` types are exported.
- `MessagingClient` gains `setLogger()`, `getLogger()`, `setLogLevel()` and a default `getConnectionStatus()`.

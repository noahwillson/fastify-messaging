---
"fastify-messaging": minor
---

Express and plain Node.js support.

- New entry points: `fastify-messaging/core` (no Fastify), `fastify-messaging/express` (core + Express adapter) and `fastify-messaging/fastify`. The root import is unchanged. Deep imports into `dist/` keep working, and TypeScript `moduleResolution: node` resolves the subpaths through `typesVersions`.
- `expressMessaging(app, options)` connects the client, exposes the API on `app.locals.messaging` and `req.messaging`, supports `requireConnection`, `logger` and `shutdownTimeout`, and returns `shutdown()`. Works with Express 4 and 5 and needs no express typings.
- `fastify` and `express` are optional peer dependencies, so Express apps no longer get Fastify installed.
- The client no longer keeps the process alive on its own: the background health check starts only after reconnecting gave up, and is unref'd.

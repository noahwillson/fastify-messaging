# fastify-messaging

## 1.3.0

### Minor Changes

- ea7237f: Express and plain Node.js support.

  - New entry points: `fastify-messaging/core` (no Fastify), `fastify-messaging/express` (core + Express adapter) and `fastify-messaging/fastify`. The root import is unchanged. Deep imports into `dist/` keep working, and TypeScript `moduleResolution: node` resolves the subpaths through `typesVersions`.
  - `expressMessaging(app, options)` connects the client, exposes the API on `app.locals.messaging` and `req.messaging`, supports `requireConnection`, `logger` and `shutdownTimeout`, and returns `shutdown()`. Works with Express 4 and 5 and needs no express typings.
  - `fastify` and `express` are optional peer dependencies, so Express apps no longer get Fastify installed.
  - The client no longer keeps the process alive on its own: the background health check starts only after reconnecting gave up, and is unref'd.

- 117a514: Fastify plugin: Fastify 5 support and new options.

  - Supports Fastify 4 and 5 (the plugin used to throw `expected '4.x' fastify version` on Fastify 5).
  - `requireConnection` makes `app.ready()`/`listen()` fail when the broker is unreachable, and stops background reconnects.
  - Client logs go to `fastify.log` by default (`useFastifyLogger: false` to opt out). Any client now accepts a `logger` (pino/winston/console compatible) through config or `setLogger()`.
  - `shutdownTimeout` is passed to `gracefulShutdown()` on `app.close()`.
  - `fastify.messaging` adds `isConnected()` and `getConnectionStatus()`; `FastifyMessagingOptions` and `FastifyMessaging` types are exported.
  - `MessagingClient` gains `setLogger()`, `getLogger()`, `setLogLevel()` and a default `getConnectionStatus()`.

- 683bfee: RabbitMQ client reliability fixes and delayed retry for failed messages.

  New:

  - `retry` subscription option: delayed retries through per-delay TTL queues, then dead-lettering with error headers. `Message.retryCount` exposes the attempt number.
  - `replayDeadLetters(queue)` moves parked messages back to the queue they failed in.

  Fixes:

  - `frameMax`, `heartbeat` and `vhost` config were ignored (amqplib only reads them from the URL). Connecting to RabbitMQ 4.1+ failed unless the URL contained `?frameMax=`. `frameMax` now defaults to 131072.
  - Emitting `error` with no listener threw: `connect()` rejected without scheduling a reconnect, and handler or connection errors crashed the process.
  - `ackMode: "auto"` acked messages on a `noAck` consumer, which closed the channel on every message. Auto mode now acks after the handler resolves.
  - A server-closed channel (e.g. 406) was never recovered; the connection is now recycled and subscriptions restored.
  - A failed setup after the socket opened left the client stuck as "connected".
  - A concurrent `publish()`/`subscribe*()` during `connect()` no longer fails; they wait for the in-flight connection.
  - `close()` no longer triggers a reconnect.
  - `onReconnect` callbacks and the `reconnected` event now fire.
  - `maxReconnectAttempts`, `reconnectInterval`, `reconnectBackoffMultiplier`, `maxReconnectDelay`, `initialConnectionRetries` and `initialConnectionDelay` are honoured.
  - Subscription ids stay valid across reconnects, and `unsubscribe()` works while disconnected.
  - `subscribeToFanout` declares its fanout exchange (it failed with 404 before any publisher had run).
  - `subscribeWithDLX` handler errors go to its own DLX instead of being requeued forever (or sent to the global DLX).
  - New DLQs no longer inherit the main queue's arguments (e.g. `x-message-ttl` silently expired dead letters). Existing DLQs are left as they are.
  - Messages moved to a DLX are published with confirms before the original is acked; a manual handler that acks and then throws no longer double-acks.

  Behaviour changes:

  - `subscribe()` now rejects with `SubscriptionError` when the broker refuses the queue or binding (it used to resolve with an id for a subscription that never worked).
  - Unparseable (non-JSON) messages without retry or a DLX are rejected instead of requeued in a loop.

## 1.2.9

### Patch Changes

- framemax fix

## 1.2.8

### Patch Changes

- 2659812: feat(rabbitmq): add frameMax support

## 1.2.6

### Patch Changes

- e570ff0: documentation

## 1.2.5

### Patch Changes

- 0694bb8: assertExchange

## 1.2.4

### Patch Changes

- 2f112c3: exchange_name_subs

## 1.2.3

### Patch Changes

- e2b0657: minor dlq

## 1.2.2

### Patch Changes

- 9454a5a: dlq routing

## 1.2.1

### Patch Changes

- c165f88: Connection monitoring

## 1.2.0

### Minor Changes

- cf3cddb: support for dlx

## 1.1.3

### Patch Changes

- d42906a: Fix: Add more types

## 1.1.2

### Patch Changes

- 0c5e4b6: minor changes to add ack

## 1.1.1

### Patch Changes

- ef16357: Added the newfeatures to the documentation

## 1.1.0

### Minor Changes

- a52a3cb: DlX,Reconnect,PublishFanout,Gracefull shutdown

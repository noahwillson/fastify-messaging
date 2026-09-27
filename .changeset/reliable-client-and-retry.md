---
"fastify-messaging": minor
---

RabbitMQ client reliability fixes and delayed retry for failed messages.

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

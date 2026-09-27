import { afterEach, describe, expect, it } from "vitest";
import { RabbitMQClient } from "../src";
import {
  BrokerAdmin,
  createClient,
  dropConnection,
  sleep,
  uniq,
  waitFor,
} from "./helpers";

const UNREACHABLE = "amqp://127.0.0.1:1";

describe("RabbitMQClient connection", () => {
  const admin = new BrokerAdmin();
  const clients: RabbitMQClient[] = [];

  function client(overrides: Parameters<typeof createClient>[0]) {
    const c = createClient(overrides);
    clients.push(c);
    admin.trackExchange(overrides.exchange);
    return c;
  }

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.gracefulShutdown(100)));
    await admin.cleanup();
  });

  it("connects to RabbitMQ 4.1+ without an explicit frameMax", async () => {
    const c = client({ exchange: uniq("x") });
    c.on("error", () => {});

    await c.connect();

    expect(c.isConnected()).toBe(true);
  });

  it("does not reject connect() when the broker is down and nobody listens for errors", async () => {
    const c = client({
      url: UNREACHABLE,
      exchange: uniq("x"),
      maxReconnectAttempts: 1,
    });

    await expect(c.connect()).resolves.toBeUndefined();
    await waitFor(() => c.getConnectionStatus().permanentFailure, {
      message: "permanent failure",
    });
  });

  it("stops retrying after maxReconnectAttempts using the configured delays", async () => {
    const c = client({
      url: UNREACHABLE,
      exchange: uniq("x"),
      maxReconnectAttempts: 3,
      reconnectInterval: 5000,
      maxReconnectDelay: 20, // caps the 5s interval, so this finishes fast
    });
    let permanentlyDown = false;
    c.on("error", () => {});
    c.on("connection_permanently_down", () => (permanentlyDown = true));

    await c.connect();

    await waitFor(() => permanentlyDown, { timeout: 2000, message: "permanently down" });
    expect(c.getConnectionStatus().retryCount).toBe(3);
  });

  it("uses initialConnectionRetries before the first successful connection", async () => {
    const c = client({
      url: UNREACHABLE,
      exchange: uniq("x"),
      maxReconnectAttempts: 50,
      initialConnectionRetries: 1,
      initialConnectionDelay: 10,
    });
    c.on("error", () => {});

    await c.connect();

    await waitFor(() => c.getConnectionStatus().permanentFailure, {
      timeout: 2000,
      message: "permanent failure",
    });
    expect(c.getConnectionStatus().retryCount).toBe(1);
  });

  it("lets a publish issued during connect() wait for the connection", async () => {
    const c = client({ exchange: uniq("x") });

    const connecting = c.connect();
    const published = await c.publish("some.topic", { hello: "world" });
    await connecting;

    expect(published).toBe(true);
  });

  it("recovers when connection setup fails after the socket opened", async () => {
    const exchange = uniq("x");
    const ch = await admin.channel();
    // Conflicting type makes the client's assertExchange fail with 406.
    await ch.assertExchange(exchange, "fanout", { durable: false });
    const c = client({ exchange, exchangeType: "topic" });
    c.on("error", () => {});

    await c.connect();
    expect(c.isConnected()).toBe(false);

    await ch.deleteExchange(exchange);
    await waitFor(() => c.isConnected(), { message: "reconnect" });
    expect(await c.publish("some.topic", { ok: true })).toBe(true);
  });

  it("recovers after the server closes the channel", async () => {
    const exchange = uniq("x");
    const queueName = uniq("q");
    admin.trackQueue(queueName);
    const ch = await admin.channel();
    await ch.assertQueue(queueName, { arguments: { "x-max-length": 10 } });
    const c = client({ exchange });
    c.on("error", () => {});
    await c.connect();

    // Redeclaring with different arguments: server closes the channel (406).
    await c
      .subscribe("t", () => {}, {
        queueName,
        ackMode: "manual",
        arguments: { "x-max-length": 5 },
      })
      .catch(() => {});

    await waitFor(async () => c.isConnected() && (await c.publish("t", {})), {
      message: "channel recovery",
    });
  });

  it("does not reconnect after close()", async () => {
    const c = client({ exchange: uniq("x") });
    c.on("error", () => {});
    await c.connect();

    await c.close();
    await sleep(300);

    expect(c.isConnected()).toBe(false);
    expect(c.getConnectionStatus().retryCount).toBe(0);
  });

  it.each(["close", "gracefulShutdown"] as const)(
    "does not come back to life when %s() runs during an in-flight connect()",
    async (method) => {
      const c = client({ exchange: uniq("x") });
      c.on("error", () => {});
      const queueName = uniq("q");
      admin.trackQueue(queueName);
      let calls = 0;
      await c.subscribe("t.zombie", () => void calls++, { queueName, ackMode: "auto" });

      const connecting = c.connect();
      await c[method]();
      await connecting;
      await sleep(200);

      expect(c.isConnected()).toBe(false);
      const ch = await admin.channel();
      await ch.assertExchange((c as any).rabbitConfig.exchange, "topic", { durable: true });
      await ch.assertQueue(queueName, { durable: true });
      ch.publish((c as any).rabbitConfig.exchange, "t.zombie", Buffer.from("{}"));
      await sleep(200);
      expect(calls).toBe(0);
    }
  );

  it("emits reconnected and calls onReconnect after the connection drops", async () => {
    const c = client({ exchange: uniq("x") });
    c.on("error", () => {});
    let reconnectedEvents = 0;
    let callbackCalls = 0;
    c.on("reconnected", () => reconnectedEvents++);
    c.onReconnect(() => callbackCalls++);
    await c.connect();

    dropConnection(c);

    await waitFor(() => callbackCalls === 1, { message: "onReconnect callback" });
    expect(reconnectedEvents).toBe(1);
    expect(c.isConnected()).toBe(true);
  });
});

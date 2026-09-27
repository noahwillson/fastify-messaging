import { afterEach, describe, expect, it } from "vitest";
import { Message, RabbitMQClient, SubscriptionError } from "../src";
import {
  BrokerAdmin,
  createClient,
  dropConnection,
  sleep,
  uniq,
  waitFor,
} from "./helpers";

describe("RabbitMQClient subscriptions", () => {
  const admin = new BrokerAdmin();
  const clients: RabbitMQClient[] = [];

  async function connectedClient() {
    const exchange = uniq("x");
    admin.trackExchange(exchange);
    const c = createClient({ exchange });
    clients.push(c);
    await c.connect();
    return c;
  }

  function queue(label = "q") {
    const name = uniq(label);
    admin.trackQueue(name);
    return name;
  }

  async function reconnect(c: RabbitMQClient) {
    let reconnected = false;
    c.onReconnect(() => (reconnected = true));
    dropConnection(c);
    await waitFor(() => reconnected, { message: "reconnect" });
  }

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.gracefulShutdown(100)));
    await admin.cleanup();
  });

  it("acknowledges messages in auto mode without killing the channel", async () => {
    const c = await connectedClient();
    const queueName = queue();
    const received: number[] = [];
    await c.subscribe<{ n: number }>("t.auto", (m) => void received.push(m.content.n), {
      queueName,
      ackMode: "auto",
    });
    let disconnects = 0;
    c.on("disconnected", () => disconnects++);

    await c.publish("t.auto", { n: 1 });
    await waitFor(() => received.length === 1, { message: "first message" });
    await c.publish("t.auto", { n: 2 });

    await waitFor(() => received.length === 2, { message: "second message" });
    expect(await admin.messageCount(queueName)).toBe(0);
    expect(disconnects).toBe(0);
  });

  it("rejects subscribe() when the broker refuses the queue, without a reconnect loop", async () => {
    const c = await connectedClient();
    const queueName = queue();
    const ch = await admin.channel();
    await ch.assertQueue(queueName, { arguments: { "x-max-length": 10 } });
    let disconnects = 0;
    c.on("error", () => {});
    c.on("disconnected", () => disconnects++);

    await expect(
      c.subscribe("t", () => {}, {
        queueName,
        ackMode: "manual",
        arguments: { "x-max-length": 5 },
      })
    ).rejects.toBeInstanceOf(SubscriptionError);

    // The 406 kills the channel once; the client recycles the connection once.
    await waitFor(() => disconnects === 1 && c.isConnected(), { message: "recovery" });
    await sleep(500);
    expect(disconnects).toBe(1);
  });

  it("keeps the subscription id valid across reconnects", async () => {
    const c = await connectedClient();
    const queueName = queue();
    let calls = 0;
    const id = await c.subscribe("t.stable", () => void calls++, {
      queueName,
      ackMode: "auto",
    });

    await reconnect(c);
    await c.unsubscribe(id);
    await c.publish("t.stable", {});
    await sleep(300);

    expect(calls).toBe(0);
  });

  it("does not restore a subscription that was unsubscribed while disconnected", async () => {
    const c = await connectedClient();
    const queueName = queue();
    let calls = 0;
    const id = await c.subscribe("t.gone", () => void calls++, {
      queueName,
      ackMode: "auto",
    });
    let reconnected = false;
    c.onReconnect(() => (reconnected = true));

    dropConnection(c);
    await waitFor(() => !c.isConnected(), { message: "disconnect" });
    await c.unsubscribe(id);
    await waitFor(() => reconnected, { message: "reconnect" });
    await c.publish("t.gone", {});
    await sleep(300);

    expect(calls).toBe(0);
  });

  it("restores fanout subscriptions under the same id", async () => {
    const c = await connectedClient();
    const eventType = uniq("fan");
    admin.trackExchange(`events.${eventType}`);
    const queueName = queue();
    let calls = 0;
    const id = await c.subscribeToFanout(eventType, () => void calls++, queueName, {
      ackMode: "auto",
    });

    await reconnect(c);
    await c.publishToFanout(eventType, {});
    await waitFor(() => calls === 1, { message: "fanout delivery after reconnect" });

    await c.unsubscribe(id);
    await c.publishToFanout(eventType, {});
    await sleep(300);
    expect(calls).toBe(1);
  });

  it("requeues a message when the handler throws and nobody listens for errors", async () => {
    const c = await connectedClient();
    const queueName = queue();
    let calls = 0;
    await c.subscribe(
      "t.flaky",
      async (m: Message) => {
        calls++;
        if (calls === 1) throw new Error("transient");
        await m.ack();
      },
      { queueName, ackMode: "manual" }
    );

    await c.publish("t.flaky", {});

    await waitFor(() => calls === 2, { message: "redelivery" });
  });

  it("does not double-ack when a manual handler acks and then throws", async () => {
    const c = await connectedClient();
    const queueName = queue();
    const received: number[] = [];
    await c.subscribe<{ n: number }>(
      "t.ackthrow",
      async (m) => {
        received.push(m.content.n);
        await m.ack();
        throw new Error("after ack");
      },
      { queueName, ackMode: "manual" }
    );
    let disconnects = 0;
    c.on("disconnected", () => disconnects++);

    await c.publish("t.ackthrow", { n: 1 });
    await waitFor(() => received.length === 1, { message: "first" });
    await c.publish("t.ackthrow", { n: 2 });
    await waitFor(() => received.length === 2, { message: "second" });

    expect(received).toEqual([1, 2]);
    expect(disconnects).toBe(0);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { Message, RabbitMQClient, SubscriptionError } from "../src";
import { BrokerAdmin, createClient, sleep, uniq, waitFor } from "./helpers";

class ValidationError extends Error {}

describe("RabbitMQClient retry and dead-lettering", () => {
  const admin = new BrokerAdmin();
  const clients: RabbitMQClient[] = [];
  let exchange: string;

  async function connectedClient() {
    exchange = uniq("x");
    admin.trackExchange(exchange);
    const c = createClient({ exchange });
    clients.push(c);
    await c.connect();
    return c;
  }

  /** Main queue plus the retry/dead-letter queues the client derives from it. */
  function queue(delays: number[] = []) {
    const name = uniq("q");
    admin.trackQueue(name, `${name}.dlq`, ...delays.map((d) => `${name}.retry.${d}`));
    return name;
  }

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.gracefulShutdown(100)));
    await admin.cleanup();
  });

  it("retries a failing handler after each configured delay", async () => {
    const c = await connectedClient();
    const delays = [100, 200];
    const queueName = queue(delays);
    const attempts: { at: number; retryCount?: number }[] = [];
    await c.subscribe(
      "t.retry",
      (m: Message) => {
        attempts.push({ at: Date.now(), retryCount: m.retryCount });
        if (attempts.length < 3) throw new Error("transient");
      },
      { queueName, ackMode: "auto", retry: { delays } }
    );

    await c.publish("t.retry", {});

    await waitFor(() => attempts.length === 3, { message: "third attempt" });
    expect(attempts.map((a) => a.retryCount)).toEqual([0, 1, 2]);
    expect(attempts[1].at - attempts[0].at).toBeGreaterThanOrEqual(90);
    expect(attempts[2].at - attempts[1].at).toBeGreaterThanOrEqual(190);
    await sleep(100);
    expect(await admin.messageCount(`${queueName}.dlq`)).toBe(0);
    expect(await admin.messageCount(queueName)).toBe(0);
  });

  it("parks the message in the dead-letter queue once retries are exhausted", async () => {
    const c = await connectedClient();
    const delays = [20, 20];
    const queueName = queue(delays);
    let calls = 0;
    await c.subscribe(
      "t.fail",
      () => {
        calls++;
        throw new Error("boom");
      },
      { queueName, ackMode: "manual", retry: { delays } }
    );

    await c.publish("t.fail", { id: 7 });

    const dlq = `${queueName}.dlq`;
    await waitFor(async () => (await admin.messageCount(dlq)) === 1, { message: "parked" });
    expect(calls).toBe(3);
    const parked = await admin.get(dlq);
    expect(parked).not.toBe(false);
    if (!parked) return;
    expect(JSON.parse(parked.content.toString())).toEqual({ id: 7 });
    expect(parked.properties.headers).toMatchObject({
      "x-retry-count": 2,
      "x-error": "boom",
      "x-original-routing-key": "t.fail",
      "x-original-queue": queueName,
    });
  });

  it("sends non-retryable errors straight to the dead-letter queue", async () => {
    const c = await connectedClient();
    const delays = [20];
    const queueName = queue(delays);
    let calls = 0;
    await c.subscribe(
      "t.invalid",
      () => {
        calls++;
        throw new ValidationError("bad input");
      },
      {
        queueName,
        ackMode: "auto",
        retry: { delays, nonRetryable: (err) => err instanceof ValidationError },
      }
    );

    await c.publish("t.invalid", {});

    await waitFor(async () => (await admin.messageCount(`${queueName}.dlq`)) === 1, {
      message: "parked",
    });
    expect(calls).toBe(1);
  });

  it("parks unparseable messages without calling the handler", async () => {
    const c = await connectedClient();
    const delays = [20];
    const queueName = queue(delays);
    let calls = 0;
    await c.subscribe("t.raw", () => void calls++, {
      queueName,
      ackMode: "auto",
      retry: { delays },
    });

    const ch = await admin.channel();
    ch.publish(exchange, "t.raw", Buffer.from("not json"));

    await waitFor(async () => (await admin.messageCount(`${queueName}.dlq`)) === 1, {
      message: "parked",
    });
    expect(calls).toBe(0);
  });

  it("delivers retries only to the failing queue, not to other subscribers", async () => {
    const c = await connectedClient();
    const delays = [20, 20];
    const failing = queue(delays);
    const other = queue();
    let failingCalls = 0;
    let otherCalls = 0;
    await c.subscribe(
      "t.shared",
      () => {
        failingCalls++;
        throw new Error("boom");
      },
      { queueName: failing, ackMode: "auto", retry: { delays } }
    );
    await c.subscribe("t.shared", () => void otherCalls++, {
      queueName: other,
      ackMode: "auto",
    });

    await c.publish("t.shared", {});

    await waitFor(() => failingCalls === 3, { message: "all attempts" });
    await sleep(100);
    expect(otherCalls).toBe(1);
  });

  it("requires a queueName when retry is enabled", async () => {
    const c = await connectedClient();

    await expect(
      c.subscribe("t.anon", () => {}, { ackMode: "auto", retry: { delays: [10] } })
    ).rejects.toBeInstanceOf(SubscriptionError);
  });

  it("replays parked messages back into the main queue", async () => {
    const c = await connectedClient();
    const delays = [20];
    const queueName = queue(delays);
    let broken = true;
    const handled: { n: number; retryCount?: number }[] = [];
    await c.subscribe<{ n: number }>(
      "t.replay",
      (m) => {
        if (broken) throw new Error("bug");
        handled.push({ n: m.content.n, retryCount: m.retryCount });
      },
      { queueName, ackMode: "auto", retry: { delays } }
    );
    await c.publish("t.replay", { n: 1 });
    await c.publish("t.replay", { n: 2 });
    const dlq = `${queueName}.dlq`;
    await waitFor(async () => (await admin.messageCount(dlq)) === 2, { message: "parked" });

    broken = false;
    const moved = await c.replayDeadLetters(dlq);

    expect(moved).toBe(2);
    await waitFor(() => handled.length === 2, { message: "replayed delivery" });
    expect(handled).toEqual([
      { n: 1, retryCount: 0 },
      { n: 2, retryCount: 0 },
    ]);
    expect(await admin.messageCount(dlq)).toBe(0);
  });

  describe("subscribeWithDLX", () => {
    function dlx() {
      const dlxExchange = uniq("dlx");
      const dlxQueue = uniq("dlq");
      admin.trackExchange(dlxExchange);
      admin.trackQueue(dlxQueue);
      return { dlxExchange, dlxQueue };
    }

    it("dead-letters a failed message to its own DLQ instead of requeueing forever", async () => {
      const c = await connectedClient();
      const queueName = queue();
      const { dlxExchange, dlxQueue } = dlx();
      let calls = 0;
      await c.subscribeWithDLX(
        "t.dlx",
        () => {
          calls++;
          throw new Error("boom");
        },
        dlxExchange,
        dlxQueue,
        { queueName, ackMode: "manual" }
      );

      await c.publish("t.dlx", {});

      await waitFor(async () => (await admin.messageCount(dlxQueue)) === 1, {
        message: "dead-lettered",
      });
      await sleep(200);
      expect(calls).toBe(1);
    });

    it("does not apply the main queue's arguments to the DLQ", async () => {
      const c = await connectedClient();
      const queueName = queue();
      const { dlxExchange, dlxQueue } = dlx();
      await c.subscribeWithDLX(
        "t.ttl",
        () => {
          throw new Error("boom");
        },
        dlxExchange,
        dlxQueue,
        { queueName, ackMode: "manual", arguments: { "x-message-ttl": 300 } }
      );

      await c.publish("t.ttl", {});
      await waitFor(async () => (await admin.messageCount(dlxQueue)) === 1, {
        message: "dead-lettered",
      });
      await sleep(600);

      expect(await admin.messageCount(dlxQueue)).toBe(1);
    });

    it("parks in its DLQ once retries are exhausted", async () => {
      const c = await connectedClient();
      const delays = [20];
      const queueName = queue(delays);
      const { dlxExchange, dlxQueue } = dlx();
      let calls = 0;
      await c.subscribeWithDLX(
        "t.dlxretry",
        () => {
          calls++;
          throw new Error("boom");
        },
        dlxExchange,
        dlxQueue,
        { queueName, ackMode: "auto", retry: { delays } }
      );

      await c.publish("t.dlxretry", {});

      await waitFor(async () => (await admin.messageCount(dlxQueue)) === 1, {
        message: "dead-lettered",
      });
      expect(calls).toBe(2);
    });
  });
});

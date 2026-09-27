import * as amqplib from "amqplib";
import { randomUUID } from "crypto";
import { RabbitMQClient, RabbitMQConfig } from "../src";

// Tests run against a real broker. Override with AMQP_URL=amqp://user:pass@host:5672
export const AMQP_URL = process.env.AMQP_URL ?? "amqp://localhost";

/** Unique, prefixed name so tests never collide with each other or with real queues. */
export function uniq(label: string): string {
  return `test.${label}.${randomUUID().slice(0, 8)}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeout = 10000, interval = 25, message = "condition" } = {}
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(interval);
  }
  throw new Error(`Timed out after ${timeout}ms waiting for ${message}`);
}

/**
 * A raw amqplib connection used to arrange and inspect broker state,
 * plus cleanup of everything the test declared.
 */
export class BrokerAdmin {
  private conn: amqplib.Connection | null = null;
  private queues = new Set<string>();
  private exchanges = new Set<string>();

  async channel(): Promise<amqplib.Channel> {
    if (!this.conn) {
      const url = new URL(AMQP_URL);
      url.searchParams.set("frameMax", "131072");
      this.conn = await amqplib.connect(url.toString());
    }
    // A fresh channel per call: a 404/406 from a check closes only that channel.
    return this.conn.createChannel();
  }

  trackQueue(...names: string[]): void {
    names.forEach((n) => this.queues.add(n));
  }

  trackExchange(...names: string[]): void {
    names.forEach((n) => this.exchanges.add(n));
  }

  /** Number of ready messages in a queue, or -1 if it doesn't exist. */
  async messageCount(queue: string): Promise<number> {
    const ch = await this.channel();
    try {
      const { messageCount } = await ch.checkQueue(queue);
      await ch.close();
      return messageCount;
    } catch {
      return -1;
    }
  }

  async queueExists(queue: string): Promise<boolean> {
    return (await this.messageCount(queue)) >= 0;
  }

  /** Fetch (and ack) a single message from a queue. */
  async get(queue: string): Promise<amqplib.GetMessage | false> {
    const ch = await this.channel();
    const msg = await ch.get(queue, { noAck: true });
    await ch.close();
    return msg;
  }

  async cleanup(): Promise<void> {
    if (!this.conn) {
      if (this.queues.size === 0 && this.exchanges.size === 0) return;
    }
    for (const q of this.queues) {
      const ch = await this.channel();
      await ch.deleteQueue(q).catch(() => {});
      await ch.close().catch(() => {});
    }
    for (const x of this.exchanges) {
      const ch = await this.channel();
      await ch.deleteExchange(x).catch(() => {});
      await ch.close().catch(() => {});
    }
    await this.conn?.close().catch(() => {});
    this.conn = null;
    this.queues.clear();
    this.exchanges.clear();
  }
}

/** Fast reconnect settings so failure-path tests finish quickly. */
export const FAST_RECONNECT = {
  reconnectInterval: 20,
  reconnectBackoffMultiplier: 1,
  maxReconnectDelay: 50,
} satisfies Partial<RabbitMQConfig>;

export function createClient(
  overrides: Partial<RabbitMQConfig> & { exchange: string }
): RabbitMQClient {
  return new RabbitMQClient({ url: AMQP_URL, ...FAST_RECONNECT, ...overrides });
}

/** Simulate a network failure by destroying the client's socket. */
export function dropConnection(client: RabbitMQClient): void {
  const model = (client as any).connection;
  if (!model) throw new Error("client is not connected");
  // amqplib watches the socket's 'error'/'end' events, not 'close'.
  model.connection.stream.destroy(new Error("simulated network failure"));
}

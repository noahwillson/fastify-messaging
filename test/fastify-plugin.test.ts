import Fastify5, { FastifyInstance } from "fastify";
import Fastify4 from "fastify4";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionError,
  FastifyMessagingOptions,
  fastifyMessaging,
  MessagingLogger,
  RabbitMQClient,
} from "../src";
import { BrokerAdmin, createClient, sleep, uniq, waitFor } from "./helpers";

const UNREACHABLE = "amqp://127.0.0.1:1";

type LogLine = { level: number; msg: string };

const versions = [
  ["Fastify 5", Fastify5],
  ["Fastify 4", Fastify4],
] as const;

describe.each(versions)("fastifyMessaging on %s", (_name, Fastify) => {
  const admin = new BrokerAdmin();
  const apps: FastifyInstance[] = [];
  const clients: RabbitMQClient[] = [];

  function buildApp(logLines?: LogLine[]): FastifyInstance {
    const logger = logLines
      ? { level: "info", stream: { write: (line: string) => void logLines.push(JSON.parse(line)) } }
      : false;
    // Both majors share the plugin-facing API; type them as the v5 instance.
    const app = (Fastify as typeof Fastify5)({ logger }) as FastifyInstance;
    apps.push(app);
    return app;
  }

  function client(overrides: Partial<Parameters<typeof createClient>[0]> = {}) {
    const exchange = uniq("x");
    admin.trackExchange(exchange);
    const c = createClient({ exchange, ...overrides });
    clients.push(c);
    return c;
  }

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close().catch(() => {})));
    await Promise.all(clients.splice(0).map((c) => c.gracefulShutdown(100)));
    await admin.cleanup();
  });

  it("registers and connects the client", async () => {
    const app = buildApp();
    const c = client();

    await app.register(fastifyMessaging, { client: c });
    await app.ready();

    expect(app.messaging.isConnected()).toBe(true);
    expect(app.messaging.getConnectionStatus().connected).toBe(true);
  });

  it("publishes and subscribes through fastify.messaging", async () => {
    const app = buildApp();
    const queueName = uniq("q");
    admin.trackQueue(queueName);
    await app.register(fastifyMessaging, { client: client() });
    await app.ready();
    const received: unknown[] = [];

    await app.messaging.subscribe("t.plugin", (m) => void received.push(m.content), {
      queueName,
      ackMode: "auto",
    });
    await app.messaging.publish("t.plugin", { hello: "fastify" });

    await waitFor(() => received.length === 1, { message: "delivery" });
    expect(received).toEqual([{ hello: "fastify" }]);
  });

  it("shuts the client down when the app closes, with the configured timeout", async () => {
    const app = buildApp();
    const c = client();
    const shutdown = vi.spyOn(c, "gracefulShutdown");
    const options: FastifyMessagingOptions = { client: c, shutdownTimeout: 1234 };
    await app.register(fastifyMessaging, options);
    await app.ready();

    await app.close();

    expect(shutdown).toHaveBeenCalledWith(1234);
    expect(c.isConnected()).toBe(false);
  });

  it("boots without a broker by default and reports the connection as down", async () => {
    const app = buildApp();
    const c = client({ url: UNREACHABLE, maxReconnectAttempts: 1 });

    await app.register(fastifyMessaging, { client: c });
    await app.ready();

    expect(app.messaging.isConnected()).toBe(false);
  });

  it("fails to boot with requireConnection when the broker is unreachable", async () => {
    const app = buildApp();
    const c = client({ url: UNREACHABLE });

    // Not awaiting register(): the error must surface from ready()/listen().
    app.register(fastifyMessaging, { client: c, requireConnection: true });

    await expect(app.ready()).rejects.toBeInstanceOf(ConnectionError);
    // It must not keep retrying in the background after boot failed.
    await sleep(200);
    expect(c.getConnectionStatus().retryCount).toBe(0);
  });

  it("routes client logs to the Fastify logger", async () => {
    const lines: LogLine[] = [];
    const app = buildApp(lines);
    const c = client({ url: UNREACHABLE, maxReconnectAttempts: 0 });

    await app.register(fastifyMessaging, { client: c });
    await app.ready();

    const errors = lines.filter((l) => l.level >= 50);
    expect(errors.some((l) => /Connection error/.test(l.msg))).toBe(true);
  });

  it("keeps a logger the client was configured with", async () => {
    const lines: LogLine[] = [];
    const app = buildApp(lines);
    const own: MessagingLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const c = client({ url: UNREACHABLE, maxReconnectAttempts: 0, logger: own });

    await app.register(fastifyMessaging, { client: c });
    await app.ready();

    expect(own.error).toHaveBeenCalledWith(expect.stringMatching(/Connection error/));
    expect(lines.some((l) => /Connection error/.test(l.msg))).toBe(false);
  });
});

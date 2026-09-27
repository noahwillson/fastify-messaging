import express5 from "express";
import express4 from "express4";
import { AddressInfo } from "net";
import { Server } from "http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionError,
  ExpressMessagingOptions,
  expressMessaging,
  MessagingLogger,
  RabbitMQClient,
} from "../src/express";
import { BrokerAdmin, createClient, sleep, uniq, waitFor } from "./helpers";

const UNREACHABLE = "amqp://127.0.0.1:1";

const versions = [
  ["Express 5", express5],
  ["Express 4", express4],
] as const;

describe.each(versions)("expressMessaging on %s", (_name, express) => {
  const admin = new BrokerAdmin();
  const clients: RabbitMQClient[] = [];
  const servers: Server[] = [];

  function client(overrides: Partial<Parameters<typeof createClient>[0]> = {}) {
    const exchange = uniq("x");
    admin.trackExchange(exchange);
    const c = createClient({ exchange, ...overrides });
    clients.push(c);
    return c;
  }

  function newApp() {
    // Both majors expose the same app API used here; type them as v5.
    return (express as typeof express5)();
  }

  async function listen(app: ReturnType<typeof newApp>): Promise<string> {
    const server = app.listen(0);
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve)))
    );
    await Promise.all(clients.splice(0).map((c) => c.gracefulShutdown(100)));
    await admin.cleanup();
  });

  it("connects and exposes messaging on app.locals and req", async () => {
    const app = newApp();
    const c = client();

    const messaging = await expressMessaging(app, { client: c });

    expect(messaging.isConnected()).toBe(true);
    expect(app.locals.messaging).toBe(messaging);
    app.get("/status", (req, res) => void res.json(req.messaging.getConnectionStatus()));
    const res = await fetch(`${await listen(app)}/status`);
    expect(await res.json()).toMatchObject({ connected: true });
  });

  it("publishes from a route handler", async () => {
    const app = newApp();
    const c = client();
    const queueName = uniq("q");
    admin.trackQueue(queueName);
    const messaging = await expressMessaging(app, { client: c });
    const received: unknown[] = [];
    await messaging.subscribe("t.express", (m) => void received.push(m.content), {
      queueName,
      ackMode: "auto",
    });
    app.post("/orders", async (req, res) => {
      await req.messaging.publish("t.express", { id: 1 });
      res.status(202).end();
    });

    const res = await fetch(`${await listen(app)}/orders`, { method: "POST" });

    expect(res.status).toBe(202);
    await waitFor(() => received.length === 1, { message: "delivery" });
    expect(received).toEqual([{ id: 1 }]);
  });

  it("boots without a broker by default", async () => {
    const app = newApp();
    const c = client({ url: UNREACHABLE, maxReconnectAttempts: 1 });

    const messaging = await expressMessaging(app, { client: c });

    expect(messaging.isConnected()).toBe(false);
  });

  it("rejects with requireConnection when the broker is unreachable", async () => {
    const app = newApp();
    const c = client({ url: UNREACHABLE });

    await expect(expressMessaging(app, { client: c, requireConnection: true })).rejects.toBeInstanceOf(
      ConnectionError
    );
    await sleep(200);
    expect(c.getConnectionStatus().retryCount).toBe(0);
  });

  it("shuts the client down with the configured timeout", async () => {
    const app = newApp();
    const c = client();
    const shutdown = vi.spyOn(c, "gracefulShutdown");
    const options: ExpressMessagingOptions = { client: c, shutdownTimeout: 1234 };
    const messaging = await expressMessaging(app, options);

    await messaging.shutdown();

    expect(shutdown).toHaveBeenCalledWith(1234);
    expect(c.isConnected()).toBe(false);
  });

  it("uses the given logger unless the client already has one", async () => {
    const app = newApp();
    const logger: MessagingLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const c = client({ url: UNREACHABLE, maxReconnectAttempts: 0 });

    await expressMessaging(app, { client: c, logger });

    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/Connection error/));
  });
});

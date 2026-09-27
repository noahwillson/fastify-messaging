import { afterEach, describe, expect, it } from "vitest";
import { RabbitMQClient } from "../src/core";
import { createClient, uniq, waitFor } from "./helpers";

/** Timers that keep the Node event loop alive (unref'd timers are not listed). */
function refTimers(): number {
  return process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
}

describe("RabbitMQClient in a plain Node process", () => {
  const clients: RabbitMQClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.gracefulShutdown(100)));
  });

  it("does not keep the process alive just by being constructed", () => {
    const before = refTimers();

    clients.push(createClient({ exchange: uniq("x") }));

    expect(refTimers()).toBe(before);
  });

  it("does not keep the process alive after giving up on the broker", async () => {
    const before = refTimers();
    const c = createClient({
      url: "amqp://127.0.0.1:1",
      exchange: uniq("x"),
      maxReconnectAttempts: 1,
    });
    clients.push(c);

    await c.connect();
    await waitFor(() => c.getConnectionStatus().permanentFailure, {
      message: "permanent failure",
    });

    expect(refTimers()).toBe(before);
  });
});

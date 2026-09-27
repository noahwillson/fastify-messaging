import { describe, expect, it } from "vitest";
import { MessagingClient } from "../src";

class StubClient extends MessagingClient {
  connect = async () => {};
  publish = async () => true;
  publishToFanout = async () => true;
  subscribe = async () => "id";
  subscribeToFanout = async () => "id";
  subscribeWithDLX = async () => "id";
  onReconnect = () => {};
  unsubscribe = async () => {};
  close = async () => {};
  gracefulShutdown = async () => {};

  fail(error: Error) {
    this.handleError(error, "stub");
  }
}

describe("MessagingClient", () => {
  it("does not throw from handleError when nobody listens for errors", () => {
    const client = new StubClient({ url: "amqp://unused", exchange: "unused" });

    expect(() => client.fail(new Error("boom"))).not.toThrow();
  });

  it("delivers errors to registered listeners", () => {
    const client = new StubClient({ url: "amqp://unused", exchange: "unused" });
    const seen: Error[] = [];
    client.on("error", (e) => seen.push(e));

    client.fail(new Error("boom"));

    expect(seen.map((e) => e.message)).toEqual(["boom"]);
  });
});

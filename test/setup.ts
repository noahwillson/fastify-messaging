import { vi } from "vitest";

// The client logs every reconnect attempt and handler failure; keep test output readable.
// Set DEBUG_LOGS=1 to see them.
if (!process.env.DEBUG_LOGS) {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
}

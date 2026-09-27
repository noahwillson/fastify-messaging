import { MessagingClient } from "../core/messaging-client";
import { createMessaging, Messaging, startClient } from "../core/messaging";
import { MessagingLogger } from "../core/types";

export interface ExpressMessagingOptions {
  client: MessagingClient;
  /**
   * Reject when the broker is unreachable at startup (and stop reconnecting).
   * Default false: resolves anyway and the client keeps reconnecting in the background.
   */
  requireConnection?: boolean;
  /** Logger for client logs, used unless the client already has one. Default: console. */
  logger?: MessagingLogger;
  /** Max ms to wait for in-flight messages in shutdown(). Default 5000. */
  shutdownTimeout?: number;
}

export interface ExpressMessaging extends Messaging {
  /** Wait for in-flight messages and close the connection. Call it on SIGTERM. */
  shutdown(): Promise<void>;
}

/**
 * The parts of an Express app the adapter uses. Structural, so the package needs no
 * express typings and works with Express 4 and 5.
 */
export interface ExpressAppLike {
  locals: Record<string, any>;
  use(handler: (req: any, res: any, next: () => void) => void): unknown;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by expressMessaging() for routes registered after it. */
      messaging: ExpressMessaging;
    }
  }
}

/**
 * Connect the client and make it available as `app.locals.messaging` and `req.messaging`.
 * Call it before registering routes that use `req.messaging`.
 * Express has no shutdown hook, so call `shutdown()` yourself (e.g. on SIGTERM).
 */
export async function expressMessaging(
  app: ExpressAppLike,
  options: ExpressMessagingOptions
): Promise<ExpressMessaging> {
  const { client } = options;
  await startClient(client, options);

  const messaging: ExpressMessaging = {
    ...createMessaging(client),
    shutdown: () => client.gracefulShutdown(options.shutdownTimeout),
  };

  app.locals.messaging = messaging;
  app.use((req, _res, next) => {
    req.messaging = messaging;
    next();
  });

  return messaging;
}

import { ConsumeMessage } from "amqplib";

export interface MessageOptions {
  headers?: Record<string, string | number | boolean>;
  contentType?: string;
  contentEncoding?: string;
  persistent?: boolean;
  expiration?: string | number; // TTL in milliseconds
  priority?: number; // Message priority (0-255)
  correlationId?: string;
  replyTo?: string;
  messageId?: string;
  ttl?: number | string;
  timestamp?: number;
  [key: string]: any;
}

export interface Message<T = any> {
  content: T;
  routingKey: string;
  options?: MessageOptions;
  originalMessage?: ConsumeMessage; // Provider-specific message object
  timestamp?: Date;
  messageId?: string;
  ack(): Promise<void>;
  nack(requeue?: boolean): Promise<void>;
  reject(requeue?: boolean): Promise<void>;
}

export interface SubscriptionOptions {
  queueName?: string;
  exclusive?: boolean;
  durable?: boolean;
  autoDelete?: boolean;
  prefetch?: number;
  ackMode: "auto" | "manual";
  exchangeName?: string; // Custom exchange name to override the default
  arguments?: {
    "x-message-ttl"?: number;
    "x-expires"?: number;
    "x-max-length"?: number;
    "x-max-length-bytes"?: number;
    "x-overflow"?: "drop-head" | "reject-publish";
    "x-dead-letter-exchange"?: string;
    "x-dead-letter-routing-key"?: string;
    "x-single-active-consumer"?: boolean;
    "x-max-priority"?: number;
    [key: string]: any;
  };
}

export interface MessageHandler<T = any> {
  (message: Message<T>): Promise<void> | void;
}

export interface MessagingConfig {
  url: string;
  exchange: string;
  exchangeType?: "direct" | "topic" | "fanout" | "headers";
  prefetch?: number;
  reconnectInterval?: number;
  vhost?: string;
  heartbeat?: number;
  connectionTimeout?: number;
  queueOptions?: {
    durable?: boolean;
    exclusive?: boolean;
    autoDelete?: boolean;
    arguments?: Record<string, unknown>;
  };
  exchangeOptions?: {
    alternateExchange?: string;
    arguments?: Record<string, unknown>;
    durable?: boolean;
    internal?: boolean;
    autoDelete?: boolean;
  };
  [key: string]: any;
}

export interface FanoutSubscriptionOptions extends SubscriptionOptions {
  eventType: string; // Event type for fanout exchange
}

export interface MessageResponse {
  success: boolean;
  error?: Error;
  messageId?: string;
}

export type ConnectionStatus =
  | "connected"
  | "disconnected"
  | "connecting"
  | "error";

/**
 * Type definition for message publishing function
 */
export interface PublishFunction {
  <T>(topic: string, message: T, options?: MessageOptions): Promise<boolean>;
}

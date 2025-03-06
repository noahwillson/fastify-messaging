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
  timestamp?: number;
  [key: string]: any;
}

export interface Message<T = any> {
  content: T;
  routingKey: string;
  options?: MessageOptions;
  originalMessage?: any; // Provider-specific message object
}

export interface SubscriptionOptions {
  queueName?: string;
  exclusive?: boolean;
  durable?: boolean;
  autoDelete?: boolean;
  prefetch?: number;
  arguments?: any; // RabbitMQ-specific queue arguments
  [key: string]: any;
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
  queueOptions?: {
    durable?: boolean;
    exclusive?: boolean;
    autoDelete?: boolean;
    arguments?: any;
  };
  exchangeOptions?: {
    alternateExchange?: string;
    arguments?: any;
  };
  serialize?: (message: any) => Buffer;
  deserialize?: (buffer: Buffer) => any;
  [key: string]: any;
}

export interface FanoutSubscriptionOptions extends SubscriptionOptions {
  eventType: string; // Event type for fanout exchange
}

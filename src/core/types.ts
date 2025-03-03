export interface MessageOptions {
  headers?: Record<string, string | number | boolean>;
  contentType?: string;
  contentEncoding?: string;
  persistent?: boolean;
  expiration?: string | number;
  priority?: number;
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
  [key: string]: any;
}

export interface MessageHandler<T = any> {
  (message: Message<T>): Promise<void> | void;
}

export interface MessagingConfig {
  reconnectInterval?: number;
  [key: string]: any;
}

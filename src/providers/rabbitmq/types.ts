import { MessagingConfig } from "../../core/types";

export interface RabbitMQConfig extends MessagingConfig {
  url: string;
  exchange: string;
  exchangeType?: "direct" | "topic" | "fanout" | "headers";
  prefetch?: number;
  vhost?: string;
  heartbeat?: number;
  connectionTimeout?: number;
  maxReconnectAttempts?: number;
  reconnectBackoffMultiplier?: number;
  maxReconnectDelay?: number;
  getExchangeName?: (eventType: string) => string;
  getQueueName?: (eventType: string, queueName?: string) => string;
  queueOptions?: {
    durable?: boolean;
    exclusive?: boolean;
    autoDelete?: boolean;
    arguments?: any;
  };
  deadLetterExchange?: string;
  deadLetterQueue?: string;
  exchangeOptions?: {
    alternateExchange?: string;
    arguments?: any;
  };
  initialConnectionRetries?: number; // Number of initial connection attempts
  initialConnectionDelay?: number; // Delay between initial connection attempts in ms
}

export type RabbitMQEvents =
  | "connected"
  | "disconnected"
  | "reconnected"
  | "error"
  | "connection_permanently_down";

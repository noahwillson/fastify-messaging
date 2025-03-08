import { MessagingConfig } from "../../core/types";

export interface RabbitMQConfig extends MessagingConfig {
  url: string;
  exchange: string;
  exchangeType?: "direct" | "topic" | "fanout" | "headers";
  prefetch?: number;
  vhost?: string;
  heartbeat?: number;
  connectionTimeout?: number;
  getExchangeName?: (eventType: string) => string;
  getQueueName?: (eventType: string, queueName?: string) => string;
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
}

export type RabbitMQEvents =
  | "connected"
  | "disconnected"
  | "reconnected"
  | "error";

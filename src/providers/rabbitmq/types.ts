import { MessagingConfig } from "../../core/types";

export interface RabbitMQConfig extends MessagingConfig {
  url: string;
  exchange: string;
  exchangeType?: "direct" | "topic" | "fanout" | "headers";
  prefetch?: number;
  vhost?: string;
  heartbeat?: number;
  connectionTimeout?: number;
}

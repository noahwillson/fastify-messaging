// src/core/errors.ts
export class MessagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessagingError";
  }
}

export class ConnectionError extends MessagingError {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionError";
  }
}

export class PublishError extends MessagingError {
  constructor(message: string) {
    super(message);
    this.name = "PublishError";
  }
}

export class SubscriptionError extends MessagingError {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionError";
  }
}

export interface WorkflowErrorOptions {
  code?: string;
  /** What the external system itself reported, kept apart from your own `message`. */
  detail?: string;
  /** The provider operation this failure is about. */
  operation?: string;
}

export interface RetryableErrorOptions extends WorkflowErrorOptions {
  retryAfterMs?: number;
}

export abstract class WorkflowError extends Error {
  abstract readonly retryable: boolean;
  readonly code: string;
  readonly detail?: string;
  readonly operation?: string;

  constructor(message: string, options: WorkflowErrorOptions = {}) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? new.target.name;
    this.detail = options.detail;
    this.operation = options.operation;
  }
}

export class RetryableError extends WorkflowError {
  readonly retryable = true;
  readonly retryAfterMs?: number;

  constructor(message: string, options: RetryableErrorOptions = {}) {
    super(message, options);
    this.retryAfterMs = options.retryAfterMs;
  }
}

export class NonRetryableError extends WorkflowError {
  readonly retryable = false;
}

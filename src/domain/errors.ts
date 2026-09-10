import { isPlatformErrorKind, type CommentErrorCode, type Platform, type PlatformErrorKind } from './types.js';

export type { PlatformErrorKind };

/**
 * Errors raised by the application layer. The HTTP layer maps `code` to a status.
 * Keeping HTTP concerns out of here lets the same services back a queue worker or a CLI.
 */
export type DomainErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'validation_error'
  | 'post_not_published'
  | 'account_not_connected'
  | 'platform_not_supported'
  | 'reply_in_progress'
  | 'idempotency_key_reused'
  | 'reply_target_not_published';

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, id: string) {
    super('not_found', `${resource} ${id} not found`, { resource, id });
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('validation_error', message, details);
    this.name = 'ValidationError';
  }
}

export class PlatformError extends Error {
  constructor(
    readonly platform: Platform,
    readonly kind: PlatformErrorKind,
    message: string,
    readonly options: { retryable?: boolean; retryAfterSeconds?: number; raw?: unknown } = {},
  ) {
    super(message);
    this.name = 'PlatformError';
  }

  get retryable(): boolean {
    return this.options.retryable ?? (this.kind === 'rate_limited' || this.kind === 'unavailable');
  }

  /** True when we cannot know whether the platform applied the request (timeouts, 5xx). */
  get outcomeUnknown(): boolean {
    return this.kind === 'unavailable' || this.kind === 'unknown';
  }

  get retryAfterSeconds(): number | undefined {
    return this.options.retryAfterSeconds;
  }

  /** Public code shared by HTTP responses and stored delivery errors. */
  get code(): CommentErrorCode {
    return `platform_${this.kind}`;
  }
}

/** Reverse of PlatformError.code, for replaying a stored failure. */
export function platformKindFromCode(code: string): PlatformErrorKind {
  const kind = code.startsWith('platform_') ? code.slice('platform_'.length) : code;
  return isPlatformErrorKind(kind) ? kind : 'unknown';
}

/**
 * What a client may see about a failure. Domain and platform messages are safe; anything
 * else (driver errors, TypeErrors) is reported generically and kept in the logs.
 */
export function toPublicError(err: unknown): { code: string; message: string } {
  if (err instanceof DomainError) return { code: err.code, message: err.message };
  if (err instanceof PlatformError) return { code: err.code, message: err.message };
  return { code: 'internal', message: 'internal error' };
}

/** Thrown by repositories on unique-constraint violations so services can react to races. */
export class UniqueViolationError extends Error {
  constructor(readonly constraint: string) {
    super(`unique constraint violated: ${constraint}`);
    this.name = 'UniqueViolationError';
  }
}

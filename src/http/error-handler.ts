import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { DomainError, PlatformError, type DomainErrorCode, type PlatformErrorKind } from '../domain/errors.js';

/**
 * Single place where domain and platform failures become HTTP responses.
 * Body shape everywhere: { error: { code, message, details } }.
 *
 * Why not RFC 7807 problem+json: the clients of this API are our own UI and SDKs, which
 * already consume the `{ error }` envelope of the rest of the product; one envelope beats two.
 * The mapping is a table, so switching later is a local change.
 */
const DOMAIN_STATUS: Record<DomainErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  validation_error: 422,
  post_not_published: 409,
  account_not_connected: 409,
  platform_not_supported: 422,
  reply_in_progress: 409,
  idempotency_key_reused: 422,
  reply_target_not_published: 409,
};

const PLATFORM_STATUS: Record<PlatformErrorKind, number> = {
  auth: 502,
  rate_limited: 429,
  not_found: 404,
  rejected: 422,
  unavailable: 502,
  unknown: 502,
};

export function errorBody(code: string, message: string, details: Record<string, unknown> = {}) {
  return { error: { code, message, details } };
}

export function errorHandler(error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply): void {
  if (error instanceof DomainError) {
    if (error.code === 'unauthorized') void reply.header('www-authenticate', 'Bearer');
    void reply.code(DOMAIN_STATUS[error.code]).send(errorBody(error.code, error.message, error.details));
    return;
  }

  if (error instanceof PlatformError) {
    if (error.retryAfterSeconds) void reply.header('retry-after', String(error.retryAfterSeconds));
    void reply.code(PLATFORM_STATUS[error.kind]).send(
      errorBody(error.code, error.message, {
        platform: error.platform,
        retryable: error.retryable,
        outcomeUnknown: error.outcomeUnknown,
        ...(error.kind === 'auth' ? { action: 'reconnect_account' } : {}),
      }),
    );
    return;
  }

  if (error instanceof ZodError) {
    void reply.code(400).send(
      errorBody('bad_request', 'Request validation failed', {
        issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      }),
    );
    return;
  }

  // Errors raised by Fastify itself or by plugins (malformed JSON, payload too large, rate limit).
  // Their internal codes stay in details; `error.code` keeps the API's own vocabulary.
  const fastifyError = error as FastifyError & { details?: Record<string, unknown> };
  if (typeof fastifyError.statusCode === 'number' && fastifyError.statusCode < 500) {
    const code = fastifyError.statusCode === 429 ? 'rate_limited' : 'bad_request';
    void reply
      .code(fastifyError.statusCode)
      .send(errorBody(code, error.message, { ...fastifyError.details, originalCode: fastifyError.code }));
    return;
  }

  request.log.error({ err: error }, 'unhandled error');
  void reply.code(500).send(errorBody('internal_error', 'Internal server error'));
}

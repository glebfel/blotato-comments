import { PlatformError, type PlatformErrorKind } from '../domain/errors.js';
import type { Platform } from '../domain/types.js';

/**
 * Minimal HTTP client abstraction so adapters can be unit-tested with canned responses
 * and so retries / instrumentation can be added in one place later.
 */
export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  json: unknown;
}

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

/** fetch-based client; the timeout is configuration (PLATFORM_HTTP_TIMEOUT_MS), not a constant in adapters. */
export function createFetchHttpClient(options: { timeoutMs?: number } = {}): HttpClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  return async (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? timeoutMs);
    try {
      const res = await fetch(request.url, {
        method: request.method,
        headers: {
          accept: 'application/json',
          ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...request.headers,
        },
        body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let json: unknown = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = { raw: text };
        }
      }
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return { status: res.status, headers, json };
    } finally {
      clearTimeout(timer);
    }
  };
}

export const fetchHttpClient: HttpClient = createFetchHttpClient();

/** Wraps transport-level failures (DNS, timeout, reset) into a retryable PlatformError. */
export async function send(platform: Platform, http: HttpClient, request: HttpRequest): Promise<HttpResponse> {
  try {
    return await http(request);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PlatformError(platform, 'unavailable', `${platform} request failed: ${message}`, {
      retryable: true,
      raw: err,
    });
  }
}

/** Platform-specific refinement of the generic status mapping (e.g. a 403 that really means "duplicate"). */
export type ErrorClassifier = (response: HttpResponse) => PlatformErrorKind | null;

/** Shared HTTP status -> PlatformError mapping. Adapters call this for any non-2xx response. */
export function throwForStatus(
  platform: Platform,
  response: HttpResponse,
  context: string,
  classify?: ErrorClassifier,
): never {
  const detail = extractMessage(response.json);
  const message = `${platform} ${context} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`;
  const retryAfterHeader = response.headers['retry-after'];
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) || undefined : undefined;
  const kind = classify?.(response) ?? kindForStatus(response.status);
  throw new PlatformError(platform, kind, message, {
    raw: response.json,
    retryAfterSeconds,
    retryable: kind === 'rate_limited' || kind === 'unavailable',
  });
}

function kindForStatus(status: number): PlatformErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'unavailable';
  if (status >= 400) return 'rejected';
  return 'unknown';
}

export function extractMessage(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  // X: { title, detail } | Google: { error: { message } } | generic: { message }
  if (typeof obj.detail === 'string') return obj.detail;
  if (typeof obj.title === 'string') return obj.title;
  if (typeof obj.message === 'string') return obj.message;
  const nested = obj.error;
  if (nested && typeof nested === 'object' && typeof (nested as Record<string, unknown>).message === 'string') {
    return (nested as Record<string, unknown>).message as string;
  }
  return null;
}

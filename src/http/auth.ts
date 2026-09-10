import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { DomainError } from '../domain/errors.js';

/**
 * API-key authentication. Every request is scoped to exactly one workspace (tenant) and
 * all repository queries filter by it; there is no way to reach another tenant's data by id.
 *
 * Keys are looked up by SHA-256 digest: the resolver never holds plaintext keys, and a Map
 * keyed by digest cannot be tricked by prototype names (`constructor`, `__proto__`).
 * Production adds scopes (comments:read / comments:write) and a cache in front of the store.
 */
export interface ApiKeyResolver {
  resolve(apiKey: string): Promise<string | null>;
}

export class StaticApiKeyResolver implements ApiKeyResolver {
  private readonly workspaceByDigest = new Map<string, string>();

  /** @param keys plaintext api key -> workspace id */
  constructor(keys: Record<string, string>) {
    for (const [key, workspaceId] of Object.entries(keys)) this.workspaceByDigest.set(digest(key), workspaceId);
  }

  async resolve(apiKey: string): Promise<string | null> {
    return this.workspaceByDigest.get(digest(apiKey)) ?? null;
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

declare module 'fastify' {
  interface FastifyRequest {
    workspaceId: string;
  }
}

export function authenticate(resolver: ApiKeyResolver) {
  return async (request: FastifyRequest): Promise<void> => {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    const workspaceId = token ? await resolver.resolve(token) : null;
    if (!workspaceId) throw new DomainError('unauthorized', 'Missing or invalid API key');
    request.workspaceId = workspaceId;
  };
}

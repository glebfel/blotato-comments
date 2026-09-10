import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import pino from 'pino';
import type { CommentService } from '../services/comment-service.js';
import { authenticate, type ApiKeyResolver } from './auth.js';
import { errorBody, errorHandler } from './error-handler.js';
import { registerCommentRoutes } from './routes.js';

export interface RateLimitConfig {
  /** Requests per minute per workspace across the whole API. */
  perMinute: number;
  syncPerMinute: number;
  replyPerMinute: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = { perMinute: 600, syncPerMinute: 10, replyPerMinute: 60 };

export interface AppDeps {
  comments: CommentService;
  apiKeys: ApiKeyResolver;
  logger?: pino.Logger;
  rateLimits?: Partial<RateLimitConfig>;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  // pino.Logger is a superset of FastifyBaseLogger; widening here keeps the instance type generic-free.
  const loggerInstance: FastifyBaseLogger = deps.logger ?? pino({ level: 'silent' });
  const app = Fastify({ loggerInstance });
  const limits = { ...DEFAULT_RATE_LIMITS, ...deps.rateLimits };
  app.decorateRequest('workspaceId', '');
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send(errorBody('not_found', `Route ${request.method} ${request.url} not found`));
  });

  app.get('/health', async () => ({ status: 'ok' }));

  app.register(
    async (v1) => {
      v1.addHook('onRequest', authenticate(deps.apiKeys));
      // Registered after the auth hook so limits are per workspace, not per IP.
      await v1.register(rateLimit, {
        max: limits.perMinute,
        timeWindow: '1 minute',
        keyGenerator: (request) => request.workspaceId || request.ip,
        // The plugin throws whatever this returns; the error handler renders it in the common shape.
        errorResponseBuilder: (_request, context) =>
          Object.assign(new Error(`Rate limit exceeded, retry in ${context.after}`), {
            statusCode: 429,
            details: { limit: context.max, retryAfterMs: context.ttl },
          }),
      });
      registerCommentRoutes(v1, deps.comments, limits);
    },
    { prefix: '/v1' },
  );

  return app;
}

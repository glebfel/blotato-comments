import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import pino from 'pino';
import { z } from 'zod';
import { systemClock } from './domain/types.js';
import { DEMO } from './dev/demo-ids.js';
import { buildApp, DEFAULT_RATE_LIMITS, type RateLimitConfig } from './http/app.js';
import { StaticApiKeyResolver } from './http/auth.js';
import { startSyncPoller } from './jobs/poller.js';
import { fromPino } from './logger.js';
import { StaticCredentialsProvider } from './platforms/credentials.js';
import { createFetchHttpClient, DEFAULT_HTTP_TIMEOUT_MS } from './platforms/http.js';
import { ProviderRegistry } from './platforms/registry.js';
import { TwitterCommentProvider } from './platforms/twitter.js';
import { YouTubeCommentProvider } from './platforms/youtube.js';
import type { Repositories } from './repositories/interfaces.js';
import { createInMemoryRepositories, type InMemoryRepositories } from './repositories/memory.js';
import { createPgRepositories } from './repositories/postgres.js';
import { CommentService } from './services/comment-service.js';
import { CommentSyncService, DEFAULT_SYNC_OPTIONS, type SyncOptions } from './services/sync-service.js';

export interface AppConfig {
  host: string;
  port: number;
  logLevel: string;
  storage: 'memory' | 'postgres';
  databaseUrl: string | undefined;
  demoMode: boolean;
  platformHttpTimeoutMs: number;
  poller: { enabled: boolean; intervalMs: number; batchSize: number; concurrency: number };
  sync: SyncOptions & { staleAfterMs: number; staleMaxMs: number };
  rateLimits: RateLimitConfig;
  tokens: { twitter?: string; youtube?: string; youtubeApiKey?: string };
  /** apiKey -> workspaceId */
  apiKeys: Record<string, string>;
}

const intFromEnv = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((raw) => (raw === undefined || raw === '' ? fallback : Number(raw)))
    .pipe(z.number().int().positive());

const EnvSchema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: intFromEnv(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  STORAGE: z.enum(['memory', 'postgres']).default('memory'),
  DATABASE_URL: z.string().optional(),
  DEMO_MODE: z.enum(['true', 'false']).default('false'),
  PLATFORM_HTTP_TIMEOUT_MS: intFromEnv(DEFAULT_HTTP_TIMEOUT_MS),
  SYNC_POLLER_ENABLED: z.enum(['true', 'false']).default('true'),
  SYNC_POLLER_INTERVAL_MS: intFromEnv(15_000),
  SYNC_POLLER_BATCH_SIZE: intFromEnv(20),
  SYNC_POLLER_CONCURRENCY: intFromEnv(4),
  SYNC_MAX_REQUESTS_PER_RUN: intFromEnv(DEFAULT_SYNC_OPTIONS.maxRequestsPerRun),
  SYNC_LEASE_MS: intFromEnv(DEFAULT_SYNC_OPTIONS.leaseMs),
  SYNC_MANUAL_COOLDOWN_MS: intFromEnv(DEFAULT_SYNC_OPTIONS.manualCooldownMs),
  SYNC_RECONCILE_AFTER_MS: intFromEnv(DEFAULT_SYNC_OPTIONS.reconcileAfterMs),
  SYNC_GIVE_UP_AFTER_MS: intFromEnv(DEFAULT_SYNC_OPTIONS.giveUpAfterMs),
  SYNC_PAUSED_RETRY_MS: intFromEnv(DEFAULT_SYNC_OPTIONS.pausedRetryMs),
  SYNC_BACKGROUND_CONCURRENCY: intFromEnv(DEFAULT_SYNC_OPTIONS.backgroundConcurrency),
  SYNC_FULL_RESYNC_INTERVAL_MS: intFromEnv(DEFAULT_SYNC_OPTIONS.fullResyncIntervalMs),
  SYNC_STALE_AFTER_MS: intFromEnv(2 * 60_000),
  SYNC_STALE_MAX_MS: intFromEnv(60 * 60_000),
  RATE_LIMIT_PER_MINUTE: intFromEnv(DEFAULT_RATE_LIMITS.perMinute),
  RATE_LIMIT_SYNC_PER_MINUTE: intFromEnv(DEFAULT_RATE_LIMITS.syncPerMinute),
  RATE_LIMIT_REPLY_PER_MINUTE: intFromEnv(DEFAULT_RATE_LIMITS.replyPerMinute),
  TWITTER_ACCESS_TOKEN: z.string().optional(),
  YOUTUBE_ACCESS_TOKEN: z.string().optional(),
  YOUTUBE_API_KEY: z.string().optional(),
  API_KEYS: z.string().optional(),
});

/**
 * All environment-dependent values in one place, validated at startup so a typo such as
 * SYNC_POLLER_INTERVAL_MS=abc fails the boot instead of becoming setInterval(NaN).
 * Structural constants (platform limits, threading rules) live next to the code that owns them.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const e = parsed.data;
  const demoMode = e.DEMO_MODE === 'true';
  return {
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    storage: e.STORAGE,
    databaseUrl: e.DATABASE_URL,
    demoMode,
    platformHttpTimeoutMs: e.PLATFORM_HTTP_TIMEOUT_MS,
    poller: {
      enabled: e.SYNC_POLLER_ENABLED === 'true',
      intervalMs: e.SYNC_POLLER_INTERVAL_MS,
      batchSize: e.SYNC_POLLER_BATCH_SIZE,
      concurrency: e.SYNC_POLLER_CONCURRENCY,
    },
    sync: {
      maxRequestsPerRun: e.SYNC_MAX_REQUESTS_PER_RUN,
      leaseMs: e.SYNC_LEASE_MS,
      manualCooldownMs: e.SYNC_MANUAL_COOLDOWN_MS,
      reconcileAfterMs: e.SYNC_RECONCILE_AFTER_MS,
      giveUpAfterMs: e.SYNC_GIVE_UP_AFTER_MS,
      pausedRetryMs: e.SYNC_PAUSED_RETRY_MS,
      backgroundConcurrency: e.SYNC_BACKGROUND_CONCURRENCY,
      fullResyncIntervalMs: e.SYNC_FULL_RESYNC_INTERVAL_MS,
      staleAfterMs: e.SYNC_STALE_AFTER_MS,
      staleMaxMs: e.SYNC_STALE_MAX_MS,
    },
    rateLimits: {
      perMinute: e.RATE_LIMIT_PER_MINUTE,
      syncPerMinute: e.RATE_LIMIT_SYNC_PER_MINUTE,
      replyPerMinute: e.RATE_LIMIT_REPLY_PER_MINUTE,
    },
    tokens: { twitter: e.TWITTER_ACCESS_TOKEN, youtube: e.YOUTUBE_ACCESS_TOKEN, youtubeApiKey: e.YOUTUBE_API_KEY },
    apiKeys: demoMode ? { [DEMO.apiKey]: DEMO.workspaceId } : parseApiKeys(e.API_KEYS),
  };
}

/** API_KEYS="key1:workspaceId1,key2:workspaceId2" */
function parseApiKeys(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const [key, workspaceId] = pair.split(':');
    if (key && workspaceId) out[key.trim()] = workspaceId.trim();
  }
  return out;
}

export interface Container {
  app: FastifyInstance;
  repos: Repositories;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function createContainer(config: AppConfig): Promise<Container> {
  const log = pino({ level: config.logLevel });
  const logger = fromPino(log);

  let pool: pg.Pool | null = null;
  let repos: Repositories;
  if (config.storage === 'postgres') {
    if (!config.databaseUrl) throw new Error('DATABASE_URL is required when STORAGE=postgres');
    pool = new pg.Pool({ connectionString: config.databaseUrl });
    repos = createPgRepositories(pool);
  } else {
    repos = createInMemoryRepositories();
  }

  const providers = new ProviderRegistry();
  const credentials = new StaticCredentialsProvider(
    {
      twitter: { accessToken: config.tokens.twitter },
      youtube: { accessToken: config.tokens.youtube, apiKey: config.tokens.youtubeApiKey },
    },
    // Only demo mode gets a stand-in token; a misconfigured production process must fail loudly.
    config.demoMode ? 'demo-token' : null,
  );
  const sync = new CommentSyncService({
    repos,
    providers,
    credentials,
    clock: systemClock,
    logger,
    options: config.sync,
  });
  const comments = new CommentService({
    repos,
    providers,
    credentials,
    sync,
    clock: systemClock,
    logger,
    staleAfterMs: config.sync.staleAfterMs,
  });

  if (config.demoMode) {
    if (config.storage !== 'memory') throw new Error('DEMO_MODE requires STORAGE=memory');
    // Loaded lazily so the simulated platforms and seed data stay out of a production process.
    const { seedDemo } = await import('./dev/seed.js');
    await seedDemo(repos as InMemoryRepositories, providers, sync);
  } else {
    const http = createFetchHttpClient({ timeoutMs: config.platformHttpTimeoutMs });
    providers.register(new TwitterCommentProvider(http)).register(new YouTubeCommentProvider(http));
  }

  const app = buildApp({
    comments,
    apiKeys: new StaticApiKeyResolver(config.apiKeys),
    logger: log,
    rateLimits: config.rateLimits,
  });
  let stopPoller: (() => void) | null = null;

  return {
    app,
    repos,
    async start() {
      await app.listen({ port: config.port, host: config.host });
      if (config.poller.enabled) {
        stopPoller = startSyncPoller(
          { syncStates: repos.syncStates, sync, clock: systemClock, logger },
          {
            intervalMs: config.poller.intervalMs,
            batchSize: config.poller.batchSize,
            concurrency: config.poller.concurrency,
            leaseMs: config.sync.leaseMs,
          },
        );
      }
      log.info(
        { storage: config.storage, demoMode: config.demoMode, platforms: providers.platforms() },
        'comment API started',
      );
    },
    async stop() {
      stopPoller?.();
      await sync.idle();
      await app.close();
      await pool?.end();
    },
  };
}

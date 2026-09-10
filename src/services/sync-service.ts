import { assertConnected } from '../domain/accounts.js';
import { NotFoundError, PlatformError, toPublicError } from '../domain/errors.js';
import type { Clock, Comment, PostPublication } from '../domain/types.js';
import type { Logger } from '../logger.js';
import type { CredentialsProvider } from '../platforms/credentials.js';
import type { ProviderRegistry } from '../platforms/registry.js';
import type { Repositories, SyncLease } from '../repositories/interfaces.js';
import { failureBackoffMs, nextPollDelayMs } from './schedule.js';

export interface SyncOptions {
  /** Upper bound on platform HTTP calls per run so one hot post cannot monopolise a worker or a quota. */
  maxRequestsPerRun: number;
  /** How long a worker may hold a publication's sync lease before it is considered dead. */
  leaseMs: number;
  /** Minimum gap between two on-demand (manual) syncs of the same publication. */
  manualCooldownMs: number;
  /** Pending replies older than this are checked against the platform (delivery outcome unknown). */
  reconcileAfterMs: number;
  /** Pending replies older than this that are still not on the platform are marked failed (retryable). */
  giveUpAfterMs: number;
  /** Delay before retrying after a non-retryable failure (revoked token, unsupported platform). */
  pausedRetryMs: number;
  /** Max read-triggered background syncs running at once in this process; extra ones are left to the poller. */
  backgroundConcurrency: number;
}

export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  maxRequestsPerRun: 20,
  leaseMs: 5 * 60_000,
  manualCooldownMs: 15_000,
  reconcileAfterMs: 60_000,
  giveUpAfterMs: 10 * 60_000,
  pausedRetryMs: 24 * 60 * 60_000,
  backgroundConcurrency: 4,
};

/** Tolerated clock difference between us and the platform when matching own replies by time. */
const RECONCILE_CLOCK_SKEW_MS = 60_000;

export type SyncMode = 'incremental' | 'full';
export type SyncTrigger = 'scheduled' | 'read' | 'manual';

export interface SyncResult {
  publicationId: string;
  status: 'ok' | 'skipped' | 'aborted' | 'failed';
  reason?: 'sync_in_progress' | 'recently_synced' | 'lease_lost';
  /** Set when status is 'failed'. Public code/message only. */
  error?: { code: string; message: string };
  fetched: number;
  created: number;
  updated: number;
  linked: number;
  /** Pending replies resolved (adopted from the platform or marked failed). */
  reconciled: number;
  /** False when the request budget was hit; the run is rescheduled immediately. */
  complete: boolean;
}

export interface SyncRunOptions {
  mode?: SyncMode;
  trigger?: SyncTrigger;
  /** Lease already claimed by the caller (the poller); skips tryAcquire. */
  lease?: SyncLease;
}

export interface SyncServiceDeps {
  repos: Repositories;
  providers: ProviderRegistry;
  credentials: CredentialsProvider;
  clock: Clock;
  logger: Logger;
  options?: Partial<SyncOptions>;
}

/**
 * Pulls comments from a platform into the local mirror.
 *
 * One run = one publication: acquire lease -> fetch pages within a request budget -> upsert and
 * link each page -> reconcile pending replies -> commit cursor and schedule -> release.
 * Idempotent (re-running upserts the same rows), bounded (request budget), and safe under
 * concurrency (fenced lease in the sync-state row).
 */
export class CommentSyncService {
  private readonly options: SyncOptions;
  private readonly background = new Set<Promise<unknown>>();

  constructor(private readonly deps: SyncServiceDeps) {
    this.options = { ...DEFAULT_SYNC_OPTIONS, ...deps.options };
  }

  /** Hook for the publishing pipeline: puts a new publication on the poller's schedule. */
  async scheduleInitialSync(publication: PostPublication): Promise<void> {
    await this.deps.repos.syncStates.ensure(publication.id, this.deps.clock.now());
  }

  async syncPublication(publicationId: string, opts: SyncRunOptions = {}): Promise<SyncResult> {
    const { repos, providers, credentials, clock, logger } = this.deps;
    const trigger = opts.trigger ?? 'scheduled';
    const now = clock.now();

    const publication = await repos.publications.findById(publicationId);
    if (!publication) throw new NotFoundError('publication', publicationId);

    if (trigger === 'manual') {
      const current = await repos.syncStates.get(publicationId);
      const lastSynced = current?.lastSyncedAt?.getTime() ?? 0;
      if (current?.status !== 'failed' && now.getTime() - lastSynced < this.options.manualCooldownMs) {
        return { publicationId, status: 'skipped', reason: 'recently_synced', ...zeroCounts(), complete: true };
      }
    }

    const lease = opts.lease ?? (await repos.syncStates.tryAcquire(publicationId, now, this.options.leaseMs));
    if (!lease)
      return { publicationId, status: 'skipped', reason: 'sync_in_progress', ...zeroCounts(), complete: true };
    const { state, lockToken } = lease;

    try {
      const account = assertConnected(
        await repos.accounts.findById(publication.socialAccountId),
        publication.socialAccountId,
      );
      const provider = providers.get(publication.platform);
      const creds = await credentials.getForAccount(account);

      const mode: SyncMode = opts.mode ?? (provider.capabilities.incrementalSync ? 'incremental' : 'full');
      const explicitFull = opts.mode === 'full';
      // The committed cursor bounds the query. A walk that hit the budget last time resumes from
      // its continuation (same query, saved page token) and keeps its cursor candidate.
      const continuation = explicitFull ? null : state.continuation;
      const sinceCursor = continuation ? continuation.sinceCursor : mode === 'incremental' ? state.cursor : null;
      let pageToken: string | null = continuation?.pageToken ?? null;
      let candidateCursor: string | null = continuation ? continuation.candidateCursor : sinceCursor;
      let requestsUsed = 0;
      let leaseLost = false;
      const counts = zeroCounts();

      try {
        do {
          const page = await provider.fetchComments({
            credentials: creds,
            externalPostId: publication.externalPostId,
            pageToken,
            syncCursor: sinceCursor,
            requestBudget: this.options.maxRequestsPerRun - requestsUsed,
          });
          requestsUsed += Math.max(1, page.requestsUsed);
          const rows = page.comments.map((c) => ({ ...c, isOwn: c.authorExternalId === account.externalAccountId }));
          const result = await repos.comments.upsertFromPlatform(
            { workspaceId: publication.workspaceId, publicationId, platform: publication.platform, now: clock.now() },
            rows,
          );
          counts.fetched += rows.length;
          counts.created += result.created;
          counts.updated += result.updated;
          // Link per page so a reply never shows up as top-level while the walk is still running.
          counts.linked += await repos.comments.resolveParents(publicationId, clock.now());
          candidateCursor = page.syncCursor ?? candidateCursor;
          pageToken = page.nextPageToken;

          if (
            pageToken !== null &&
            !(await repos.syncStates.renew(publicationId, lockToken, clock.now(), this.options.leaseMs))
          ) {
            leaseLost = true;
            break;
          }
        } while (pageToken !== null && requestsUsed < this.options.maxRequestsPerRun);
      } catch (err) {
        if (err instanceof PlatformError && err.kind === 'auth') {
          // The token is dead; stop every future call for this account until the user reconnects.
          await repos.accounts.setStatus(account.id, 'reauth_required');
        }
        throw err;
      }

      if (leaseLost) {
        // Another worker took over; what we wrote is idempotent, only the cursor commit is theirs now.
        logger.warn('sync lease lost mid-run', { publicationId });
        return { publicationId, status: 'aborted', reason: 'lease_lost', ...counts, complete: false };
      }

      const complete = pageToken === null;
      counts.reconciled = await this.reconcilePendingReplies(publication, clock.now());

      const finishedAt = clock.now();
      const committed = await repos.syncStates.finish(publicationId, lockToken, {
        cursor: complete ? candidateCursor : state.cursor,
        continuation: complete || pageToken === null ? null : { pageToken, sinceCursor, candidateCursor },
        lastSyncedAt: finishedAt,
        // Incomplete walks are rescheduled immediately; complete ones follow the age-based schedule.
        nextSyncAt: complete
          ? new Date(finishedAt.getTime() + nextPollDelayMs(publication.publishedAt, finishedAt))
          : finishedAt,
      });
      if (!committed) {
        logger.warn('sync lease lost before commit', { publicationId });
        return { publicationId, status: 'aborted', reason: 'lease_lost', ...counts, complete };
      }

      logger.info('comments synced', {
        publicationId,
        platform: publication.platform,
        ...counts,
        requestsUsed,
        complete,
      });
      return { publicationId, status: 'ok', ...counts, complete };
    } catch (err) {
      const failedAt = clock.now();
      // Retryable platform failures back off exponentially; anything else (revoked token, unsupported
      // platform, bugs) pauses polling for a long interval instead of hammering the platform.
      const retryable = err instanceof PlatformError && err.retryable;
      const delay = retryable ? failureBackoffMs(state.consecutiveFailures + 1) : this.options.pausedRetryMs;
      await repos.syncStates.fail(publicationId, lockToken, {
        error: toPublicError(err).message,
        nextSyncAt: new Date(failedAt.getTime() + delay),
        now: failedAt,
      });
      logger.warn('comment sync failed', {
        publicationId,
        retryable,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Fire-and-forget variant used for stale-while-revalidate on reads. Bounded: when the
   * process already runs `backgroundConcurrency` of these, the publication is left to the poller.
   */
  triggerBackground(publicationId: string): boolean {
    if (this.background.size >= this.options.backgroundConcurrency) return false;
    const run = this.syncPublication(publicationId, { trigger: 'read' })
      .catch(() => {
        /* already logged and recorded in sync state */
      })
      .finally(() => this.background.delete(run));
    this.background.add(run);
    return true;
  }

  /** Resolves once every background sync started so far has settled (tests, graceful shutdown). */
  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  /**
   * Replies whose delivery outcome is unknown (platform timed out, or we crashed mid-flight) stay
   * `pending`. After a sync we know what the platform has: if an own comment with the same text
   * appeared under the same parent after the attempt, adopt it; if nothing showed up within the
   * give-up window, the reply is marked failed and retryable, so the same Idempotency-Key can
   * safely try again.
   */
  private async reconcilePendingReplies(publication: PostPublication, now: Date): Promise<number> {
    const { repos, logger } = this.deps;
    const stale = await repos.comments.listStalePending(
      publication.id,
      new Date(now.getTime() - this.options.reconcileAfterMs),
    );
    let reconciled = 0;
    for (const pending of stale) {
      // On single-level platforms the platform re-parents to the thread root, so both are candidates.
      const root = await repos.comments.findById(pending.workspaceId, pending.rootId);
      const parents = [pending.externalParentId, root?.externalId].filter((id): id is string => !!id);
      const match = await repos.comments.findOwnPlatformMatch(
        publication.id,
        pending.body,
        parents,
        new Date(pending.createdAt.getTime() - RECONCILE_CLOCK_SKEW_MS),
      );
      if (match) {
        const adopted: Comment = {
          ...match,
          origin: 'app',
          idempotencyKey: pending.idempotencyKey,
          idempotencyFingerprint: pending.idempotencyFingerprint,
          error: null,
          updatedAt: now,
        };
        await repos.comments.replacePending(pending.id, adopted);
        logger.info('pending reply reconciled: found on platform', { pendingId: pending.id, commentId: match.id });
        reconciled++;
      } else if (now.getTime() - pending.createdAt.getTime() >= this.options.giveUpAfterMs) {
        await repos.comments.update({
          ...pending,
          status: 'failed',
          error: {
            code: 'not_delivered',
            message: 'Delivery outcome was unknown and the reply was not found on the platform',
            retryable: true,
          },
          updatedAt: now,
        });
        logger.info('pending reply reconciled: not found on platform, marked failed', { pendingId: pending.id });
        reconciled++;
      }
    }
    return reconciled;
  }
}

/** Result shape for a publication whose run threw, so one failure does not hide the others. */
export function failedSyncResult(publicationId: string, err: unknown): SyncResult {
  return { publicationId, status: 'failed', error: toPublicError(err), ...zeroCounts(), complete: false };
}

function zeroCounts(): Pick<SyncResult, 'fetched' | 'created' | 'updated' | 'linked' | 'reconciled'> {
  return { fetched: 0, created: 0, updated: 0, linked: 0, reconciled: 0 };
}

import type { Clock } from '../domain/types.js';
import type { Logger } from '../logger.js';
import type { SyncStateRepository } from '../repositories/interfaces.js';
import type { CommentSyncService } from '../services/sync-service.js';

export interface PollerOptions {
  intervalMs: number;
  /** Publications claimed per tick. */
  batchSize: number;
  /** Syncs run at the same time within this process. */
  concurrency: number;
  leaseMs: number;
}

/**
 * Background loop that re-syncs publications whose next_sync_at has passed.
 *
 * Each tick claims a batch (lease taken in the claim itself, `SKIP LOCKED` in Postgres), so
 * several API instances divide the queue instead of racing for the same rows, and runs the
 * claimed syncs with bounded concurrency so one slow platform cannot stall the rest.
 * A dedicated worker process on a queue is the natural next step and replaces only this file.
 */
export function startSyncPoller(
  deps: { syncStates: SyncStateRepository; sync: CommentSyncService; clock: Clock; logger: Logger },
  options: PollerOptions,
): () => void {
  let inFlight = false;

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const leases = await deps.syncStates.claimDue(deps.clock.now(), options.batchSize, options.leaseMs);
      const queue = [...leases];
      const worker = async () => {
        for (let lease = queue.shift(); lease; lease = queue.shift()) {
          try {
            await deps.sync.syncPublication(lease.state.publicationId, { lease });
          } catch (err) {
            deps.logger.warn('poller sync failed', {
              publicationId: lease.state.publicationId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));
    } catch (err) {
      deps.logger.error('poller tick failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

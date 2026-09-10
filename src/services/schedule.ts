const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long to wait before polling a publication's comments again.
 *
 * Engagement on social posts is front-loaded: most comments arrive in the first hours.
 * Polling frequency therefore decays with post age, which keeps API quota usage
 * (YouTube: 10k units/day by default; X: per-15-min windows) proportional to where
 * comments actually appear. Webhooks, where a platform offers them, replace this.
 */
export function nextPollDelayMs(publishedAt: Date, now: Date): number {
  const age = now.getTime() - publishedAt.getTime();
  if (age < 1 * HOUR) return 1 * MINUTE;
  if (age < 24 * HOUR) return 5 * MINUTE;
  if (age < 7 * DAY) return 30 * MINUTE;
  if (age < 30 * DAY) return 6 * HOUR;
  return 24 * HOUR;
}

/** Exponential backoff after failed syncs: 1m, 2m, 4m, ... capped at 6h. */
export function failureBackoffMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, Math.min(consecutiveFailures - 1, 20));
  return Math.min(MINUTE * 2 ** exponent, 6 * HOUR);
}

/**
 * How stale a publication may be before a *read* triggers a background refresh.
 *
 * Reads are the strongest signal of interest, so they may refresh more often than the
 * poll schedule, but the cooldown grows with post age: a dashboard listing a hundred
 * year-old posts must not turn into a hundred platform calls every two minutes.
 */
export function readStaleAfterMs(publishedAt: Date, now: Date, baseMs: number, capMs: number): number {
  return Math.min(capMs, Math.max(baseMs, Math.floor(nextPollDelayMs(publishedAt, now) / 4)));
}

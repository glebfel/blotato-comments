import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startSyncPoller } from '../src/jobs/poller.js';
import type { FetchCommentsInput } from '../src/platforms/provider.js';
import { createHarness, IDS, silentLogger } from './helpers.js';

describe('sync poller', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }));
  afterEach(() => vi.useRealTimers());

  it('claims due publications, runs them concurrently, keeps going after a failure, never overlaps ticks', async () => {
    const h = createHarness();
    h.twitter.seed(IDS.tweet, { body: 'x' });
    h.youtube.seed(IDS.video, { body: 'y' });
    await h.sync.scheduleInitialSync((await h.repos.publications.findById(IDS.twitterPublication))!);
    await h.sync.scheduleInitialSync((await h.repos.publications.findById(IDS.youtubePublication))!);
    h.twitter.failNext('rate_limited');

    // Observe concurrency: youtube's fetch must start while twitter's is still running.
    let twitterStarted = false;
    let youtubeStartedDuringTwitter = false;
    const twitterFetch = h.twitter.fetchComments.bind(h.twitter);
    h.twitter.fetchComments = async (input: FetchCommentsInput) => {
      twitterStarted = true;
      for (let i = 0; i < 3; i++) await Promise.resolve(); // yield so the other worker can start
      return twitterFetch(input);
    };
    const youtubeFetch = h.youtube.fetchComments.bind(h.youtube);
    h.youtube.fetchComments = async (input: FetchCommentsInput) => {
      youtubeStartedDuringTwitter = twitterStarted;
      return youtubeFetch(input);
    };

    const stop = startSyncPoller(
      { syncStates: h.repos.syncStates, sync: h.sync, clock: h.clock, logger: silentLogger },
      { intervalMs: 1_000, batchSize: 10, concurrency: 2, leaseMs: 60_000 },
    );
    await vi.advanceTimersByTimeAsync(1_000);

    expect(h.twitter.calls.fetch).toBe(1);
    expect(h.youtube.calls.fetch).toBe(1); // the twitter failure did not stop the tick
    expect(youtubeStartedDuringTwitter).toBe(true);
    expect((await h.repos.syncStates.get(IDS.twitterPublication))?.status).toBe('failed');
    expect((await h.repos.syncStates.get(IDS.youtubePublication))?.status).toBe('idle');

    // Nothing is due until the schedule/backoff says so.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.twitter.calls.fetch).toBe(1);
    expect(h.youtube.calls.fetch).toBe(1);

    h.clock.advance(61_000); // twitter backoff (60 s) elapsed, youtube (1 min poll) too
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.twitter.calls.fetch).toBe(2);
    expect(h.youtube.calls.fetch).toBe(2);

    stop();
    h.clock.advance(3_600_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.twitter.calls.fetch).toBe(2); // stopped
  });
});

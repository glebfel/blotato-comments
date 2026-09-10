import { describe, expect, it } from 'vitest';
import { DomainError, PlatformError } from '../src/domain/errors.js';
import type { FetchCommentsInput } from '../src/platforms/provider.js';
import { createHarness, IDS } from './helpers.js';

describe('CommentSyncService', () => {
  it('imports comments and resolves threads even when children arrive before parents', async () => {
    const h = createHarness();
    const a = h.twitter.seed(IDS.tweet, { body: 'top A' });
    const b = h.twitter.seed(IDS.tweet, { body: 'reply to A', externalParentId: a });
    const c = h.twitter.seed(IDS.tweet, { body: 'reply to B', externalParentId: b });
    // The fake platform returns newest first, so c and b are seen before their parents.

    const result = await h.sync.syncPublication(IDS.twitterPublication);
    expect(result).toMatchObject({ status: 'ok', fetched: 3, created: 3, updated: 0, linked: 2, complete: true });

    const top = await h.repos.comments.listTopLevel({
      publicationIds: [IDS.twitterPublication],
      limit: 10,
      cursor: null,
      sort: 'newest',
    });
    expect(top.items.map((i) => i.body)).toEqual(['top A']);

    const rowA = (await h.repos.comments.findByExternalId(IDS.twitterPublication, a))!;
    const rowB = (await h.repos.comments.findByExternalId(IDS.twitterPublication, b))!;
    const rowC = (await h.repos.comments.findByExternalId(IDS.twitterPublication, c))!;
    expect(rowB).toMatchObject({ parentId: rowA.id, depth: 1, threadPath: `${rowA.id}/${rowB.id}` });
    expect(rowC).toMatchObject({ parentId: rowB.id, depth: 2, threadPath: `${rowA.id}/${rowB.id}/${rowC.id}` });
  });

  it('flags comments written by the connected account as own and keeps platform metrics', async () => {
    const h = createHarness();
    const id = h.twitter.seed(IDS.tweet, { body: 'from us', authorExternalId: 'x-own', metrics: { likes: 7 } });
    h.twitter.seed(IDS.tweet, { body: 'from someone else' });
    await h.sync.syncPublication(IDS.twitterPublication);

    const own = (await h.repos.comments.findByExternalId(IDS.twitterPublication, id))!;
    expect(own.isOwn).toBe(true);
    expect(own.origin).toBe('platform');
    expect(own.metrics).toEqual({ likes: 7 });
  });

  it('uses the incremental cursor so later runs only fetch new comments', async () => {
    const h = createHarness();
    h.twitter.seed(IDS.tweet, { body: 'one' });
    h.twitter.seed(IDS.tweet, { body: 'two' });
    expect(await h.sync.syncPublication(IDS.twitterPublication)).toMatchObject({ fetched: 2, created: 2 });
    expect((await h.repos.syncStates.get(IDS.twitterPublication))?.cursor).toBe('2');

    h.twitter.seed(IDS.tweet, { body: 'three' });
    expect(await h.sync.syncPublication(IDS.twitterPublication)).toMatchObject({ fetched: 1, created: 1, updated: 0 });
    expect((await h.repos.syncStates.get(IDS.twitterPublication))?.cursor).toBe('3');
  });

  it('updates existing rows instead of duplicating them on a full re-sync', async () => {
    const h = createHarness();
    h.twitter.seed(IDS.tweet, { body: 'one' });
    h.twitter.seed(IDS.tweet, { body: 'two' });
    await h.sync.syncPublication(IDS.twitterPublication);
    expect(await h.sync.syncPublication(IDS.twitterPublication, { mode: 'full' })).toMatchObject({
      fetched: 2,
      created: 0,
      updated: 2,
    });
  });

  it('resumes from the saved continuation when a run hits the request budget and only then commits the cursor', async () => {
    const h = createHarness({ pageSize: 2, maxRequestsPerRun: 1 });
    for (let i = 1; i <= 5; i++) h.twitter.seed(IDS.tweet, { body: `c${i}` });

    const first = await h.sync.syncPublication(IDS.twitterPublication);
    expect(first).toMatchObject({ fetched: 2, complete: false });
    let state = (await h.repos.syncStates.get(IDS.twitterPublication))!;
    expect(state.cursor).toBeNull();
    expect(state.continuation).toEqual({ pageToken: '2', sinceCursor: null, candidateCursor: '5' });
    expect(state.nextSyncAt?.getTime()).toBe(h.clock.now().getTime()); // rescheduled immediately

    expect(await h.sync.syncPublication(IDS.twitterPublication)).toMatchObject({ fetched: 2, complete: false });
    expect(await h.sync.syncPublication(IDS.twitterPublication)).toMatchObject({ fetched: 1, complete: true });

    state = (await h.repos.syncStates.get(IDS.twitterPublication))!;
    expect(state).toMatchObject({ cursor: '5', continuation: null });
    expect(state.nextSyncAt!.getTime()).toBeGreaterThan(h.clock.now().getTime());

    const all = await h.repos.comments.listTopLevel({
      publicationIds: [IDS.twitterPublication],
      limit: 10,
      cursor: null,
      sort: 'oldest',
    });
    expect(all.items.map((c) => c.body)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
  });

  it('skips while another worker holds the lease and runs once the lease expires', async () => {
    const h = createHarness();
    h.twitter.seed(IDS.tweet, { body: 'x' });
    await h.repos.syncStates.tryAcquire(IDS.twitterPublication, h.clock.now(), 60_000);

    expect(await h.sync.syncPublication(IDS.twitterPublication)).toMatchObject({
      status: 'skipped',
      reason: 'sync_in_progress',
    });
    expect(h.twitter.calls.fetch).toBe(0);

    h.clock.advance(61_000);
    expect(await h.sync.syncPublication(IDS.twitterPublication)).toMatchObject({ status: 'ok', fetched: 1 });
  });

  it('fences a worker whose lease expired so it cannot overwrite a newer run', async () => {
    const h = createHarness();
    h.twitter.seed(IDS.tweet, { body: 'x' });
    const stale = (await h.repos.syncStates.tryAcquire(IDS.twitterPublication, h.clock.now(), 1_000))!;

    h.clock.advance(2_000);
    await h.sync.syncPublication(IDS.twitterPublication); // takes over the expired lease
    const after = (await h.repos.syncStates.get(IDS.twitterPublication))!;
    expect(after).toMatchObject({ status: 'idle', cursor: '1' });

    const now = h.clock.now();
    expect(await h.repos.syncStates.renew(IDS.twitterPublication, stale.lockToken, now, 1_000)).toBe(false);
    expect(
      await h.repos.syncStates.finish(IDS.twitterPublication, stale.lockToken, {
        cursor: 'stale',
        continuation: null,
        lastSyncedAt: now,
        nextSyncAt: now,
      }),
    ).toBe(false);
    expect(
      await h.repos.syncStates.fail(IDS.twitterPublication, stale.lockToken, { error: 'stale', nextSyncAt: now, now }),
    ).toBe(false);
    expect((await h.repos.syncStates.get(IDS.twitterPublication))?.cursor).toBe('1');
  });

  it('aborts a run whose lease was taken over between pages', async () => {
    const h = createHarness({ pageSize: 1, leaseMs: 1_000 });
    h.twitter.seed(IDS.tweet, { body: 'a' });
    h.twitter.seed(IDS.tweet, { body: 'b' });
    const original = h.twitter.fetchComments.bind(h.twitter);
    h.twitter.fetchComments = async (input: FetchCommentsInput) => {
      const page = await original(input);
      // Simulate a slow page: the lease expires and another worker grabs it.
      h.clock.advance(2_000);
      await h.repos.syncStates.tryAcquire(IDS.twitterPublication, h.clock.now(), 60_000);
      return page;
    };

    const result = await h.sync.syncPublication(IDS.twitterPublication);
    expect(result).toMatchObject({ status: 'aborted', reason: 'lease_lost', fetched: 1 });
  });

  it('applies a cooldown to manual syncs but not to scheduled ones', async () => {
    const h = createHarness({ manualCooldownMs: 15_000 });
    h.twitter.seed(IDS.tweet, { body: 'x' });
    expect(await h.sync.syncPublication(IDS.twitterPublication, { trigger: 'manual' })).toMatchObject({ status: 'ok' });
    expect(await h.sync.syncPublication(IDS.twitterPublication, { trigger: 'manual' })).toMatchObject({
      status: 'skipped',
      reason: 'recently_synced',
    });
    expect(await h.sync.syncPublication(IDS.twitterPublication)).toMatchObject({ status: 'ok' });
    h.clock.advance(15_000);
    expect(await h.sync.syncPublication(IDS.twitterPublication, { trigger: 'manual' })).toMatchObject({ status: 'ok' });
  });

  it('records retryable failures with exponential backoff and clears them on success', async () => {
    const h = createHarness();
    h.twitter.seed(IDS.tweet, { body: 'x' });

    h.twitter.failNext('rate_limited');
    await expect(h.sync.syncPublication(IDS.twitterPublication)).rejects.toBeInstanceOf(PlatformError);
    let state = (await h.repos.syncStates.get(IDS.twitterPublication))!;
    expect(state).toMatchObject({ status: 'failed', consecutiveFailures: 1 });
    expect(state.lastError).toContain('rate_limited');
    expect(state.nextSyncAt!.getTime() - h.clock.now().getTime()).toBe(60_000);

    h.twitter.failNext('unavailable');
    await expect(h.sync.syncPublication(IDS.twitterPublication)).rejects.toBeInstanceOf(PlatformError);
    state = (await h.repos.syncStates.get(IDS.twitterPublication))!;
    expect(state.consecutiveFailures).toBe(2);
    expect(state.nextSyncAt!.getTime() - h.clock.now().getTime()).toBe(120_000);

    await h.sync.syncPublication(IDS.twitterPublication);
    state = (await h.repos.syncStates.get(IDS.twitterPublication))!;
    expect(state).toMatchObject({ status: 'idle', consecutiveFailures: 0, lastError: null });
  });

  it('pauses polling after a non-retryable failure instead of backing off', async () => {
    const h = createHarness({ pausedRetryMs: 3_600_000 });
    h.twitter.seed(IDS.tweet, { body: 'x' });
    h.twitter.failNext('auth', 'token revoked');
    await expect(h.sync.syncPublication(IDS.twitterPublication)).rejects.toMatchObject({ kind: 'auth' });
    const state = (await h.repos.syncStates.get(IDS.twitterPublication))!;
    expect(state.nextSyncAt!.getTime() - h.clock.now().getTime()).toBe(3_600_000);
    expect((await h.repos.accounts.findById(IDS.twitterAccount))?.status).toBe('reauth_required');
  });

  it('fails fast when the social account is not connected and never shows internals in lastError', async () => {
    const h = createHarness();
    h.repos.accounts.add({ ...(await h.repos.accounts.findById(IDS.twitterAccount))!, status: 'reauth_required' });
    await expect(h.sync.syncPublication(IDS.twitterPublication)).rejects.toMatchObject({
      code: 'account_not_connected',
    });
    expect((await h.repos.syncStates.get(IDS.twitterPublication))?.status).toBe('failed');
    await expect(h.sync.syncPublication(IDS.twitterPublication)).rejects.toBeInstanceOf(DomainError);

    h.twitter.fetchComments = async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'snippet')");
    };
    h.repos.accounts.add({ ...(await h.repos.accounts.findById(IDS.twitterAccount))!, status: 'connected' });
    await expect(h.sync.syncPublication(IDS.twitterPublication)).rejects.toBeInstanceOf(TypeError);
    expect((await h.repos.syncStates.get(IDS.twitterPublication))?.lastError).toBe('internal error');
  });

  it('runs a full walk once a day so edits and metrics of old comments are refreshed', async () => {
    const h = createHarness({ fullResyncIntervalMs: 24 * 3_600_000 });
    const old = h.twitter.seed(IDS.tweet, { body: 'original', metrics: { likes: 1 } });
    expect(await h.sync.syncPublication(IDS.twitterPublication)).toMatchObject({ fetched: 1 }); // first run walks everything
    expect((await h.repos.syncStates.get(IDS.twitterPublication))?.lastFullSyncAt).toEqual(h.clock.now());

    h.twitter.patch(IDS.tweet, old, { body: 'edited', metrics: { likes: 9 } });
    h.clock.advance(3_600_000);
    expect(await h.sync.syncPublication(IDS.twitterPublication)).toMatchObject({ fetched: 0 }); // incremental: unseen
    expect((await h.repos.comments.findByExternalId(IDS.twitterPublication, old))?.body).toBe('original');

    h.clock.advance(24 * 3_600_000);
    expect(await h.sync.syncPublication(IDS.twitterPublication)).toMatchObject({ fetched: 1, updated: 1 }); // full walk due
    const row = (await h.repos.comments.findByExternalId(IDS.twitterPublication, old))!;
    expect(row).toMatchObject({ body: 'edited', metrics: { likes: 9 } });
    expect((await h.repos.syncStates.get(IDS.twitterPublication))?.lastFullSyncAt).toEqual(h.clock.now());
  });

  it('rejects publications on platforms without an adapter', async () => {
    const h = createHarness({ withUnsupportedPlatform: true });
    await expect(h.sync.syncPublication(IDS.instagramPublication)).rejects.toMatchObject({
      code: 'platform_not_supported',
    });
  });
});

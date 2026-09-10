import { describe, expect, it } from 'vitest';
import { createHarness, IDS, settle } from './helpers.js';

describe('CommentService.listForPost', () => {
  it('lists top-level comments across platforms, newest first, with reply counts and sync meta', async () => {
    const h = createHarness();
    const t = h.twitter.seed(IDS.tweet, { body: 'x top' });
    h.twitter.seed(IDS.tweet, { body: 'x reply', externalParentId: t });
    h.youtube.seed(IDS.video, { body: 'yt top' });
    await h.sync.syncPublication(IDS.twitterPublication);
    await h.sync.syncPublication(IDS.youtubePublication);

    const result = await h.comments.listForPost(IDS.workspace, IDS.post, { limit: 10, cursor: null, sort: 'newest' });

    expect(result.items.map((i) => [i.comment.body, i.comment.platform, i.replyCount])).toEqual([
      ['yt top', 'youtube', 0],
      ['x top', 'twitter', 1],
    ]);
    expect(result.publications.map((p) => [p.publication.platform, p.sync?.status])).toEqual([
      ['twitter', 'idle'],
      ['youtube', 'idle'],
    ]);
  });

  it('filters by platform', async () => {
    const h = createHarness();
    h.twitter.seed(IDS.tweet, { body: 'x' });
    h.youtube.seed(IDS.video, { body: 'yt' });
    await h.sync.syncPublication(IDS.twitterPublication);
    await h.sync.syncPublication(IDS.youtubePublication);

    const result = await h.comments.listForPost(IDS.workspace, IDS.post, {
      platform: 'youtube',
      limit: 10,
      cursor: null,
      sort: 'newest',
    });
    expect(result.items.map((i) => i.comment.body)).toEqual(['yt']);
    expect(result.publications).toHaveLength(1);
  });

  it('paginates with a keyset cursor without gaps or duplicates, including identical timestamps', async () => {
    const h = createHarness();
    const sameSecond = new Date('2026-01-01T00:00:00Z');
    for (let i = 1; i <= 7; i++) h.twitter.seed(IDS.tweet, { body: `c${i}`, postedAt: sameSecond });
    await h.sync.syncPublication(IDS.twitterPublication);

    const seen: string[] = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = await h.comments.listForPost(IDS.workspace, IDS.post, { limit: 3, cursor, sort: 'oldest' });
      seen.push(...page.items.map((i) => i.comment.body));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect([...seen].sort()).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
  });

  it('rejects posts that are not published or belong to another workspace', async () => {
    const h = createHarness();
    await expect(
      h.comments.listForPost(IDS.workspace, IDS.draftPost, { limit: 10, cursor: null, sort: 'newest' }),
    ).rejects.toMatchObject({ code: 'post_not_published' });
    await expect(
      h.comments.listForPost(IDS.otherWorkspace, IDS.post, { limit: 10, cursor: null, sort: 'newest' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('serves stale data immediately and refreshes in the background', async () => {
    const h = createHarness({ staleAfterMs: 60_000 });
    h.twitter.seed(IDS.tweet, { body: 'early' });

    const first = await h.comments.listForPost(IDS.workspace, IDS.post, { limit: 10, cursor: null, sort: 'newest' });
    expect(first.items).toEqual([]); // nothing synced yet, but the read did not block
    await settle(h);
    expect(h.twitter.calls.fetch).toBe(1);

    const second = await h.comments.listForPost(IDS.workspace, IDS.post, { limit: 10, cursor: null, sort: 'newest' });
    expect(second.items.map((i) => i.comment.body)).toEqual(['early']);
    await settle(h);
    expect(h.twitter.calls.fetch).toBe(1); // fresh enough, no second fetch

    h.clock.advance(61_000);
    await h.comments.listForPost(IDS.workspace, IDS.post, { limit: 10, cursor: null, sort: 'newest' });
    await settle(h);
    expect(h.twitter.calls.fetch).toBe(2);
  });

  it('does not re-trigger a failed publication before its backoff has elapsed', async () => {
    const h = createHarness({ staleAfterMs: 1_000 });
    h.twitter.seed(IDS.tweet, { body: 'x' });
    h.twitter.failNext('rate_limited');
    await expect(h.sync.syncPublication(IDS.twitterPublication)).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(h.twitter.calls.fetch).toBe(1);

    for (let i = 0; i < 3; i++) {
      h.clock.advance(5_000);
      await h.comments.listForPost(IDS.workspace, IDS.post, {
        platform: 'twitter',
        limit: 10,
        cursor: null,
        sort: 'newest',
      });
      await settle(h);
    }
    expect(h.twitter.calls.fetch).toBe(1); // backoff (60 s) respected

    h.clock.advance(60_000);
    await h.comments.listForPost(IDS.workspace, IDS.post, {
      platform: 'twitter',
      limit: 10,
      cursor: null,
      sort: 'newest',
    });
    await settle(h);
    expect(h.twitter.calls.fetch).toBe(2);
  });

  it('scales the read cooldown with the age of the post', async () => {
    const h = createHarness({ staleAfterMs: 60_000, staleMaxMs: 3_600_000, postAgeMs: 400 * 24 * 3_600_000 });
    h.twitter.seed(IDS.tweet, { body: 'old' });
    const read = () =>
      h.comments.listForPost(IDS.workspace, IDS.post, { platform: 'twitter', limit: 10, cursor: null, sort: 'newest' });

    await read();
    await settle(h);
    expect(h.twitter.calls.fetch).toBe(1);

    h.clock.advance(30 * 60_000); // half an hour later: still within the 1 h cooldown of a year-old post
    await read();
    await settle(h);
    expect(h.twitter.calls.fetch).toBe(1);

    h.clock.advance(31 * 60_000);
    await read();
    await settle(h);
    expect(h.twitter.calls.fetch).toBe(2);
  });

  it('caps the number of read-triggered syncs running at once', async () => {
    const h = createHarness({ staleAfterMs: 1_000, backgroundConcurrency: 1 });
    h.twitter.seed(IDS.tweet, { body: 'x' });
    h.youtube.seed(IDS.video, { body: 'y' });
    expect(h.sync.triggerBackground(IDS.twitterPublication)).toBe(true);
    expect(h.sync.triggerBackground(IDS.youtubePublication)).toBe(false); // left to the poller
    await settle(h);
    expect(h.youtube.calls.fetch).toBe(0);
  });

  it('shows orphans (parent never synced) as top-level with their platform parent id', async () => {
    const h = createHarness();
    h.twitter.seed(IDS.tweet, { body: 'reply to a comment we never saw', externalParentId: 'deleted-parent' });
    await h.sync.syncPublication(IDS.twitterPublication);
    const result = await h.comments.listForPost(IDS.workspace, IDS.post, { limit: 10, cursor: null, sort: 'newest' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.comment).toMatchObject({ parentId: null, depth: 0, externalParentId: 'deleted-parent' });
  });

  it('treats a running sync whose lease expired as stale', async () => {
    const h = createHarness({ staleAfterMs: 1_000 });
    h.twitter.seed(IDS.tweet, { body: 'x' });
    await h.repos.syncStates.tryAcquire(IDS.twitterPublication, h.clock.now(), 10_000); // crashed worker

    await h.comments.listForPost(IDS.workspace, IDS.post, {
      platform: 'twitter',
      limit: 10,
      cursor: null,
      sort: 'newest',
    });
    await settle(h);
    expect(h.twitter.calls.fetch).toBe(0); // lease still live

    h.clock.advance(11_000);
    await h.comments.listForPost(IDS.workspace, IDS.post, {
      platform: 'twitter',
      limit: 10,
      cursor: null,
      sort: 'newest',
    });
    await settle(h);
    expect(h.twitter.calls.fetch).toBe(1);
  });
});

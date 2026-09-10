import { describe, expect, it } from 'vitest';
import { PlatformError } from '../src/domain/errors.js';
import type { CreateReplyInput } from '../src/platforms/provider.js';
import { createHarness, IDS, settle, type Harness } from './helpers.js';

async function seedAndSync(h: Harness) {
  const top = h.twitter.seed(IDS.tweet, { body: 'top', authorHandle: 'alice' });
  await h.sync.syncPublication(IDS.twitterPublication);
  return (await h.repos.comments.findByExternalId(IDS.twitterPublication, top))!;
}

describe('CommentService.reply', () => {
  it('posts the reply through the platform and stores it as a published own comment', async () => {
    const h = createHarness();
    const parent = await seedAndSync(h);

    const { comment, created } = await h.comments.reply(IDS.workspace, parent.id, {
      text: 'Thanks!',
      idempotencyKey: 'k1',
    });

    expect(created).toBe(true);
    expect(comment).toMatchObject({
      status: 'published',
      origin: 'app',
      isOwn: true,
      parentId: parent.id,
      externalParentId: parent.externalId,
      depth: 1,
      threadPath: `${parent.id}/${comment.id}`,
      idempotencyKey: 'k1',
    });
    expect(comment.externalId).toBeTruthy();
    expect(h.twitter.all(IDS.tweet).some((c) => c.externalId === comment.externalId && c.body === 'Thanks!')).toBe(
      true,
    );

    const thread = await h.comments.listReplies(IDS.workspace, parent.id, { limit: 10, cursor: null });
    expect(thread.items.map((i) => i.comment.body)).toEqual(['Thanks!']);
    expect((await h.comments.getById(IDS.workspace, parent.id)).replyCount).toBe(1);
  });

  it('survives the next sync without duplicating the reply', async () => {
    const h = createHarness();
    const parent = await seedAndSync(h);
    const { comment } = await h.comments.reply(IDS.workspace, parent.id, { text: 'Thanks!', idempotencyKey: 'k1' });

    const result = await h.sync.syncPublication(IDS.twitterPublication);
    expect(result).toMatchObject({ created: 0, updated: 1 });
    const after = (await h.repos.comments.findById(IDS.workspace, comment.id))!;
    expect(after).toMatchObject({ origin: 'app', status: 'published', isOwn: true, parentId: parent.id });
    expect((await h.comments.getById(IDS.workspace, parent.id)).replyCount).toBe(1);
  });

  it('replays the stored result for a repeated Idempotency-Key without calling the platform again', async () => {
    const h = createHarness();
    const parent = await seedAndSync(h);
    const first = await h.comments.reply(IDS.workspace, parent.id, { text: 'Thanks!', idempotencyKey: 'k1' });
    const second = await h.comments.reply(IDS.workspace, parent.id, { text: 'Thanks!', idempotencyKey: 'k1' });

    expect(second.created).toBe(false);
    expect(second.comment.id).toBe(first.comment.id);
    expect(h.twitter.calls.reply).toBe(1);
  });

  it('rejects a reused Idempotency-Key with a different request instead of replaying silently', async () => {
    const h = createHarness();
    const parent = await seedAndSync(h);
    const other = h.twitter.seed(IDS.tweet, { body: 'another top' });
    await h.sync.syncPublication(IDS.twitterPublication);
    const otherRow = (await h.repos.comments.findByExternalId(IDS.twitterPublication, other))!;
    await h.comments.reply(IDS.workspace, parent.id, { text: 'Thanks!', idempotencyKey: 'k1' });

    await expect(
      h.comments.reply(IDS.workspace, parent.id, { text: 'Different', idempotencyKey: 'k1' }),
    ).rejects.toMatchObject({
      code: 'idempotency_key_reused',
    });
    await expect(
      h.comments.reply(IDS.workspace, otherRow.id, { text: 'Thanks!', idempotencyKey: 'k1' }),
    ).rejects.toMatchObject({
      code: 'idempotency_key_reused',
    });
    expect(h.twitter.calls.reply).toBe(1);
  });

  it('rejects a concurrent request with the same key while the first is still in flight', async () => {
    const h = createHarness();
    const parent = await seedAndSync(h);
    const original = h.twitter.createReply.bind(h.twitter);
    let release: () => void = () => {};
    h.twitter.createReply = (input: CreateReplyInput) =>
      new Promise((resolve) => {
        release = () => resolve(original(input));
      });

    const inFlight = h.comments.reply(IDS.workspace, parent.id, { text: 'A', idempotencyKey: 'k1' });
    await new Promise((resolve) => setImmediate(resolve));
    await expect(h.comments.reply(IDS.workspace, parent.id, { text: 'A', idempotencyKey: 'k1' })).rejects.toMatchObject(
      {
        code: 'reply_in_progress',
        details: { reason: 'in_flight' },
      },
    );

    release();
    expect((await inFlight).comment.status).toBe('published');
  });

  it('attaches a reply-to-a-reply to the thread root on single-level platforms', async () => {
    const h = createHarness();
    const top = h.youtube.seed(IDS.video, { body: 'top' });
    const nested = h.youtube.seed(IDS.video, { body: 'first reply', externalParentId: top });
    await h.sync.syncPublication(IDS.youtubePublication);
    const rowTop = (await h.repos.comments.findByExternalId(IDS.youtubePublication, top))!;
    const rowNested = (await h.repos.comments.findByExternalId(IDS.youtubePublication, nested))!;

    const { comment } = await h.comments.reply(IDS.workspace, rowNested.id, { text: 'answer', idempotencyKey: null });

    expect(comment).toMatchObject({
      parentId: rowTop.id,
      externalParentId: top,
      depth: 1,
      threadPath: `${rowTop.id}/${comment.id}`,
    });
    expect(h.youtube.all(IDS.video).find((c) => c.externalId === comment.externalId)?.externalParentId).toBe(top);
  });

  it('validates the text against the platform limit before calling the platform', async () => {
    const h = createHarness();
    const parent = await seedAndSync(h);

    await expect(
      h.comments.reply(IDS.workspace, parent.id, { text: '   ', idempotencyKey: null }),
    ).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(
      h.comments.reply(IDS.workspace, parent.id, { text: 'x'.repeat(281), idempotencyKey: null }),
    ).rejects.toMatchObject({ code: 'validation_error', details: { maxLength: 280, length: 281 } });
    expect(h.twitter.calls.reply).toBe(0);
  });

  it('marks a definitively rejected reply failed and replays the same error for the same key', async () => {
    const h = createHarness();
    const parent = await seedAndSync(h);
    h.twitter.failNext('rejected', 'comments are disabled');

    await expect(
      h.comments.reply(IDS.workspace, parent.id, { text: 'hi', idempotencyKey: 'k1' }),
    ).rejects.toMatchObject({
      kind: 'rejected',
    });
    const failed = (await h.repos.comments.findByIdempotencyKey(IDS.workspace, 'k1'))!;
    expect(failed).toMatchObject({
      status: 'failed',
      externalId: null,
      error: { code: 'platform_rejected', message: 'comments are disabled', retryable: false },
    });

    await expect(
      h.comments.reply(IDS.workspace, parent.id, { text: 'hi', idempotencyKey: 'k1' }),
    ).rejects.toMatchObject({
      kind: 'rejected',
      message: 'comments are disabled',
    });
    expect(h.twitter.calls.reply).toBe(1);
    expect((await h.comments.getById(IDS.workspace, parent.id)).replyCount).toBe(0);
  });

  it('re-delivers on the same key after a retryable failure such as a rate limit', async () => {
    const h = createHarness();
    const parent = await seedAndSync(h);
    h.twitter.failNext('rate_limited');
    await expect(
      h.comments.reply(IDS.workspace, parent.id, { text: 'hi', idempotencyKey: 'k1' }),
    ).rejects.toMatchObject({
      kind: 'rate_limited',
    });
    const failed = (await h.repos.comments.findByIdempotencyKey(IDS.workspace, 'k1'))!;
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'platform_rate_limited', retryable: true } });

    const retried = await h.comments.reply(IDS.workspace, parent.id, { text: 'hi', idempotencyKey: 'k1' });
    expect(retried).toMatchObject({ created: true, comment: { id: failed.id, status: 'published', error: null } });
    expect(h.twitter.calls.reply).toBe(2);
    expect(h.twitter.all(IDS.tweet).filter((c) => c.body === 'hi')).toHaveLength(1);
  });

  it('keeps a reply pending when the outcome is unknown and adopts it once the sync finds it on the platform', async () => {
    const h = createHarness({ reconcileAfterMs: 60_000, giveUpAfterMs: 600_000 });
    const parent = await seedAndSync(h);
    // The platform applied the reply but the response was lost (timeout).
    h.twitter.failNext('unavailable', 'socket hang up', { afterApply: true });

    await expect(
      h.comments.reply(IDS.workspace, parent.id, { text: 'hi', idempotencyKey: 'k1' }),
    ).rejects.toMatchObject({
      kind: 'unavailable',
      outcomeUnknown: true,
    });
    const pending = (await h.repos.comments.findByIdempotencyKey(IDS.workspace, 'k1'))!;
    expect(pending).toMatchObject({ status: 'pending', error: { code: 'platform_unavailable' } });
    // The publication is pulled forward to the reconciliation window instead of waiting for its schedule.
    expect((await h.repos.syncStates.get(IDS.twitterPublication))?.nextSyncAt).toEqual(
      new Date(h.clock.now().getTime() + 60_000),
    );

    // Same key -> no second post, the client is told to wait for reconciliation.
    await expect(
      h.comments.reply(IDS.workspace, parent.id, { text: 'hi', idempotencyKey: 'k1' }),
    ).rejects.toMatchObject({
      code: 'reply_in_progress',
      details: { reason: 'awaiting_reconciliation' },
    });
    expect(h.twitter.calls.reply).toBe(1);

    // Too fresh to reconcile on the first sync, reconciled on the next.
    expect(await h.sync.syncPublication(IDS.twitterPublication)).toMatchObject({ reconciled: 0 });
    h.clock.advance(61_000);
    expect(await h.sync.syncPublication(IDS.twitterPublication)).toMatchObject({ reconciled: 1 });

    const adopted = (await h.repos.comments.findByIdempotencyKey(IDS.workspace, 'k1'))!;
    expect(adopted).toMatchObject({ status: 'published', origin: 'app', isOwn: true, body: 'hi', parentId: parent.id });
    expect(adopted.id).not.toBe(pending.id);
    expect(await h.repos.comments.findById(IDS.workspace, pending.id)).toBeNull();
    expect(await h.comments.reply(IDS.workspace, parent.id, { text: 'hi', idempotencyKey: 'k1' })).toMatchObject({
      created: false,
      comment: { id: adopted.id },
    });
    expect((await h.comments.getById(IDS.workspace, parent.id)).replyCount).toBe(1);
  });

  it('gives up on an unknown-outcome reply that never shows up and lets the same key try again', async () => {
    const h = createHarness({ reconcileAfterMs: 60_000, giveUpAfterMs: 600_000 });
    const parent = await seedAndSync(h);
    h.twitter.failNext('unavailable'); // request never reached the platform

    await expect(
      h.comments.reply(IDS.workspace, parent.id, { text: 'hi', idempotencyKey: 'k1' }),
    ).rejects.toBeInstanceOf(PlatformError);
    h.clock.advance(120_000);
    expect(await h.sync.syncPublication(IDS.twitterPublication)).toMatchObject({ reconciled: 0 }); // still within the window
    expect((await h.repos.comments.findByIdempotencyKey(IDS.workspace, 'k1'))?.status).toBe('pending');

    h.clock.advance(600_000);
    expect(await h.sync.syncPublication(IDS.twitterPublication)).toMatchObject({ reconciled: 1 });
    const failed = (await h.repos.comments.findByIdempotencyKey(IDS.workspace, 'k1'))!;
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'not_delivered', retryable: true } });

    const retried = await h.comments.reply(IDS.workspace, parent.id, { text: 'hi', idempotencyKey: 'k1' });
    expect(retried).toMatchObject({ created: true, comment: { id: failed.id, status: 'published' } });
    expect(h.twitter.all(IDS.tweet).filter((c) => c.body === 'hi')).toHaveLength(1);
  });

  it('refuses to reply to a comment that is not published', async () => {
    const h = createHarness();
    const parent = await seedAndSync(h);
    h.twitter.failNext('rejected');
    await expect(
      h.comments.reply(IDS.workspace, parent.id, { text: 'hi', idempotencyKey: 'k1' }),
    ).rejects.toBeInstanceOf(PlatformError);
    const failed = (await h.repos.comments.findByIdempotencyKey(IDS.workspace, 'k1'))!;

    await expect(
      h.comments.reply(IDS.workspace, failed.id, { text: 'again', idempotencyKey: null }),
    ).rejects.toMatchObject({
      code: 'reply_target_not_published',
    });
  });

  it('marks the target deleted when the platform says it no longer exists', async () => {
    const h = createHarness();
    const parent = await seedAndSync(h);
    h.twitter.failNext('not_found', 'comment was deleted');
    await expect(
      h.comments.reply(IDS.workspace, parent.id, { text: 'hi', idempotencyKey: 'k1' }),
    ).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect((await h.repos.comments.findById(IDS.workspace, parent.id))?.status).toBe('deleted');
    const list = await h.comments.listForPost(IDS.workspace, IDS.post, { limit: 10, cursor: null, sort: 'newest' });
    expect(list.items).toHaveLength(0);
    await expect(
      h.comments.reply(IDS.workspace, parent.id, { text: 'again', idempotencyKey: 'k2' }),
    ).rejects.toMatchObject({
      code: 'reply_target_not_published',
    });
  });

  it('flags the account for re-authorisation when the platform rejects the token', async () => {
    const h = createHarness();
    const parent = await seedAndSync(h);
    h.twitter.failNext('auth', 'token revoked');
    await expect(
      h.comments.reply(IDS.workspace, parent.id, { text: 'hi', idempotencyKey: 'k1' }),
    ).rejects.toMatchObject({
      kind: 'auth',
    });
    expect((await h.repos.accounts.findById(IDS.twitterAccount))?.status).toBe('reauth_required');
    await expect(
      h.comments.reply(IDS.workspace, parent.id, { text: 'hi', idempotencyKey: 'k2' }),
    ).rejects.toMatchObject({
      code: 'account_not_connected',
    });
    await settle(h);
  });

  it('distinguishes direct replies from the whole thread', async () => {
    const h = createHarness();
    const top = h.twitter.seed(IDS.tweet, { body: 'top' });
    const child = h.twitter.seed(IDS.tweet, { body: 'child', externalParentId: top });
    h.twitter.seed(IDS.tweet, { body: 'grandchild', externalParentId: child });
    h.twitter.seed(IDS.tweet, { body: 'second child', externalParentId: top });
    await h.sync.syncPublication(IDS.twitterPublication);
    const rowTop = (await h.repos.comments.findByExternalId(IDS.twitterPublication, top))!;
    const rowChild = (await h.repos.comments.findByExternalId(IDS.twitterPublication, child))!;

    const replies = await h.comments.listReplies(IDS.workspace, rowTop.id, { limit: 10, cursor: null });
    expect(replies.items.map((i) => [i.comment.body, i.replyCount])).toEqual([
      ['child', 1],
      ['second child', 0],
    ]);
    expect((await h.comments.getById(IDS.workspace, rowTop.id)).replyCount).toBe(2);

    const thread = await h.comments.listThread(IDS.workspace, rowTop.id, { limit: 2, cursor: null });
    expect(thread.items.map((i) => i.comment.body)).toEqual(['child', 'grandchild']);
    const rest = await h.comments.listThread(IDS.workspace, rowTop.id, { limit: 2, cursor: thread.nextCursor });
    expect(rest.items.map((i) => i.comment.body)).toEqual(['second child']);

    const subtree = await h.comments.listThread(IDS.workspace, rowChild.id, { limit: 10, cursor: null });
    expect(subtree.items.map((i) => i.comment.body)).toEqual(['grandchild']);
  });

  it('reports each publication separately when an on-demand sync fails for one of them', async () => {
    const h = createHarness();
    h.twitter.seed(IDS.tweet, { body: 'x' });
    h.youtube.seed(IDS.video, { body: 'y' });
    h.youtube.failNext('auth', 'token revoked');

    const { results } = await h.comments.syncPost(IDS.workspace, IDS.post, {});
    expect(results.map((r) => [r.status, r.fetched, r.error?.code ?? null])).toEqual([
      ['ok', 1, null],
      ['failed', 0, 'platform_auth'],
    ]);
    expect((await h.repos.accounts.findById(IDS.youtubeAccount))?.status).toBe('reauth_required');

    // A platform filter that matches no publication is an empty result, not an error.
    expect(await h.comments.syncPost(IDS.workspace, IDS.post, { platform: 'linkedin' })).toEqual({ results: [] });
  });

  it('refuses when the social account is not connected', async () => {
    const h = createHarness();
    const parent = await seedAndSync(h);
    h.repos.accounts.add({ ...(await h.repos.accounts.findById(IDS.twitterAccount))!, status: 'disconnected' });

    await expect(
      h.comments.reply(IDS.workspace, parent.id, { text: 'hi', idempotencyKey: null }),
    ).rejects.toMatchObject({
      code: 'account_not_connected',
    });
  });

  it('is scoped to the workspace', async () => {
    const h = createHarness();
    const parent = await seedAndSync(h);
    await expect(
      h.comments.reply(IDS.otherWorkspace, parent.id, { text: 'hi', idempotencyKey: null }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('adopts the row created by a sync that raced with the platform call instead of duplicating it', async () => {
    const h = createHarness();
    const parent = await seedAndSync(h);
    const original = h.twitter.createReply.bind(h.twitter);
    h.twitter.createReply = async (input: CreateReplyInput) => {
      const result = await original(input);
      await h.sync.syncPublication(IDS.twitterPublication); // sync sees the new reply before we finalise
      return result;
    };

    const { comment } = await h.comments.reply(IDS.workspace, parent.id, { text: 'racy', idempotencyKey: 'k1' });

    expect(comment).toMatchObject({ status: 'published', origin: 'app', idempotencyKey: 'k1', parentId: parent.id });
    const thread = await h.comments.listReplies(IDS.workspace, parent.id, { limit: 10, cursor: null });
    expect(thread.items).toHaveLength(1);
    expect(thread.items[0]!.comment.id).toBe(comment.id);
    expect(await h.repos.comments.findByIdempotencyKey(IDS.workspace, 'k1')).toMatchObject({ id: comment.id });
  });
});

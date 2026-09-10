import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/http/app.js';
import { StaticApiKeyResolver } from '../src/http/auth.js';
import { createHarness, IDS, type Harness, type HarnessOptions } from './helpers.js';

const AUTH = { authorization: 'Bearer test-key' };
const OTHER_AUTH = { authorization: 'Bearer other-key' };
const KEYED = (key: string) => ({ ...AUTH, 'idempotency-key': key, 'content-type': 'application/json' });

function app(h: Harness, rateLimits?: { perMinute?: number; syncPerMinute?: number; replyPerMinute?: number }) {
  return buildApp({
    comments: h.comments,
    apiKeys: new StaticApiKeyResolver({ 'test-key': IDS.workspace, 'other-key': IDS.otherWorkspace }),
    rateLimits,
  });
}

async function seeded(opts: HarnessOptions = {}) {
  const h = createHarness(opts);
  const top = h.twitter.seed(IDS.tweet, { body: 'top', authorHandle: 'alice' });
  const nested = h.twitter.seed(IDS.tweet, { body: 'nested', externalParentId: top });
  h.twitter.seed(IDS.tweet, { body: 'deep', externalParentId: nested });
  h.youtube.seed(IDS.video, { body: 'yt top' });
  await h.sync.syncPublication(IDS.twitterPublication);
  await h.sync.syncPublication(IDS.youtubePublication);
  return { h, server: app(h), topId: (await h.repos.comments.findByExternalId(IDS.twitterPublication, top))!.id };
}

describe('REST API', () => {
  it('requires an API key, ignores prototype names as keys, and says how to authenticate', async () => {
    const { server } = await seeded();
    const res = await server.inject({ method: 'GET', url: `/v1/posts/${IDS.post}/comments` });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.json().error).toMatchObject({ code: 'unauthorized', message: 'Missing or invalid API key' });

    for (const key of ['constructor', '__proto__', 'toString']) {
      const bad = await server.inject({
        method: 'GET',
        url: `/v1/posts/${IDS.post}/comments`,
        headers: { authorization: `Bearer ${key}` },
      });
      expect(bad.statusCode).toBe(401);
    }
  });

  it('answers unknown routes and server errors in the same error shape', async () => {
    const { h, server } = await seeded();
    const missing = await server.inject({ method: 'GET', url: '/v1/nope', headers: AUTH });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');

    h.comments.getById = async () => {
      throw new TypeError('boom');
    };
    const crashed = await server.inject({ method: 'GET', url: `/v1/comments/${IDS.post}`, headers: AUTH });
    expect(crashed.statusCode).toBe(500);
    expect(crashed.json()).toEqual({
      error: { code: 'internal_error', message: 'Internal server error', details: {} },
    });
  });

  it('GET /v1/posts/:postId/comments returns top-level comments with sync metadata', async () => {
    const { server } = await seeded();
    const res = await server.inject({ method: 'GET', url: `/v1/posts/${IDS.post}/comments`, headers: AUTH });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(
      body.data.map((c: { text: string; platform: string; replyCount: number; depth: number }) => [
        c.text,
        c.platform,
        c.replyCount,
        c.depth,
      ]),
    ).toEqual([
      ['yt top', 'youtube', 0, 0],
      ['top', 'twitter', 1, 0],
    ]);
    expect(body.data[1].author).toMatchObject({ handle: 'alice' });
    expect(body.data[1].permalink).toMatch(/^https:\/\/twitter\.example\//);
    expect(body.meta.nextCursor).toBeNull();
    expect(body.meta.publications).toHaveLength(2);
    expect(body.meta.publications[0].sync.status).toBe('idle');
  });

  it('paginates with opaque cursors and validates them', async () => {
    const { server } = await seeded();
    const page1 = await server.inject({ method: 'GET', url: `/v1/posts/${IDS.post}/comments?limit=1`, headers: AUTH });
    const cursor = page1.json().meta.nextCursor as string;
    expect(cursor).toBeTruthy();

    const page2 = await server.inject({
      method: 'GET',
      url: `/v1/posts/${IDS.post}/comments?limit=1&cursor=${cursor}`,
      headers: AUTH,
    });
    expect(page2.json().data[0].text).toBe('top');
    expect(page2.json().meta.nextCursor).toBeNull();

    const bad = await server.inject({
      method: 'GET',
      url: `/v1/posts/${IDS.post}/comments?cursor=not-a-cursor`,
      headers: AUTH,
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.code).toBe('validation_error');

    const forged = Buffer.from(JSON.stringify({ t: '2026-01-01T00:00:00Z', id: 'not-a-uuid' })).toString('base64url');
    const badId = await server.inject({
      method: 'GET',
      url: `/v1/posts/${IDS.post}/comments?cursor=${forged}`,
      headers: AUTH,
    });
    expect(badId.statusCode).toBe(422);

    const badLimit = await server.inject({
      method: 'GET',
      url: `/v1/posts/${IDS.post}/comments?limit=500`,
      headers: AUTH,
    });
    expect(badLimit.statusCode).toBe(400);
    expect(badLimit.json().error.code).toBe('bad_request');
  });

  it('validates ids as uuids and maps domain errors to HTTP statuses', async () => {
    const { server } = await seeded();
    const notUuid = await server.inject({ method: 'GET', url: '/v1/posts/nope/comments', headers: AUTH });
    expect(notUuid.statusCode).toBe(400);

    const missing = await server.inject({ method: 'GET', url: `/v1/posts/${IDS.otherPost}/comments`, headers: AUTH });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('not_found');

    const draft = await server.inject({ method: 'GET', url: `/v1/posts/${IDS.draftPost}/comments`, headers: AUTH });
    expect(draft.statusCode).toBe(409);
    expect(draft.json().error.code).toBe('post_not_published');

    const noSuchPlatform = await server.inject({
      method: 'GET',
      url: `/v1/posts/${IDS.post}/comments?platform=linkedin`,
      headers: AUTH,
    });
    expect(noSuchPlatform.statusCode).toBe(200);
    expect(noSuchPlatform.json()).toMatchObject({ data: [], meta: { publications: [] } });

    const malformed = await server.inject({
      method: 'POST',
      url: `/v1/comments/${IDS.post}/replies`,
      headers: KEYED('m'),
      payload: '{not json',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error).toMatchObject({
      code: 'bad_request',
      details: { originalCode: 'FST_ERR_CTP_INVALID_JSON_BODY' },
    });
  });

  it("never exposes another workspace's resources, on any route", async () => {
    const { server, topId } = await seeded();
    const attempts = [
      { method: 'GET' as const, url: `/v1/posts/${IDS.post}/comments` },
      { method: 'POST' as const, url: `/v1/posts/${IDS.post}/comments/sync` },
      { method: 'GET' as const, url: `/v1/comments/${topId}` },
      { method: 'GET' as const, url: `/v1/comments/${topId}/replies` },
      { method: 'GET' as const, url: `/v1/comments/${topId}/thread` },
      { method: 'POST' as const, url: `/v1/comments/${topId}/replies`, payload: { text: 'hi' } },
    ];
    for (const attempt of attempts) {
      const res = await server.inject({ ...attempt, headers: { ...OTHER_AUTH, 'idempotency-key': 'x' } });
      expect(res.statusCode, `${attempt.method} ${attempt.url}`).toBe(404);
      expect(res.json().error.code).toBe('not_found');
    }
  });

  it('GET .../replies returns direct replies and GET .../thread the whole subtree', async () => {
    const { server, topId } = await seeded();
    const replies = await server.inject({ method: 'GET', url: `/v1/comments/${topId}/replies`, headers: AUTH });
    expect(replies.statusCode).toBe(200);
    expect(
      replies
        .json()
        .data.map((c: { text: string; parentId: string; depth: number; replyCount: number }) => [
          c.text,
          c.depth,
          c.replyCount,
        ]),
    ).toEqual([['nested', 1, 1]]);

    const thread = await server.inject({ method: 'GET', url: `/v1/comments/${topId}/thread`, headers: AUTH });
    expect(thread.json().data.map((c: { text: string; depth: number }) => [c.text, c.depth])).toEqual([
      ['nested', 1],
      ['deep', 2],
    ]);
  });

  it('POST /v1/comments/:id/replies creates a reply and replays on the same Idempotency-Key', async () => {
    const { server, topId } = await seeded();

    const created = await server.inject({
      method: 'POST',
      url: `/v1/comments/${topId}/replies`,
      headers: KEYED('abc'),
      payload: { text: 'Thanks!' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers.location).toBe(`/v1/comments/${created.json().data.id}`);
    expect(created.json().data).toMatchObject({
      text: 'Thanks!',
      status: 'published',
      isOwn: true,
      origin: 'app',
      parentId: topId,
      replyCount: 0,
    });

    const replay = await server.inject({
      method: 'POST',
      url: `/v1/comments/${topId}/replies`,
      headers: KEYED('abc'),
      payload: { text: 'Thanks!' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers.location).toBeUndefined();
    expect(replay.json().data.id).toBe(created.json().data.id);

    const reused = await server.inject({
      method: 'POST',
      url: `/v1/comments/${topId}/replies`,
      headers: KEYED('abc'),
      payload: { text: 'Something else' },
    });
    expect(reused.statusCode).toBe(422);
    expect(reused.json().error.code).toBe('idempotency_key_reused');

    const withoutKey = await server.inject({
      method: 'POST',
      url: `/v1/comments/${topId}/replies`,
      headers: AUTH,
      payload: { text: 'no key' },
    });
    expect(withoutKey.statusCode).toBe(400);
    expect(withoutKey.json().error.details.issues[0].path).toBe('idempotency-key');

    const get = await server.inject({ method: 'GET', url: `/v1/comments/${topId}`, headers: AUTH });
    expect(get.json().data.replyCount).toBe(2);
  });

  it('POST /v1/comments/:id/replies validates the body and surfaces platform failures', async () => {
    const { h, server, topId } = await seeded();
    const post = async (key: string, payload: Record<string, unknown>) =>
      await server.inject({ method: 'POST', url: `/v1/comments/${topId}/replies`, headers: KEYED(key), payload });

    const empty = await post('e1', { text: '   ' });
    expect(empty.statusCode).toBe(422);
    expect(empty.json().error.code).toBe('validation_error');
    const blank = await post('e2', { text: '' });
    expect(blank.statusCode).toBe(422);

    const missing = await post('e3', {});
    expect(missing.statusCode).toBe(400);

    h.twitter.failNext('rate_limited');
    const limited = await post('r1', { text: 'hi' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toMatchObject({
      code: 'platform_rate_limited',
      details: { platform: 'twitter', retryable: true },
    });

    h.twitter.failNext('auth');
    const auth = await post('a1', { text: 'hi' });
    expect(auth.statusCode).toBe(502);
    expect(auth.json().error).toMatchObject({ code: 'platform_auth', details: { action: 'reconnect_account' } });

    h.repos.accounts.add({ ...(await h.repos.accounts.findById(IDS.twitterAccount))!, status: 'connected' });
    h.twitter.failNext('unavailable', 'timeout');
    const unknown = await post('u1', { text: 'hi' });
    expect(unknown.statusCode).toBe(502);
    expect(unknown.json().error).toMatchObject({ code: 'platform_unavailable', details: { outcomeUnknown: true } });
  });

  it('propagates the platform Retry-After header', async () => {
    const { h, server, topId } = await seeded();
    const original = h.twitter.createReply.bind(h.twitter);
    h.twitter.createReply = async () => {
      const { PlatformError } = await import('../src/domain/errors.js');
      throw new PlatformError('twitter', 'rate_limited', 'slow down', { retryAfterSeconds: 42 });
    };
    const res = await server.inject({
      method: 'POST',
      url: `/v1/comments/${topId}/replies`,
      headers: KEYED('ra'),
      payload: { text: 'hi' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('42');
    h.twitter.createReply = original;
  });

  it('reports a publication without an adapter as failed without hiding the others', async () => {
    const { h, server } = await seeded({ withUnsupportedPlatform: true });
    const res = await server.inject({ method: 'POST', url: `/v1/posts/${IDS.post}/comments/sync`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(
      res.json().data.map((r: { status: string; error: { code: string } | null }) => [r.status, r.error?.code ?? null]),
    ).toEqual([
      ['ok', null],
      ['ok', null],
      ['failed', 'platform_not_supported'],
    ]);
    expect((await h.repos.syncStates.get(IDS.instagramPublication))?.status).toBe('failed');
  });

  it('POST /v1/posts/:postId/comments/sync pulls fresh comments', async () => {
    const { h, server } = await seeded();
    h.twitter.seed(IDS.tweet, { body: 'new one' });

    const res = await server.inject({
      method: 'POST',
      url: `/v1/posts/${IDS.post}/comments/sync?platform=twitter`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      {
        publicationId: IDS.twitterPublication,
        status: 'ok',
        reason: null,
        error: null,
        fetched: 1,
        created: 1,
        updated: 0,
        linked: 0,
        reconciled: 0,
        complete: true,
      },
    ]);
  });

  it('rate-limits per workspace, with a stricter limit on sync', async () => {
    const { h } = await seeded();
    const server = app(h, { perMinute: 100, syncPerMinute: 2 });
    const url = `/v1/posts/${IDS.post}/comments/sync?platform=twitter`;
    expect((await server.inject({ method: 'POST', url, headers: AUTH })).statusCode).toBe(200);
    expect((await server.inject({ method: 'POST', url, headers: AUTH })).statusCode).toBe(200);
    const third = await server.inject({ method: 'POST', url, headers: AUTH });
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('rate_limited');
    expect(third.headers['retry-after']).toBeTruthy();
    // Another workspace has its own budget.
    expect(
      (await server.inject({ method: 'POST', url: `/v1/posts/${IDS.otherPost}/comments/sync`, headers: OTHER_AUTH }))
        .statusCode,
    ).toBe(409);
  });
});

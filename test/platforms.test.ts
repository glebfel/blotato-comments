import { describe, expect, it } from 'vitest';
import { PlatformError } from '../src/domain/errors.js';
import type { HttpRequest, HttpResponse } from '../src/platforms/http.js';
import { TwitterCommentProvider } from '../src/platforms/twitter.js';
import { YouTubeCommentProvider } from '../src/platforms/youtube.js';

const creds = { accessToken: 'tok' };
const fetchInput = (externalPostId: string, syncCursor: string | null = null, requestBudget = 20) => ({
  credentials: creds,
  externalPostId,
  pageToken: null,
  syncCursor,
  requestBudget,
});

function stub(responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>) {
  const calls: HttpRequest[] = [];
  const http = async (req: HttpRequest) => {
    calls.push(req);
    return responder(req);
  };
  return { http, calls };
}

const ok = (json: unknown, status = 200, headers: Record<string, string> = {}): HttpResponse => ({
  status,
  headers,
  json,
});

describe('TwitterCommentProvider', () => {
  it('maps conversation search results to normalised comments and skips malformed items', async () => {
    const { http, calls } = stub(() =>
      ok({
        data: [
          {
            id: '3',
            text: 'nested',
            author_id: 'u2',
            created_at: '2026-01-01T00:00:03Z',
            referenced_tweets: [{ type: 'replied_to', id: '2' }],
            public_metrics: { like_count: 1, reply_count: 0 },
          },
          {
            id: '2',
            text: 'top',
            author_id: 'u1',
            created_at: '2026-01-01T00:00:02Z',
            referenced_tweets: [{ type: 'replied_to', id: 'post-1' }],
            public_metrics: { like_count: 5, reply_count: 1 },
          },
          { id: 'post-1', text: 'the post itself', author_id: 'me' },
          { id: '9' }, // no text: skipped
        ],
        includes: { users: [{ id: 'u1', name: 'Alice', username: 'alice', profile_image_url: 'https://img/a.png' }] },
        meta: { newest_id: '3', next_token: 'tok-2' },
      }),
    );
    const provider = new TwitterCommentProvider(http, 'https://x.test/2');

    const result = await provider.fetchComments(fetchInput('post-1', '1'));

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/2/tweets/search/recent');
    expect(url.searchParams.get('query')).toBe('conversation_id:post-1');
    expect(url.searchParams.get('since_id')).toBe('1');
    expect(calls[0]!.headers?.authorization).toBe('Bearer tok');

    expect(result.nextPageToken).toBe('tok-2');
    expect(result.syncCursor).toBe('3');
    expect(result.requestsUsed).toBe(1);
    expect(result.comments).toEqual([
      expect.objectContaining({
        externalId: '3',
        externalParentId: '2',
        authorExternalId: 'u2',
        authorName: null,
        metrics: { likes: 1, platformReplies: 0 },
      }),
      expect.objectContaining({
        externalId: '2',
        externalParentId: null,
        authorName: 'Alice',
        authorHandle: 'alice',
        authorAvatarUrl: 'https://img/a.png',
        permalink: 'https://x.com/alice/status/2',
        metrics: { likes: 5, platformReplies: 1 },
      }),
    ]);
  });

  it('keeps the larger snowflake as the cursor', async () => {
    const { http } = stub(() => ok({ data: [], meta: { newest_id: '99' } }));
    const provider = new TwitterCommentProvider(http, 'https://x.test/2');
    const result = await provider.fetchComments(fetchInput('p', '100'));
    expect(result.syncCursor).toBe('100');
  });

  it('posts replies with in_reply_to_tweet_id', async () => {
    const { http, calls } = stub(() => ok({ data: { id: '42', text: 'hi' } }, 201));
    const provider = new TwitterCommentProvider(http, 'https://x.test/2');
    const result = await provider.createReply({
      credentials: creds,
      externalPostId: 'p',
      parentExternalId: '7',
      rootExternalId: '5',
      text: 'hi',
    });

    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://x.test/2/tweets',
      body: { text: 'hi', reply: { in_reply_to_tweet_id: '7' } },
    });
    expect(result).toMatchObject({
      externalId: '42',
      externalParentId: '7',
      permalink: 'https://x.com/i/web/status/42',
    });
  });

  it('translates HTTP failures into typed platform errors, telling 403-duplicate apart from 403-auth', async () => {
    const at = (res: HttpResponse) => new TwitterCommentProvider(stub(() => res).http, 'https://x.test/2');
    const reply = (p: TwitterCommentProvider) =>
      p.createReply({
        credentials: creds,
        externalPostId: 'p',
        parentExternalId: '7',
        rootExternalId: '5',
        text: 'x',
      });

    const err = await at(ok({ title: 'Too Many Requests' }, 429, { 'retry-after': '30' }))
      .fetchComments(fetchInput('p'))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err).toMatchObject({ kind: 'rate_limited', retryable: true, retryAfterSeconds: 30 });

    await expect(at(ok({ detail: 'expired' }, 401)).fetchComments(fetchInput('p'))).rejects.toMatchObject({
      kind: 'auth',
      retryable: false,
    });
    await expect(
      reply(
        at(ok({ title: 'Forbidden', detail: 'You are not allowed to create a Tweet with duplicate content.' }, 403)),
      ),
    ).rejects.toMatchObject({ kind: 'rejected' });
    await expect(
      reply(at(ok({ title: 'Forbidden', detail: 'Your account is suspended.' }, 403))),
    ).rejects.toMatchObject({
      kind: 'auth',
    });

    const down = new TwitterCommentProvider(async () => {
      throw new Error('ECONNRESET');
    }, 'https://x.test/2');
    await expect(down.fetchComments(fetchInput('p'))).rejects.toMatchObject({ kind: 'unavailable', retryable: true });
  });
});

describe('YouTubeCommentProvider', () => {
  const thread = (id: string, replies: Array<{ id: string; text: string }>, total: number) => ({
    id,
    snippet: {
      totalReplyCount: total,
      topLevelComment: {
        id,
        snippet: {
          textOriginal: `top ${id}`,
          authorDisplayName: 'Eve',
          authorChannelId: { value: 'ch-eve' },
          likeCount: 2,
          publishedAt: '2026-01-01T00:00:00Z',
        },
      },
    },
    replies: {
      comments: replies.map((r) => ({
        id: r.id,
        snippet: { parentId: id, textOriginal: r.text, authorDisplayName: 'Bob', publishedAt: '2026-01-01T00:01:00Z' },
      })),
    },
  });

  it('flattens threads, fetches the remaining replies within the request budget, skips malformed items', async () => {
    const { http, calls } = stub((req) => {
      const url = new URL(req.url);
      if (url.pathname.endsWith('/commentThreads')) {
        return ok({
          items: [
            thread('t1', [{ id: 'r1', text: 'one' }], 1),
            thread('t2', [{ id: 'r2', text: 'two' }], 3),
            { id: 'broken' },
          ],
          nextPageToken: 'next',
        });
      }
      expect(url.searchParams.get('parentId')).toBe('t2');
      return ok({
        items: [
          { id: 'r2', snippet: { parentId: 't2', textOriginal: 'two' } },
          { id: 'r3', snippet: { parentId: 't2', textOriginal: 'three' } },
          { id: 'r4', snippet: { parentId: 't2', textOriginal: 'four' } },
        ],
      });
    });
    const provider = new YouTubeCommentProvider(http, 'https://yt.test/v3');

    const result = await provider.fetchComments(fetchInput('vid'));

    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]!.url).searchParams.get('videoId')).toBe('vid');
    expect(result.nextPageToken).toBe('next');
    expect(result.syncCursor).toBeNull();
    expect(result.requestsUsed).toBe(2);
    expect(result.comments.map((c) => [c.externalId, c.externalParentId])).toEqual([
      ['t1', null],
      ['r1', 't1'],
      ['t2', null],
      ['r2', 't2'],
      ['r3', 't2'],
      ['r4', 't2'],
    ]);
    expect(result.comments[0]).toMatchObject({
      authorExternalId: 'ch-eve',
      authorName: 'Eve',
      metrics: { likes: 2, platformReplies: 1 },
    });

    // With no budget left for sub-requests, only the embedded replies are used.
    const { http: http2, calls: calls2 } = stub(() => ok({ items: [thread('t2', [{ id: 'r2', text: 'two' }], 3)] }));
    const capped = await new YouTubeCommentProvider(http2, 'https://yt.test/v3').fetchComments(
      fetchInput('vid', null, 1),
    );
    expect(calls2).toHaveLength(1);
    expect(capped.comments.map((c) => c.externalId)).toEqual(['t2', 'r2']);
    expect(capped.requestsUsed).toBe(1);
  });

  it('replies to the thread root because the platform is single-level', async () => {
    const { http, calls } = stub(() =>
      ok({ id: 'new', snippet: { parentId: 'root', publishedAt: '2026-01-02T00:00:00Z' } }),
    );
    const provider = new YouTubeCommentProvider(http, 'https://yt.test/v3');
    const result = await provider.createReply({
      credentials: creds,
      externalPostId: 'vid',
      parentExternalId: 'child',
      rootExternalId: 'root',
      text: 'hey',
    });

    expect(calls[0]).toMatchObject({ method: 'POST', body: { snippet: { parentId: 'root', textOriginal: 'hey' } } });
    expect(result).toEqual({
      externalId: 'new',
      externalParentId: 'root',
      permalink: 'https://www.youtube.com/watch?v=vid&lc=new',
      postedAt: new Date('2026-01-02T00:00:00Z'),
    });
  });

  it('classifies Google 403 reasons: quota is a rate limit, disabled comments is a rejection', async () => {
    const at = (reason: string) =>
      new YouTubeCommentProvider(
        stub(() => ok({ error: { code: 403, message: reason, errors: [{ reason, domain: 'youtube.quota' }] } }, 403))
          .http,
        'https://yt.test/v3',
      );
    await expect(at('quotaExceeded').fetchComments(fetchInput('vid'))).rejects.toMatchObject({
      kind: 'rate_limited',
      retryable: true,
    });
    await expect(at('commentsDisabled').fetchComments(fetchInput('vid'))).rejects.toMatchObject({ kind: 'rejected' });
    await expect(at('insufficientPermissions').fetchComments(fetchInput('vid'))).rejects.toMatchObject({
      kind: 'auth',
    });
    await expect(at('somethingNew').fetchComments(fetchInput('vid'))).rejects.toMatchObject({ kind: 'auth' }); // generic 403 fallback
  });
});

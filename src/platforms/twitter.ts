import type { PlatformErrorKind } from '../domain/errors.js';
import type { Platform } from '../domain/types.js';
import { extractMessage, fetchHttpClient, send, throwForStatus, type HttpClient, type HttpResponse } from './http.js';
import type {
  CommentProvider,
  CreateReplyInput,
  CreateReplyResult,
  ExternalComment,
  FetchCommentsInput,
  FetchCommentsResult,
  PlatformCapabilities,
} from './provider.js';

/**
 * X (Twitter) adapter, X API v2.
 *
 * "Comments" on X are replies in the tweet's conversation. We fetch them with
 * recent search on `conversation_id:<tweet id>`. Notes that shaped the design:
 *   - Recent search only covers the last 7 days. Persisting comments locally is
 *     therefore not just a cache: it is the only way to keep older replies.
 *   - Tweet ids are time-ordered snowflakes, so the newest id seen is a natural
 *     incremental cursor (`since_id`).
 *   - Threads nest arbitrarily; `referenced_tweets[type=replied_to]` gives the parent.
 *   - X answers 403 for several non-auth situations (duplicate text, reply restrictions),
 *     so the generic status mapping is refined by the response's `detail`.
 *   - Length is checked in UTF-16 units; X counts "weighted" characters (URLs = 23, CJK = 2).
 *     Good enough as a pre-check; the platform's own answer is authoritative (422 platform_rejected).
 *
 * Built from the public API reference; not executed against the live API in this repo.
 */

interface TweetUser {
  id: string;
  name?: string;
  username?: string;
  profile_image_url?: string;
}

interface Tweet {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  referenced_tweets?: Array<{ type: string; id: string }>;
  public_metrics?: { like_count?: number; reply_count?: number; retweet_count?: number };
}

interface SearchResponse {
  data?: Tweet[];
  includes?: { users?: TweetUser[] };
  meta?: { newest_id?: string; next_token?: string; result_count?: number };
}

interface CreateTweetResponse {
  data?: { id: string; text: string };
}

/** 403s that are about the request, not about our credentials. */
const REJECTED_403 = /duplicate|not allowed to (reply|create)|restricted|can(?:'|no)t reply|limited who can reply/i;

export class TwitterCommentProvider implements CommentProvider {
  readonly platform: Platform = 'twitter';
  readonly capabilities: PlatformCapabilities = {
    threading: 'nested',
    maxReplyLength: 280,
    incrementalSync: true,
  };

  constructor(
    private readonly http: HttpClient = fetchHttpClient,
    private readonly baseUrl = 'https://api.x.com/2',
  ) {}

  async fetchComments(input: FetchCommentsInput): Promise<FetchCommentsResult> {
    const params = new URLSearchParams({
      query: `conversation_id:${input.externalPostId}`,
      'tweet.fields': 'author_id,created_at,conversation_id,referenced_tweets,public_metrics',
      expansions: 'author_id',
      'user.fields': 'name,username,profile_image_url',
      max_results: '100',
    });
    if (input.pageToken) params.set('next_token', input.pageToken);
    if (input.syncCursor) params.set('since_id', input.syncCursor);

    const res = await send(this.platform, this.http, {
      method: 'GET',
      url: `${this.baseUrl}/tweets/search/recent?${params.toString()}`,
      headers: { authorization: `Bearer ${input.credentials.accessToken}` },
    });
    if (res.status !== 200) throwForStatus(this.platform, res, 'search', classify);

    const body = (res.json ?? {}) as SearchResponse;
    const users = new Map((body.includes?.users ?? []).map((u) => [u.id, u]));

    const comments: ExternalComment[] = (body.data ?? [])
      // Skip the post itself (a conversation search can include it) and malformed items.
      .filter((t) => typeof t?.id === 'string' && typeof t.text === 'string' && t.id !== input.externalPostId)
      .map((t) => {
        const author = t.author_id ? users.get(t.author_id) : undefined;
        const repliedTo = t.referenced_tweets?.find((r) => r.type === 'replied_to')?.id ?? null;
        return {
          externalId: t.id,
          externalParentId: repliedTo === input.externalPostId ? null : repliedTo,
          authorExternalId: t.author_id ?? null,
          authorName: author?.name ?? null,
          authorHandle: author?.username ?? null,
          authorAvatarUrl: author?.profile_image_url ?? null,
          body: t.text,
          permalink: tweetUrl(author?.username, t.id),
          postedAt: t.created_at ? new Date(t.created_at) : new Date(),
          metrics: {
            likes: t.public_metrics?.like_count ?? 0,
            platformReplies: t.public_metrics?.reply_count ?? 0,
          },
        };
      });

    return {
      comments,
      nextPageToken: body.meta?.next_token ?? null,
      syncCursor: maxSnowflake(input.syncCursor, body.meta?.newest_id ?? null),
      requestsUsed: 1,
    };
  }

  async createReply(input: CreateReplyInput): Promise<CreateReplyResult> {
    const res = await send(this.platform, this.http, {
      method: 'POST',
      url: `${this.baseUrl}/tweets`,
      headers: { authorization: `Bearer ${input.credentials.accessToken}` },
      body: { text: input.text, reply: { in_reply_to_tweet_id: input.parentExternalId } },
    });
    if (res.status !== 201 && res.status !== 200) throwForStatus(this.platform, res, 'create reply', classify);

    const body = (res.json ?? {}) as CreateTweetResponse;
    if (typeof body.data?.id !== 'string') {
      throwForStatus(this.platform, { ...res, status: 502 }, 'create reply (malformed response)');
    }

    return {
      externalId: body.data.id,
      externalParentId: input.parentExternalId,
      permalink: tweetUrl(undefined, body.data.id),
      postedAt: new Date(),
    };
  }
}

/** X resolves /i/web/status/{id} to the right handle, so a link works even before we know the author. */
function tweetUrl(handle: string | undefined, id: string): string {
  return handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/web/status/${id}`;
}

function classify(res: HttpResponse): PlatformErrorKind | null {
  if (res.status === 403 && REJECTED_403.test(extractMessage(res.json) ?? '')) return 'rejected';
  return null;
}

/** Snowflake ids are 64-bit integers; compare numerically, not lexically. */
function maxSnowflake(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  try {
    return BigInt(a) >= BigInt(b) ? a : b;
  } catch {
    return b;
  }
}

import type { PlatformErrorKind } from '../domain/errors.js';
import type { Platform } from '../domain/types.js';
import { fetchHttpClient, send, throwForStatus, type HttpClient, type HttpResponse } from './http.js';
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
 * YouTube adapter, Data API v3.
 *
 * Shape of the platform that shaped the adapter:
 *   - Comments are one level deep: commentThreads (top-level) -> comments (replies).
 *     A "reply to a reply" is posted as a reply to the thread root; that is what the
 *     YouTube UI does too. We report the real parent back so local state stays truthful.
 *   - commentThreads?order=time returns newest threads first, embeds up to 5 replies and
 *     tells us totalReplyCount, so we know when to fetch the rest via comments?parentId=.
 *     Those sub-requests are counted against the run's request budget; what does not fit
 *     is picked up by a later run.
 *   - There is no "since" filter, hence incrementalSync = false: every run is a bounded
 *     newest-first walk.
 *   - Quota matters (list = 1 unit, insert = 50 units, 10k units/day by default): one reason
 *     polling frequency decays with post age (see docs/DESIGN.md). Quota errors come back as
 *     403 with a `reason`, which the classifier turns into `rate_limited`, not `auth`.
 *
 * Built from the public API reference; not executed against the live API in this repo.
 */

interface CommentSnippet {
  parentId?: string;
  textOriginal?: string;
  textDisplay?: string;
  authorDisplayName?: string;
  authorProfileImageUrl?: string;
  authorChannelId?: { value?: string };
  likeCount?: number;
  publishedAt?: string;
}

interface CommentResource {
  id: string;
  snippet: CommentSnippet;
}

interface CommentThreadResource {
  id: string;
  snippet: { totalReplyCount?: number; topLevelComment: CommentResource };
  replies?: { comments?: CommentResource[] };
}

interface ListResponse<T> {
  items?: T[];
  nextPageToken?: string;
}

interface GoogleErrorBody {
  error?: { errors?: Array<{ reason?: string; domain?: string }> };
}

const REASON_KIND: Record<string, PlatformErrorKind> = {
  quotaExceeded: 'rate_limited',
  dailyLimitExceeded: 'rate_limited',
  rateLimitExceeded: 'rate_limited',
  userRateLimitExceeded: 'rate_limited',
  commentsDisabled: 'rejected',
  forbidden: 'rejected',
  ineligibleAccount: 'rejected',
  operationNotSupported: 'rejected',
  processingFailure: 'unavailable',
  backendError: 'unavailable',
  videoNotFound: 'not_found',
  commentNotFound: 'not_found',
  authError: 'auth',
  authorizationRequired: 'auth',
  insufficientPermissions: 'auth',
};

export class YouTubeCommentProvider implements CommentProvider {
  readonly platform: Platform = 'youtube';
  readonly capabilities: PlatformCapabilities = {
    threading: 'single-level',
    maxReplyLength: 10_000,
    incrementalSync: false,
  };

  constructor(
    private readonly http: HttpClient = fetchHttpClient,
    private readonly baseUrl = 'https://www.googleapis.com/youtube/v3',
  ) {}

  async fetchComments(input: FetchCommentsInput): Promise<FetchCommentsResult> {
    const params = new URLSearchParams({
      part: 'snippet,replies',
      videoId: input.externalPostId,
      maxResults: '100',
      order: 'time',
      textFormat: 'plainText',
    });
    if (input.pageToken) params.set('pageToken', input.pageToken);

    const res = await this.get(`${this.baseUrl}/commentThreads?${params.toString()}`, input, 'list comment threads');
    let requestsUsed = 1;

    const body = (res.json ?? {}) as ListResponse<CommentThreadResource>;
    const comments: ExternalComment[] = [];

    for (const thread of body.items ?? []) {
      const top = thread?.snippet?.topLevelComment;
      if (!top || typeof top.id !== 'string' || !top.snippet) continue; // malformed item: skip, do not fail the run
      comments.push(toExternal(top, null, thread.snippet.totalReplyCount ?? 0, input.externalPostId));

      const embedded = thread.replies?.comments ?? [];
      const total = thread.snippet.totalReplyCount ?? embedded.length;
      let replies = embedded;
      if (embedded.length < total && requestsUsed < input.requestBudget) {
        const fetched = await this.fetchReplies(input, top.id, input.requestBudget - requestsUsed);
        requestsUsed += fetched.requestsUsed;
        replies = fetched.items;
      }
      for (const reply of replies) {
        if (typeof reply?.id !== 'string' || !reply.snippet) continue;
        comments.push(toExternal(reply, top.id, 0, input.externalPostId));
      }
    }

    return { comments, nextPageToken: body.nextPageToken ?? null, syncCursor: null, requestsUsed };
  }

  async createReply(input: CreateReplyInput): Promise<CreateReplyResult> {
    // YouTube only accepts replies to top-level comments.
    const parentId = input.rootExternalId;
    const res = await send(this.platform, this.http, {
      method: 'POST',
      url: `${this.baseUrl}/comments?part=snippet`,
      headers: { authorization: `Bearer ${input.credentials.accessToken}` },
      body: { snippet: { parentId, textOriginal: input.text } },
    });
    if (res.status !== 200 && res.status !== 201) throwForStatus(this.platform, res, 'create reply', classify);

    const body = (res.json ?? {}) as Partial<CommentResource>;
    if (typeof body.id !== 'string') {
      throwForStatus(this.platform, { ...res, status: 502 }, 'create reply (malformed response)');
    }

    return {
      externalId: body.id,
      externalParentId: body.snippet?.parentId ?? parentId,
      permalink: commentUrl(input.externalPostId, body.id),
      postedAt: body.snippet?.publishedAt ? new Date(body.snippet.publishedAt) : new Date(),
    };
  }

  private async fetchReplies(
    input: FetchCommentsInput,
    parentId: string,
    budget: number,
  ): Promise<{ items: CommentResource[]; requestsUsed: number }> {
    const items: CommentResource[] = [];
    let requestsUsed = 0;
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ part: 'snippet', parentId, maxResults: '100', textFormat: 'plainText' });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await this.get(`${this.baseUrl}/comments?${params.toString()}`, input, 'list replies');
      requestsUsed++;
      const body = (res.json ?? {}) as ListResponse<CommentResource>;
      items.push(...(body.items ?? []));
      pageToken = body.nextPageToken;
    } while (pageToken && requestsUsed < budget);
    return { items, requestsUsed };
  }

  private async get(url: string, input: FetchCommentsInput, context: string): Promise<HttpResponse> {
    const res = await send(this.platform, this.http, {
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${input.credentials.accessToken}` },
    });
    if (res.status !== 200) throwForStatus(this.platform, res, context, classify);
    return res;
  }
}

function classify(res: HttpResponse): PlatformErrorKind | null {
  const reason = (res.json as GoogleErrorBody | null)?.error?.errors?.[0]?.reason;
  return reason ? (REASON_KIND[reason] ?? null) : null;
}

function commentUrl(videoId: string, commentId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&lc=${encodeURIComponent(commentId)}`;
}

function toExternal(
  c: CommentResource,
  parentId: string | null,
  platformReplies: number,
  videoId: string,
): ExternalComment {
  const s = c.snippet;
  return {
    externalId: c.id,
    externalParentId: parentId ?? s.parentId ?? null,
    authorExternalId: s.authorChannelId?.value ?? null,
    authorName: s.authorDisplayName ?? null,
    authorHandle: null,
    authorAvatarUrl: s.authorProfileImageUrl ?? null,
    body: s.textOriginal ?? s.textDisplay ?? '',
    permalink: commentUrl(videoId, c.id),
    postedAt: s.publishedAt ? new Date(s.publishedAt) : new Date(),
    metrics: { likes: s.likeCount ?? 0, platformReplies },
  };
}

import { PlatformError, type PlatformErrorKind } from '../domain/errors.js';
import { PLATFORMS, systemClock, type Clock, type Platform } from '../domain/types.js';
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
 * In-memory simulation of a platform. Used by tests and by DEMO_MODE so the API can
 * be exercised end-to-end without real credentials. Supports pagination, an
 * incremental cursor (monotonic sequence number) and injected failures.
 */
export interface FakeComment extends ExternalComment {
  seq: number;
}

export interface FakeProviderOptions {
  platform: Platform;
  threading?: PlatformCapabilities['threading'];
  maxReplyLength?: number;
  incrementalSync?: boolean;
  pageSize?: number;
  /** Author id used for replies created through createReply. */
  ownAccountId?: string;
  /** Source of `postedAt` for replies created through createReply (tests pass a fixed clock). */
  clock?: Clock;
  /** Base timestamp for seeded comments (seq seconds are added). Defaults to 2026-01-01 + platform index hours. */
  postedAtBase?: Date;
}

export class FakeCommentProvider implements CommentProvider {
  readonly platform: Platform;
  readonly capabilities: PlatformCapabilities;

  private readonly store = new Map<string, FakeComment[]>();
  private readonly pageSize: number;
  private readonly ownAccountId: string;
  private readonly clock: Clock;
  private readonly postedAtBase: Date;
  private seq = 0;
  private nextFailure: { kind: PlatformErrorKind; message: string; afterApply: boolean } | null = null;
  readonly calls: { fetch: number; reply: number } = { fetch: 0, reply: 0 };

  constructor(options: FakeProviderOptions) {
    this.platform = options.platform;
    this.capabilities = {
      threading: options.threading ?? 'nested',
      maxReplyLength: options.maxReplyLength ?? 280,
      incrementalSync: options.incrementalSync ?? true,
    };
    this.pageSize = options.pageSize ?? 100;
    this.ownAccountId = options.ownAccountId ?? 'own-account';
    this.clock = options.clock ?? systemClock;
    this.postedAtBase = options.postedAtBase ?? new Date(Date.UTC(2026, 0, 1, PLATFORMS.indexOf(this.platform)));
  }

  /** Adds a comment "on the platform". Returns the assigned external id. */
  seed(
    externalPostId: string,
    comment: Partial<Omit<ExternalComment, 'externalId'>> & { externalId?: string; body: string },
  ): string {
    const list = this.store.get(externalPostId) ?? [];
    const seq = ++this.seq;
    const full: FakeComment = {
      externalId: comment.externalId ?? `${this.platform}-c${seq}`,
      externalParentId: comment.externalParentId ?? null,
      authorExternalId: comment.authorExternalId ?? `user-${seq}`,
      authorName: comment.authorName ?? `User ${seq}`,
      authorHandle: comment.authorHandle ?? `user${seq}`,
      authorAvatarUrl: comment.authorAvatarUrl ?? null,
      body: comment.body,
      permalink: comment.permalink ?? `https://${this.platform}.example/${externalPostId}/${seq}`,
      // Deterministic and unique per (platform, seq); tests that care about cross-platform order set postedAt.
      postedAt: comment.postedAt ?? new Date(this.postedAtBase.getTime() + seq * 1000),
      metrics: comment.metrics ?? { likes: 0 },
      seq,
    };
    list.push(full);
    this.store.set(externalPostId, list);
    return full.externalId;
  }

  all(externalPostId: string): FakeComment[] {
    return [...(this.store.get(externalPostId) ?? [])];
  }

  /**
   * Make the next call fail. With `afterApply`, createReply first stores the reply "on the
   * platform" and then throws, simulating a request that was applied but whose response was lost.
   */
  failNext(kind: PlatformErrorKind, message = `simulated ${kind}`, options: { afterApply?: boolean } = {}): void {
    this.nextFailure = { kind, message, afterApply: options.afterApply ?? false };
  }

  async fetchComments(input: FetchCommentsInput): Promise<FetchCommentsResult> {
    this.calls.fetch++;
    this.maybeFail();
    const since = this.capabilities.incrementalSync && input.syncCursor ? Number(input.syncCursor) : 0;
    const offset = input.pageToken ? Number(input.pageToken) : 0;

    // Newest first, like most platform APIs.
    const all = this.all(input.externalPostId)
      .filter((c) => c.seq > since)
      .sort((a, b) => b.seq - a.seq);
    const page = all.slice(offset, offset + this.pageSize);
    const hasMore = offset + this.pageSize < all.length;
    const newest = all[0]?.seq ?? since;

    return {
      comments: page.map(({ seq: _seq, ...rest }) => rest),
      nextPageToken: hasMore ? String(offset + this.pageSize) : null,
      syncCursor: this.capabilities.incrementalSync ? String(Math.max(newest, since)) : null,
      requestsUsed: 1,
    };
  }

  async createReply(input: CreateReplyInput): Promise<CreateReplyResult> {
    this.calls.reply++;
    const failAfter = this.nextFailure?.afterApply ? this.nextFailure : null;
    if (!failAfter) this.maybeFail();
    const parentId = this.capabilities.threading === 'single-level' ? input.rootExternalId : input.parentExternalId;
    const exists = this.all(input.externalPostId).some((c) => c.externalId === parentId);
    if (!exists) {
      throw new PlatformError(this.platform, 'not_found', `comment ${parentId} not found`, { retryable: false });
    }
    const postedAt = this.clock.now();
    const externalId = this.seed(input.externalPostId, {
      externalParentId: parentId,
      authorExternalId: this.ownAccountId,
      authorName: 'Own account',
      body: input.text,
      postedAt,
    });
    if (failAfter) this.maybeFail();
    return { externalId, externalParentId: parentId, permalink: null, postedAt };
  }

  private maybeFail(): void {
    if (!this.nextFailure) return;
    const { kind, message } = this.nextFailure;
    this.nextFailure = null;
    throw new PlatformError(this.platform, kind, message);
  }
}

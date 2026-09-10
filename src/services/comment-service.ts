import { createHash, randomUUID } from 'node:crypto';
import { assertConnected } from '../domain/accounts.js';
import {
  DomainError,
  NotFoundError,
  PlatformError,
  UniqueViolationError,
  ValidationError,
  platformKindFromCode,
  toPublicError,
} from '../domain/errors.js';
import type {
  Clock,
  Comment,
  CommentSyncState,
  PageCursor,
  Platform,
  PostPublication,
  SocialAccount,
  SortOrder,
} from '../domain/types.js';
import type { Logger } from '../logger.js';
import type { CredentialsProvider } from '../platforms/credentials.js';
import type { CommentProvider } from '../platforms/provider.js';
import type { ProviderRegistry } from '../platforms/registry.js';
import type { Repositories } from '../repositories/interfaces.js';
import { readStaleAfterMs } from './schedule.js';
import { failedSyncResult, type CommentSyncService, type SyncMode, type SyncResult } from './sync-service.js';

export interface CommentWithCount {
  comment: Comment;
  replyCount: number;
}

export interface PublicationSyncView {
  publication: PostPublication;
  sync: CommentSyncState | null;
}

export interface ListForPostInput {
  platform?: Platform;
  limit: number;
  cursor: PageCursor | null;
  sort: SortOrder;
}

export interface ListForPostResult {
  items: CommentWithCount[];
  nextCursor: PageCursor | null;
  publications: PublicationSyncView[];
}

export interface PageInput {
  limit: number;
  cursor: PageCursor | null;
}

export interface ListResult {
  items: CommentWithCount[];
  nextCursor: PageCursor | null;
}

export interface ReplyInput {
  text: string;
  idempotencyKey: string | null;
}

export interface ReplyResult extends CommentWithCount {
  /** False when an idempotent replay returned the previously created reply. */
  created: boolean;
}

export interface CommentServiceDeps {
  repos: Repositories;
  providers: ProviderRegistry;
  credentials: CredentialsProvider;
  sync: CommentSyncService;
  clock: Clock;
  logger: Logger;
  /** Reads older than this kick off a background refresh (stale-while-revalidate); grows with post age. */
  staleAfterMs?: number;
  /** Upper bound of the age-scaled read cooldown. */
  staleMaxMs?: number;
}

/** Everything a reply needs to know about where it is going. */
interface ReplyTarget {
  parent: Comment;
  root: Comment;
  publication: PostPublication;
  account: SocialAccount;
  provider: CommentProvider;
}

export class CommentService {
  private readonly staleAfterMs: number;
  private readonly staleMaxMs: number;

  constructor(private readonly deps: CommentServiceDeps) {
    this.staleAfterMs = deps.staleAfterMs ?? 2 * 60_000;
    this.staleMaxMs = deps.staleMaxMs ?? 60 * 60_000;
  }

  async listForPost(workspaceId: string, postId: string, input: ListForPostInput): Promise<ListForPostResult> {
    const { repos } = this.deps;
    const publications = await this.requirePublications(workspaceId, postId, input.platform);
    const states = await repos.syncStates.listByPublications(publications.map((p) => p.id));
    const stateById = new Map(states.map((s) => [s.publicationId, s]));

    for (const publication of publications) this.revalidateIfStale(publication, stateById.get(publication.id) ?? null);

    const page = await repos.comments.listTopLevel({
      publicationIds: publications.map((p) => p.id),
      limit: input.limit,
      cursor: input.cursor,
      sort: input.sort,
    });
    return {
      items: await this.withCounts(page.items),
      nextCursor: page.nextCursor,
      publications: publications.map((publication) => ({ publication, sync: stateById.get(publication.id) ?? null })),
    };
  }

  async getById(workspaceId: string, commentId: string): Promise<CommentWithCount> {
    const comment = await this.requireComment(workspaceId, commentId);
    return (await this.withCounts([comment]))[0]!;
  }

  /** Direct replies of a comment, oldest first. */
  async listReplies(workspaceId: string, commentId: string, input: PageInput): Promise<ListResult> {
    const comment = await this.requireComment(workspaceId, commentId);
    const page = await this.deps.repos.comments.listChildren({ parentId: comment.id, ...input });
    return { items: await this.withCounts(page.items), nextCursor: page.nextCursor };
  }

  /** Whole subtree under a comment (any depth), oldest first; clients rebuild the tree via parentId. */
  async listThread(workspaceId: string, commentId: string, input: PageInput): Promise<ListResult> {
    const comment = await this.requireComment(workspaceId, commentId);
    const page = await this.deps.repos.comments.listDescendants({
      rootId: comment.rootId,
      threadPath: comment.threadPath,
      depth: comment.depth,
      ...input,
    });
    return { items: await this.withCounts(page.items), nextCursor: page.nextCursor };
  }

  /**
   * Reply to a comment. Write path:
   *   1. Idempotency-Key seen before -> replay (see `replay` for the rules per status)
   *   2. validate target, account and text against the platform's capabilities
   *   3. persist a `pending` row (the unique key index makes concurrent retries collide here)
   *   4. call the platform
   *   5. mark the row `published`, `failed` (platform said no) or leave it `pending` with the error
   *      when the outcome is unknown (timeout, 5xx); the sync reconciles those later
   */
  async reply(workspaceId: string, commentId: string, input: ReplyInput): Promise<ReplyResult> {
    const { repos } = this.deps;
    const text = input.text.trim();

    if (input.idempotencyKey) {
      const existing = await repos.comments.findByIdempotencyKey(workspaceId, input.idempotencyKey);
      if (existing) return this.replay(workspaceId, existing, commentId, text);
    }

    const target = await this.loadReplyTarget(workspaceId, commentId);
    this.validateText(text, target);

    const now = this.deps.clock.now();
    const id = randomUUID();
    const pending: Comment = {
      id,
      workspaceId,
      publicationId: target.publication.id,
      platform: target.publication.platform,
      externalId: null,
      externalParentId: target.parent.externalId,
      parentId: target.parent.id,
      rootId: target.parent.rootId,
      threadPath: `${target.parent.threadPath}/${id}`,
      depth: target.parent.depth + 1,
      author: {
        externalId: target.account.externalAccountId,
        name: target.account.displayName,
        handle: target.account.handle,
        avatarUrl: target.account.avatarUrl,
      },
      isOwn: true,
      body: text,
      permalink: null,
      origin: 'app',
      status: 'pending',
      idempotencyKey: input.idempotencyKey,
      idempotencyFingerprint: input.idempotencyKey ? fingerprintOf(commentId, text) : null,
      error: null,
      metrics: {},
      postedAt: now,
      syncedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    try {
      await repos.comments.insert(pending);
    } catch (err) {
      if (err instanceof UniqueViolationError) {
        // Two requests with the same key raced; the other one owns delivery.
        throw new DomainError('reply_in_progress', 'A reply with this Idempotency-Key is being delivered', {
          reason: 'in_flight',
        });
      }
      throw err;
    }

    return this.deliver(pending, target);
  }

  /**
   * On-demand sync of every publication of a post. Failures are isolated per publication so the
   * result of X is not lost because YouTube's token expired.
   */
  async syncPost(
    workspaceId: string,
    postId: string,
    input: { platform?: Platform; mode?: SyncMode },
  ): Promise<{ results: SyncResult[] }> {
    const publications = await this.requirePublications(workspaceId, postId, input.platform);
    const results: SyncResult[] = [];
    for (const publication of publications) {
      try {
        results.push(await this.deps.sync.syncPublication(publication.id, { mode: input.mode, trigger: 'manual' }));
      } catch (err) {
        results.push(failedSyncResult(publication.id, err));
      }
    }
    return { results };
  }

  /**
   * Same key, same request -> same outcome, without touching the platform again:
   *   published        -> the reply
   *   pending          -> 409 (in flight, or awaiting reconciliation after an unknown outcome)
   *   failed/retryable -> the platform definitely did not post it: deliver again on the same row
   *   failed/final     -> the original error again (a new key is needed after fixing the input)
   * Same key, different request -> 422, never a silent replay.
   */
  private async replay(workspaceId: string, existing: Comment, commentId: string, text: string): Promise<ReplyResult> {
    if (existing.idempotencyFingerprint !== fingerprintOf(commentId, text)) {
      throw new DomainError(
        'idempotency_key_reused',
        'This Idempotency-Key was already used with a different request',
        {
          commentId: existing.parentId,
        },
      );
    }
    switch (existing.status) {
      case 'published':
      case 'deleted':
        return { ...(await this.withCounts([existing]))[0]!, created: false };
      case 'pending':
        throw new DomainError('reply_in_progress', 'A reply with this Idempotency-Key is being delivered', {
          reason: existing.error ? 'awaiting_reconciliation' : 'in_flight',
          commentId: existing.id,
        });
      case 'failed': {
        if (!existing.error?.retryable) throw storedFailure(existing);
        const target = await this.loadReplyTarget(workspaceId, existing.parentId ?? '');
        this.validateText(text, target);
        const retry: Comment = { ...existing, status: 'pending', updatedAt: this.deps.clock.now() };
        await this.deps.repos.comments.update(retry);
        return this.deliver(retry, target);
      }
    }
  }

  private async loadReplyTarget(workspaceId: string, commentId: string): Promise<ReplyTarget> {
    const { repos, providers } = this.deps;
    const parent = await this.requireComment(workspaceId, commentId);
    if (parent.status !== 'published' || parent.externalId === null) {
      throw new DomainError('reply_target_not_published', `Cannot reply to a comment with status "${parent.status}"`, {
        commentId,
        status: parent.status,
      });
    }
    const publication = await repos.publications.findById(parent.publicationId);
    if (!publication) throw new NotFoundError('publication', parent.publicationId);
    const account = assertConnected(
      await repos.accounts.findById(publication.socialAccountId),
      publication.socialAccountId,
    );
    const provider = providers.get(publication.platform);
    const root = parent.depth === 0 ? parent : await this.requireComment(workspaceId, parent.rootId);
    if (root.externalId === null)
      throw new DomainError('reply_target_not_published', 'Thread root is not published yet');
    return { parent, root, publication, account, provider };
  }

  private validateText(text: string, target: ReplyTarget): void {
    if (text.length === 0) throw new ValidationError('Reply text must not be empty');
    const max = target.provider.capabilities.maxReplyLength;
    if (text.length > max) {
      throw new ValidationError(`Reply text exceeds the ${target.publication.platform} limit of ${max} characters`, {
        maxLength: max,
        length: text.length,
      });
    }
  }

  /** Steps 4-5 of the write path. `row` is already persisted as pending. */
  private async deliver(row: Comment, target: ReplyTarget): Promise<ReplyResult> {
    const { repos, credentials, clock, logger } = this.deps;
    const { parent, root, publication, account, provider } = target;

    let result;
    try {
      result = await provider.createReply({
        credentials: await credentials.getForAccount(account),
        externalPostId: publication.externalPostId,
        parentExternalId: parent.externalId!,
        rootExternalId: root.externalId!,
        text: row.body,
      });
    } catch (err) {
      const platformErr = err instanceof PlatformError ? err : null;
      // Unknown outcome (timeout, 5xx): the platform may have posted it. Keep the row pending and
      // let the sync reconcile it; a retry now could double-post.
      const outcomeUnknown = platformErr?.outcomeUnknown ?? false;
      const recorded: Comment = {
        ...row,
        status: outcomeUnknown ? 'pending' : 'failed',
        error: {
          code: platformErr?.code ?? 'internal',
          message: toPublicError(err).message,
          retryable: platformErr ? platformErr.retryable && !outcomeUnknown : false,
        },
        updatedAt: clock.now(),
      };
      await repos.comments.update(recorded);
      if (outcomeUnknown) await this.deps.sync.scheduleReconciliation(publication.id);
      if (platformErr?.kind === 'not_found') {
        // The platform says the target is gone; reflect that instead of letting the next reply fail too.
        await repos.comments.update({ ...parent, status: 'deleted', updatedAt: clock.now() });
      } else if (platformErr?.kind === 'auth') {
        await repos.accounts.setStatus(account.id, 'reauth_required');
      }
      logger.warn('reply delivery failed', {
        commentId: row.id,
        platform: publication.platform,
        outcomeUnknown,
        error: recorded.error,
      });
      throw err;
    }

    // Single-level platforms attach a reply-to-a-reply to the thread root. Mirror what the
    // platform did rather than what the user asked for, so the local tree stays truthful.
    let attachTo = parent;
    if (result.externalParentId && result.externalParentId !== parent.externalId) {
      attachTo = (await repos.comments.findByExternalId(publication.id, result.externalParentId)) ?? parent;
    }

    const published: Comment = {
      ...row,
      externalId: result.externalId,
      externalParentId: result.externalParentId,
      parentId: attachTo.id,
      rootId: attachTo.rootId,
      threadPath: `${attachTo.threadPath}/${row.id}`,
      depth: attachTo.depth + 1,
      permalink: result.permalink,
      status: 'published',
      error: null,
      postedAt: result.postedAt,
      syncedAt: clock.now(),
      updatedAt: clock.now(),
    };

    try {
      await repos.comments.update(published);
      return { comment: published, replyCount: 0, created: true };
    } catch (err) {
      if (!(err instanceof UniqueViolationError)) throw err;
      // A sync ran between the platform call and this update and already inserted the comment
      // under its external id. Adopt that row (atomically with dropping the pending one).
      const adopted = await repos.comments.findByExternalId(publication.id, result.externalId);
      if (!adopted) throw err;
      const merged: Comment = {
        ...adopted,
        origin: 'app',
        idempotencyKey: row.idempotencyKey,
        idempotencyFingerprint: row.idempotencyFingerprint,
        error: null,
        updatedAt: clock.now(),
      };
      await repos.comments.replacePending(row.id, merged);
      return { ...(await this.withCounts([merged]))[0]!, created: true };
    }
  }

  private async requireComment(workspaceId: string, commentId: string): Promise<Comment> {
    const comment = await this.deps.repos.comments.findById(workspaceId, commentId);
    if (!comment) throw new NotFoundError('comment', commentId);
    return comment;
  }

  /** The post must exist in the workspace and have at least one publication; the platform filter may leave none. */
  private async requirePublications(
    workspaceId: string,
    postId: string,
    platform?: Platform,
  ): Promise<PostPublication[]> {
    const { repos } = this.deps;
    const post = await repos.posts.findById(workspaceId, postId);
    if (!post) throw new NotFoundError('post', postId);
    const all = await repos.publications.listByPost(workspaceId, postId);
    if (all.length === 0) {
      throw new DomainError('post_not_published', `Post ${postId} has no publications yet (status: ${post.status})`, {
        postId,
        status: post.status,
      });
    }
    return platform ? all.filter((p) => p.platform === platform) : all;
  }

  private async withCounts(comments: Comment[]): Promise<CommentWithCount[]> {
    const counts = await this.deps.repos.comments.countReplies(comments.map((c) => c.id));
    return comments.map((comment) => ({ comment, replyCount: counts.get(comment.id) ?? 0 }));
  }

  /**
   * Reads keep the mirror fresh, but never override the sync's own rules: a live lease means
   * someone is on it, a failed publication waits out its backoff, and the read cooldown grows
   * with the post's age so browsing old posts does not burn quota.
   */
  private revalidateIfStale(publication: PostPublication, state: CommentSyncState | null): void {
    const now = this.deps.clock.now();
    if (state) {
      const leaseLive =
        state.status === 'running' && state.lockExpiresAt !== null && state.lockExpiresAt.getTime() > now.getTime();
      if (leaseLive) return;
      const inBackoff =
        state.status === 'failed' && state.nextSyncAt !== null && state.nextSyncAt.getTime() > now.getTime();
      if (inBackoff) return;
      const lastSynced = state.lastSyncedAt?.getTime() ?? 0;
      const cooldown = readStaleAfterMs(publication.publishedAt, now, this.staleAfterMs, this.staleMaxMs);
      if (now.getTime() - lastSynced < cooldown) return;
    }
    this.deps.sync.triggerBackground(publication.id);
  }
}

export function fingerprintOf(commentId: string, text: string): string {
  return createHash('sha256').update(`${commentId}\n${text}`).digest('hex');
}

/** Re-raises the outcome recorded for a failed reply so a replay answers exactly like the original request. */
function storedFailure(existing: Comment): Error {
  return new PlatformError(
    existing.platform,
    platformKindFromCode(existing.error?.code ?? 'unknown'),
    existing.error?.message ?? 'Reply delivery failed',
    { retryable: false },
  );
}

import { randomUUID } from 'node:crypto';
import { UniqueViolationError } from '../domain/errors.js';
import type {
  Comment,
  CommentSyncState,
  Page,
  PageCursor,
  Post,
  PostPublication,
  SocialAccount,
  SocialAccountStatus,
  SortOrder,
} from '../domain/types.js';
import type {
  CommentRepository,
  ListChildrenInput,
  ListDescendantsInput,
  ListTopLevelInput,
  PlatformCommentRow,
  PostRepository,
  PublicationRepository,
  Repositories,
  SocialAccountRepository,
  SyncFailPatch,
  SyncFinishPatch,
  SyncLease,
  SyncStateRepository,
  UpsertContext,
} from './interfaces.js';

/**
 * In-memory implementation. Mirrors the Postgres semantics (unique constraints, keyset
 * pagination, multi-pass parent resolution, fenced lease) closely enough that the service
 * tests are meaningful without a database.
 */

export class InMemoryPostRepository implements PostRepository {
  private readonly rows = new Map<string, Post>();
  add(post: Post): Post {
    this.rows.set(post.id, post);
    return post;
  }
  async findById(workspaceId: string, postId: string): Promise<Post | null> {
    const post = this.rows.get(postId);
    return post && post.workspaceId === workspaceId ? post : null;
  }
}

export class InMemoryPublicationRepository implements PublicationRepository {
  private readonly rows = new Map<string, PostPublication>();
  add(publication: PostPublication): PostPublication {
    this.rows.set(publication.id, publication);
    return publication;
  }
  async findById(id: string): Promise<PostPublication | null> {
    return this.rows.get(id) ?? null;
  }
  async listByPost(workspaceId: string, postId: string): Promise<PostPublication[]> {
    return [...this.rows.values()].filter((p) => p.workspaceId === workspaceId && p.postId === postId);
  }
}

export class InMemorySocialAccountRepository implements SocialAccountRepository {
  private readonly rows = new Map<string, SocialAccount>();
  add(account: SocialAccount): SocialAccount {
    this.rows.set(account.id, account);
    return account;
  }
  async findById(id: string): Promise<SocialAccount | null> {
    const account = this.rows.get(id);
    return account ? { ...account } : null;
  }
  async setStatus(id: string, status: SocialAccountStatus): Promise<void> {
    const account = this.rows.get(id);
    if (account) this.rows.set(id, { ...account, status });
  }
}

type Keyed = { postedAt: Date; id: string };

function compareAsc(a: Keyed, b: Keyed): number {
  const diff = a.postedAt.getTime() - b.postedAt.getTime();
  if (diff !== 0) return diff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function paginate(items: Comment[], sort: SortOrder, cursor: PageCursor | null, limit: number): Page<Comment> {
  const cmp = sort === 'oldest' ? compareAsc : (a: Keyed, b: Keyed) => compareAsc(b, a);
  const sorted = [...items].sort(cmp);
  const after = cursor ? sorted.filter((c) => cmp(c, cursor) > 0) : sorted;
  const page = after.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(clone),
    nextCursor: after.length > limit && last ? { postedAt: last.postedAt, id: last.id } : null,
  };
}

function clone(c: Comment): Comment {
  return { ...c, author: { ...c.author }, metrics: { ...c.metrics }, error: c.error ? { ...c.error } : null };
}

export class InMemoryCommentRepository implements CommentRepository {
  private readonly rows = new Map<string, Comment>();

  async findById(workspaceId: string, id: string): Promise<Comment | null> {
    const c = this.rows.get(id);
    return c && c.workspaceId === workspaceId ? clone(c) : null;
  }

  async findByExternalId(publicationId: string, externalId: string): Promise<Comment | null> {
    const c = this.byExternal(publicationId, externalId);
    return c ? clone(c) : null;
  }

  async findByIdempotencyKey(workspaceId: string, key: string): Promise<Comment | null> {
    for (const c of this.rows.values()) {
      if (c.workspaceId === workspaceId && c.idempotencyKey === key) return clone(c);
    }
    return null;
  }

  async listTopLevel(input: ListTopLevelInput): Promise<Page<Comment>> {
    const ids = new Set(input.publicationIds);
    const items = [...this.rows.values()].filter(
      (c) => ids.has(c.publicationId) && c.parentId === null && c.status !== 'deleted',
    );
    return paginate(items, input.sort, input.cursor, input.limit);
  }

  async listChildren(input: ListChildrenInput): Promise<Page<Comment>> {
    const items = [...this.rows.values()].filter((c) => c.parentId === input.parentId && c.status !== 'deleted');
    return paginate(items, 'oldest', input.cursor, input.limit);
  }

  async listDescendants(input: ListDescendantsInput): Promise<Page<Comment>> {
    const prefix = `${input.threadPath}/`;
    const items = [...this.rows.values()].filter(
      (c) =>
        c.status !== 'deleted' &&
        (input.depth === 0 ? c.rootId === input.rootId && c.id !== input.rootId : c.threadPath.startsWith(prefix)),
    );
    return paginate(items, 'oldest', input.cursor, input.limit);
  }

  async countReplies(commentIds: string[]): Promise<Map<string, number>> {
    const wanted = new Set(commentIds);
    const counts = new Map<string, number>();
    for (const c of this.rows.values()) {
      if (c.parentId && wanted.has(c.parentId) && c.status === 'published') {
        counts.set(c.parentId, (counts.get(c.parentId) ?? 0) + 1);
      }
    }
    return counts;
  }

  async insert(comment: Comment): Promise<void> {
    if (this.rows.has(comment.id)) throw new UniqueViolationError('comments_pkey');
    this.assertUnique(comment);
    this.rows.set(comment.id, clone(comment));
  }

  async update(comment: Comment): Promise<void> {
    if (!this.rows.has(comment.id)) return;
    this.assertUnique(comment);
    this.rows.set(comment.id, clone(comment));
  }

  async replacePending(pendingId: string, adopted: Comment): Promise<void> {
    // Same order as the SQL transaction: free the idempotency key first, then take it over.
    this.rows.delete(pendingId);
    this.assertUnique(adopted);
    this.rows.set(adopted.id, clone(adopted));
  }

  async upsertFromPlatform(
    ctx: UpsertContext,
    rows: PlatformCommentRow[],
  ): Promise<{ created: number; updated: number }> {
    let created = 0;
    let updated = 0;
    for (const row of rows) {
      const existing = this.byExternal(ctx.publicationId, row.externalId);
      if (existing) {
        Object.assign(existing, {
          body: row.body,
          permalink: row.permalink,
          author: {
            externalId: row.authorExternalId,
            name: row.authorName,
            handle: row.authorHandle,
            avatarUrl: row.authorAvatarUrl,
          },
          isOwn: row.isOwn,
          metrics: { ...row.metrics },
          postedAt: row.postedAt,
          status: 'published',
          syncedAt: ctx.now,
          updatedAt: ctx.now,
        });
        updated++;
        continue;
      }
      const id = randomUUID();
      this.rows.set(id, {
        id,
        workspaceId: ctx.workspaceId,
        publicationId: ctx.publicationId,
        platform: ctx.platform,
        externalId: row.externalId,
        externalParentId: row.externalParentId,
        parentId: null,
        rootId: id,
        threadPath: id,
        depth: 0,
        author: {
          externalId: row.authorExternalId,
          name: row.authorName,
          handle: row.authorHandle,
          avatarUrl: row.authorAvatarUrl,
        },
        isOwn: row.isOwn,
        body: row.body,
        permalink: row.permalink,
        origin: 'platform',
        status: 'published',
        idempotencyKey: null,
        idempotencyFingerprint: null,
        error: null,
        metrics: { ...row.metrics },
        postedAt: row.postedAt,
        syncedAt: ctx.now,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      });
      created++;
    }
    return { created, updated };
  }

  async resolveParents(publicationId: string, now: Date): Promise<number> {
    let total = 0;
    for (let pass = 0; pass < 32; pass++) {
      let changed = 0;
      for (const c of this.rows.values()) {
        if (c.publicationId !== publicationId || c.parentId !== null || c.externalParentId === null) continue;
        const parent = this.byExternal(publicationId, c.externalParentId);
        if (!parent || parent.id === c.id) continue;
        const parentResolved = parent.externalParentId === null || parent.parentId !== null;
        if (!parentResolved) continue;
        c.parentId = parent.id;
        c.rootId = parent.rootId;
        c.threadPath = `${parent.threadPath}/${c.id}`;
        c.depth = parent.depth + 1;
        c.updatedAt = now;
        changed++;
      }
      total += changed;
      if (changed === 0) break;
    }
    return total;
  }

  async listStalePending(publicationId: string, before: Date): Promise<Comment[]> {
    return [...this.rows.values()]
      .filter(
        (c) =>
          c.publicationId === publicationId &&
          c.status === 'pending' &&
          c.origin === 'app' &&
          c.createdAt.getTime() < before.getTime(),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(clone);
  }

  async findOwnPlatformMatch(
    publicationId: string,
    body: string,
    parentExternalIds: string[],
    postedAfter: Date,
  ): Promise<Comment | null> {
    const parents = new Set(parentExternalIds);
    const match = [...this.rows.values()]
      .filter(
        (c) =>
          c.publicationId === publicationId &&
          c.isOwn &&
          c.origin === 'platform' &&
          c.body === body &&
          c.externalParentId !== null &&
          parents.has(c.externalParentId) &&
          c.postedAt.getTime() >= postedAfter.getTime(),
      )
      .sort(compareAsc)[0];
    return match ? clone(match) : null;
  }

  private byExternal(publicationId: string, externalId: string): Comment | undefined {
    for (const c of this.rows.values()) {
      if (c.publicationId === publicationId && c.externalId === externalId) return c;
    }
    return undefined;
  }

  private assertUnique(candidate: Comment): void {
    for (const c of this.rows.values()) {
      if (c.id === candidate.id) continue;
      if (
        candidate.externalId !== null &&
        c.publicationId === candidate.publicationId &&
        c.externalId === candidate.externalId
      ) {
        throw new UniqueViolationError('comments_publication_id_external_id_key');
      }
      if (
        candidate.idempotencyKey !== null &&
        c.workspaceId === candidate.workspaceId &&
        c.idempotencyKey === candidate.idempotencyKey
      ) {
        throw new UniqueViolationError('comments_workspace_id_idempotency_key_key');
      }
    }
  }
}

export class InMemorySyncStateRepository implements SyncStateRepository {
  private readonly rows = new Map<string, CommentSyncState>();

  async get(publicationId: string): Promise<CommentSyncState | null> {
    const s = this.rows.get(publicationId);
    return s ? { ...s } : null;
  }

  async listByPublications(publicationIds: string[]): Promise<CommentSyncState[]> {
    return publicationIds
      .map((id) => this.rows.get(id))
      .filter((s): s is CommentSyncState => !!s)
      .map((s) => ({ ...s }));
  }

  async ensure(publicationId: string, nextSyncAt: Date): Promise<void> {
    if (!this.rows.has(publicationId)) this.rows.set(publicationId, this.blank(publicationId, nextSyncAt));
  }

  async tryAcquire(publicationId: string, now: Date, leaseMs: number): Promise<SyncLease | null> {
    const existing = this.rows.get(publicationId) ?? this.blank(publicationId, now);
    if (this.leaseLive(existing, now)) return null;
    const lockToken = randomUUID();
    const next: CommentSyncState = {
      ...existing,
      status: 'running',
      lockToken,
      lockExpiresAt: new Date(now.getTime() + leaseMs),
    };
    this.rows.set(publicationId, next);
    return { state: { ...next }, lockToken };
  }

  async renew(publicationId: string, lockToken: string, now: Date, leaseMs: number): Promise<boolean> {
    const s = this.rows.get(publicationId);
    if (!s || s.status !== 'running' || s.lockToken !== lockToken) return false;
    s.lockExpiresAt = new Date(now.getTime() + leaseMs);
    return true;
  }

  async finish(publicationId: string, lockToken: string, patch: SyncFinishPatch): Promise<boolean> {
    const s = this.rows.get(publicationId);
    if (!s || s.lockToken !== lockToken) return false;
    this.rows.set(publicationId, {
      ...s,
      status: 'idle',
      cursor: patch.cursor,
      continuation: patch.continuation,
      lastSyncedAt: patch.lastSyncedAt,
      nextSyncAt: patch.nextSyncAt,
      lockToken: null,
      lockExpiresAt: null,
      consecutiveFailures: 0,
      lastError: null,
    });
    return true;
  }

  async fail(publicationId: string, lockToken: string, patch: SyncFailPatch): Promise<boolean> {
    const s = this.rows.get(publicationId);
    if (!s || s.lockToken !== lockToken) return false;
    this.rows.set(publicationId, {
      ...s,
      status: 'failed',
      nextSyncAt: patch.nextSyncAt,
      lockToken: null,
      lockExpiresAt: null,
      consecutiveFailures: s.consecutiveFailures + 1,
      lastError: patch.error,
    });
    return true;
  }

  async claimDue(now: Date, limit: number, leaseMs: number): Promise<SyncLease[]> {
    const due = [...this.rows.values()]
      .filter((s) => s.nextSyncAt !== null && s.nextSyncAt.getTime() <= now.getTime() && !this.leaseLive(s, now))
      .sort((a, b) => a.nextSyncAt!.getTime() - b.nextSyncAt!.getTime())
      .slice(0, limit);
    const leases: SyncLease[] = [];
    for (const s of due) {
      const lease = await this.tryAcquire(s.publicationId, now, leaseMs);
      if (lease) leases.push(lease);
    }
    return leases;
  }

  private leaseLive(s: CommentSyncState, now: Date): boolean {
    return s.status === 'running' && s.lockExpiresAt !== null && s.lockExpiresAt.getTime() >= now.getTime();
  }

  private blank(publicationId: string, nextSyncAt: Date | null): CommentSyncState {
    return {
      publicationId,
      status: 'idle',
      cursor: null,
      continuation: null,
      lastSyncedAt: null,
      nextSyncAt,
      lockToken: null,
      lockExpiresAt: null,
      consecutiveFailures: 0,
      lastError: null,
    };
  }
}

export interface InMemoryRepositories extends Repositories {
  posts: InMemoryPostRepository;
  publications: InMemoryPublicationRepository;
  accounts: InMemorySocialAccountRepository;
  comments: InMemoryCommentRepository;
  syncStates: InMemorySyncStateRepository;
}

export function createInMemoryRepositories(): InMemoryRepositories {
  return {
    posts: new InMemoryPostRepository(),
    publications: new InMemoryPublicationRepository(),
    accounts: new InMemorySocialAccountRepository(),
    comments: new InMemoryCommentRepository(),
    syncStates: new InMemorySyncStateRepository(),
  };
}

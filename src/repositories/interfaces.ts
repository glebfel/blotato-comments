import type {
  Comment,
  CommentSyncState,
  ExternalComment,
  Page,
  PageCursor,
  Platform,
  Post,
  PostPublication,
  SocialAccount,
  SocialAccountStatus,
  SortOrder,
  SyncContinuation,
} from '../domain/types.js';

/**
 * Persistence ports. Two implementations ship: in-memory (tests, demo mode) and Postgres.
 * Services depend only on these interfaces.
 *
 * Tenancy: every entry point a request can reach takes a workspaceId (`posts.findById`,
 * `comments.findById`, `publications.listByPost`). The id-only lookups below are used for
 * rows already obtained through a scoped lookup (a comment's publication, its account).
 */

export interface PostRepository {
  findById(workspaceId: string, postId: string): Promise<Post | null>;
}

export interface PublicationRepository {
  findById(id: string): Promise<PostPublication | null>;
  listByPost(workspaceId: string, postId: string): Promise<PostPublication[]>;
}

export interface SocialAccountRepository {
  findById(id: string): Promise<SocialAccount | null>;
  setStatus(id: string, status: SocialAccountStatus): Promise<void>;
}

export interface PlatformCommentRow extends ExternalComment {
  isOwn: boolean;
}

export interface UpsertContext {
  workspaceId: string;
  publicationId: string;
  platform: Platform;
  now: Date;
}

export interface ListTopLevelInput {
  publicationIds: string[];
  limit: number;
  cursor: PageCursor | null;
  sort: SortOrder;
}

export interface ListChildrenInput {
  parentId: string;
  limit: number;
  cursor: PageCursor | null;
}

export interface ListDescendantsInput {
  /** The comment whose subtree we want (excluded from the result). */
  rootId: string;
  threadPath: string;
  depth: number;
  limit: number;
  cursor: PageCursor | null;
}

export interface CommentRepository {
  findById(workspaceId: string, id: string): Promise<Comment | null>;
  findByExternalId(publicationId: string, externalId: string): Promise<Comment | null>;
  findByIdempotencyKey(workspaceId: string, key: string): Promise<Comment | null>;
  /** Top-level comments across the given publications, keyset-paginated on (postedAt, id). */
  listTopLevel(input: ListTopLevelInput): Promise<Page<Comment>>;
  /** Direct replies of a comment, oldest first. */
  listChildren(input: ListChildrenInput): Promise<Page<Comment>>;
  /** All descendants of a comment (any depth), oldest first. */
  listDescendants(input: ListDescendantsInput): Promise<Page<Comment>>;
  /** Number of published direct replies per comment id. Missing key = 0. */
  countReplies(commentIds: string[]): Promise<Map<string, number>>;
  /** @throws UniqueViolationError */
  insert(comment: Comment): Promise<void>;
  /** @throws UniqueViolationError */
  update(comment: Comment): Promise<void>;
  /**
   * Atomically drop a pending app-originated row and take over the row the sync created for the
   * same platform comment (transferring the idempotency key). Used when a sync races a reply.
   */
  replacePending(pendingId: string, adopted: Comment): Promise<void>;
  /**
   * Insert-or-update comments reported by the platform. Matching is on (publication, external id).
   * Thread structure of existing rows is left untouched; new rows start unresolved (see resolveParents).
   */
  upsertFromPlatform(ctx: UpsertContext, rows: PlatformCommentRow[]): Promise<{ created: number; updated: number }>;
  /**
   * Links unresolved rows (parent_id NULL, external_parent_id set) to their parents, computing
   * root_id, thread_path and depth. Runs in passes so grandchildren pick up final paths.
   * Returns rows linked.
   */
  resolveParents(publicationId: string, now: Date): Promise<number>;
  /** App-originated replies still `pending` that were created before `before` (delivery outcome unknown). */
  listStalePending(publicationId: string, before: Date): Promise<Comment[]>;
  /**
   * A platform-originated comment by the connected account with this exact body, under one of the
   * given parents, posted at or after `postedAfter`. Used to reconcile unknown-outcome replies.
   */
  findOwnPlatformMatch(
    publicationId: string,
    body: string,
    parentExternalIds: string[],
    postedAfter: Date,
  ): Promise<Comment | null>;
}

export interface SyncFinishPatch {
  cursor: string | null;
  continuation: SyncContinuation | null;
  lastSyncedAt: Date;
  nextSyncAt: Date;
}

export interface SyncFailPatch {
  error: string;
  nextSyncAt: Date;
  now: Date;
}

export interface SyncLease {
  /** Row as acquired: previous cursor / continuation / failures, status = running, our lock token. */
  state: CommentSyncState;
  lockToken: string;
}

export interface SyncStateRepository {
  get(publicationId: string): Promise<CommentSyncState | null>;
  listByPublications(publicationIds: string[]): Promise<CommentSyncState[]>;
  /** Creates the row if missing (scheduling the first sync) without touching an existing one. */
  ensure(publicationId: string, nextSyncAt: Date): Promise<void>;
  /**
   * Lease-based lock. Returns the lease when this caller now owns the sync, or null when another
   * worker holds an unexpired lease. Single statement, so two racing workers cannot both win.
   */
  tryAcquire(publicationId: string, now: Date, leaseMs: number): Promise<SyncLease | null>;
  /** Extends the lease. False when the lease was lost (expired and taken by someone else). */
  renew(publicationId: string, lockToken: string, now: Date, leaseMs: number): Promise<boolean>;
  /** Records a successful run. False when the lease was lost; the caller's state is then discarded. */
  finish(publicationId: string, lockToken: string, patch: SyncFinishPatch): Promise<boolean>;
  /** Records a failed run. False when the lease was lost. */
  fail(publicationId: string, lockToken: string, patch: SyncFailPatch): Promise<boolean>;
  /**
   * Claims up to `limit` due publications for this worker in one step (lease taken), so several
   * poller instances divide the queue instead of racing for the same rows.
   */
  claimDue(now: Date, limit: number, leaseMs: number): Promise<SyncLease[]>;
}

export interface Repositories {
  posts: PostRepository;
  publications: PublicationRepository;
  accounts: SocialAccountRepository;
  comments: CommentRepository;
  syncStates: SyncStateRepository;
}

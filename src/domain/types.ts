/**
 * Domain model for the comment system.
 *
 * Naming: a Post is what the user schedules; a PostPublication is that post as it
 * landed on one specific social account/platform. Comments hang off publications.
 */

export const PLATFORMS = [
  'twitter',
  'youtube',
  'instagram',
  'facebook',
  'linkedin',
  'tiktok',
  'threads',
  'pinterest',
  'bluesky',
] as const;

export type Platform = (typeof PLATFORMS)[number];

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

/**
 * Normalised failure classes for platform APIs. Adapters translate raw HTTP failures into
 * one of these so the rest of the system never needs platform-specific error handling.
 */
export const PLATFORM_ERROR_KINDS = [
  'auth', // token invalid/expired/insufficient scope -> account needs re-authorisation
  'rate_limited', // platform rate limit or quota exhausted
  'not_found', // external post/comment no longer exists
  'rejected', // platform validated and rejected the request (too long, comments disabled, ...)
  'unavailable', // 5xx / network failure; outcome unknown
  'unknown',
] as const;

export type PlatformErrorKind = (typeof PLATFORM_ERROR_KINDS)[number];

export function isPlatformErrorKind(value: string): value is PlatformErrorKind {
  return (PLATFORM_ERROR_KINDS as readonly string[]).includes(value);
}

export type CommentStatus = 'published' | 'pending' | 'failed' | 'deleted';
export type CommentOrigin = 'platform' | 'app';

/**
 * Public error vocabulary, shared by HTTP responses (`error.code`) and stored delivery
 * errors (`comment.error.code`), so a client needs exactly one dictionary.
 */
export type CommentErrorCode = `platform_${PlatformErrorKind}` | 'not_delivered' | 'internal';

export interface CommentAuthor {
  externalId: string | null;
  name: string | null;
  handle: string | null;
  avatarUrl: string | null;
}

export interface CommentError {
  code: CommentErrorCode;
  message: string;
  /** True when re-attempting delivery is safe (the platform definitely did not post it). */
  retryable: boolean;
}

export interface Comment {
  id: string;
  workspaceId: string;
  publicationId: string;
  platform: Platform;
  /** Platform-side id. Null while an app-originated reply is pending. */
  externalId: string | null;
  /** Platform-side parent id as reported by the platform. Null = top-level. */
  externalParentId: string | null;
  /** Local parent, resolved from externalParentId. Null = top-level or orphan. */
  parentId: string | null;
  /** Top-level comment of the thread (own id for a top-level comment). */
  rootId: string;
  /** Materialised path "rootId/.../thisId". */
  threadPath: string;
  depth: number;
  author: CommentAuthor;
  isOwn: boolean;
  body: string;
  /** Link to the comment on the platform, when the platform has stable URLs. */
  permalink: string | null;
  origin: CommentOrigin;
  status: CommentStatus;
  idempotencyKey: string | null;
  /** Hash of (target comment, text) so a reused key with a different payload is detected. */
  idempotencyFingerprint: string | null;
  error: CommentError | null;
  metrics: Record<string, number>;
  postedAt: Date;
  syncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A comment as a platform reports it, normalised but not yet linked to local rows.
 * Produced by platform adapters, consumed by the sync/upsert path.
 */
export interface ExternalComment {
  externalId: string;
  /** Platform-side parent comment id. Null when the comment is directly on the post. */
  externalParentId: string | null;
  authorExternalId: string | null;
  authorName: string | null;
  authorHandle: string | null;
  authorAvatarUrl: string | null;
  body: string;
  permalink: string | null;
  postedAt: Date;
  metrics: Record<string, number>;
}

export type PostStatus = 'draft' | 'scheduled' | 'publishing' | 'published' | 'failed';

export interface Post {
  id: string;
  workspaceId: string;
  status: PostStatus;
}

export type SocialAccountStatus = 'connected' | 'reauth_required' | 'disconnected';

export interface SocialAccount {
  id: string;
  workspaceId: string;
  platform: Platform;
  externalAccountId: string;
  displayName: string | null;
  handle: string | null;
  avatarUrl: string | null;
  status: SocialAccountStatus;
}

export interface PostPublication {
  id: string;
  postId: string;
  workspaceId: string;
  socialAccountId: string;
  platform: Platform;
  externalPostId: string;
  permalink: string | null;
  publishedAt: Date;
}

export type SyncStatus = 'idle' | 'running' | 'failed';

export interface SyncContinuation {
  pageToken: string;
  /** Cursor the walk was started with; the continuation must query with the same value. */
  sinceCursor: string | null;
  /** Cursor value to commit once the walk completes. */
  candidateCursor: string | null;
}

export interface CommentSyncState {
  publicationId: string;
  status: SyncStatus;
  /** Committed incremental cursor (provider-defined, opaque). */
  cursor: string | null;
  /** In-progress walk that hit the request budget; null when idle. */
  continuation: SyncContinuation | null;
  lastSyncedAt: Date | null;
  /** Last completed full walk (see CommentSyncService: incremental runs never refresh old comments). */
  lastFullSyncAt: Date | null;
  nextSyncAt: Date | null;
  /** Fencing token of the worker that currently holds the lease. */
  lockToken: string | null;
  lockExpiresAt: Date | null;
  consecutiveFailures: number;
  lastError: string | null;
}

/** Keyset pagination cursor over (postedAt, id). Encoded opaquely at the HTTP layer. */
export interface PageCursor {
  postedAt: Date;
  id: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: PageCursor | null;
}

export type SortOrder = 'newest' | 'oldest';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

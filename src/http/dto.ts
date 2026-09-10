import type { Comment } from '../domain/types.js';
import type { PublicationSyncView } from '../services/comment-service.js';
import type { SyncResult } from '../services/sync-service.js';

export function toCommentDto(comment: Comment, replyCount: number) {
  return {
    id: comment.id,
    publicationId: comment.publicationId,
    platform: comment.platform,
    externalId: comment.externalId,
    parentId: comment.parentId,
    depth: comment.depth,
    author: comment.author,
    isOwn: comment.isOwn,
    text: comment.body,
    permalink: comment.permalink,
    status: comment.status,
    origin: comment.origin,
    replyCount,
    metrics: comment.metrics,
    error: comment.error,
    postedAt: comment.postedAt.toISOString(),
    syncedAt: comment.syncedAt?.toISOString() ?? null,
    createdAt: comment.createdAt.toISOString(),
  };
}

export function toPublicationDto({ publication, sync }: PublicationSyncView) {
  return {
    id: publication.id,
    postId: publication.postId,
    platform: publication.platform,
    socialAccountId: publication.socialAccountId,
    externalPostId: publication.externalPostId,
    permalink: publication.permalink,
    publishedAt: publication.publishedAt.toISOString(),
    sync: sync
      ? {
          status: sync.status,
          lastSyncedAt: sync.lastSyncedAt?.toISOString() ?? null,
          nextSyncAt: sync.nextSyncAt?.toISOString() ?? null,
          lastError: sync.lastError,
        }
      : null,
  };
}

export function toSyncResultDto(result: SyncResult) {
  return {
    publicationId: result.publicationId,
    status: result.status,
    reason: result.reason ?? null,
    error: result.error ?? null,
    fetched: result.fetched,
    created: result.created,
    updated: result.updated,
    linked: result.linked,
    reconciled: result.reconciled,
    complete: result.complete,
  };
}

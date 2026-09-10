import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PLATFORMS } from '../domain/types.js';
import type { CommentService } from '../services/comment-service.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { toCommentDto, toPublicationDto, toSyncResultDto } from './dto.js';

const PostParams = z.object({ postId: z.string().uuid() });
const CommentParams = z.object({ commentId: z.string().uuid() });

const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

const ListQuery = PageQuery.extend({
  platform: z.enum(PLATFORMS).optional(),
  sort: z.enum(['newest', 'oldest']).default('newest'),
});

const SyncQuery = z.object({
  platform: z.enum(PLATFORMS).optional(),
  mode: z.enum(['incremental', 'full']).optional(),
});

// Shape only; emptiness and platform limits are semantic checks that answer 422 from the service.
const ReplyBody = z.object({
  text: z.string().max(10_000),
});

// Required: without it a double-click is two replies on the platform.
const ReplyHeaders = z.object({
  'idempotency-key': z.string().min(1).max(255),
});

export interface RouteRateLimits {
  /** Requests per minute per workspace for the expensive endpoints. */
  syncPerMinute: number;
  replyPerMinute: number;
}

export function registerCommentRoutes(app: FastifyInstance, comments: CommentService, limits: RouteRateLimits): void {
  // Comments on a published post, across all platforms it was published to.
  app.get('/posts/:postId/comments', async (request) => {
    const { postId } = PostParams.parse(request.params);
    const query = ListQuery.parse(request.query);
    const result = await comments.listForPost(request.workspaceId, postId, {
      platform: query.platform,
      limit: query.limit,
      cursor: decodeCursor(query.cursor),
      sort: query.sort,
    });
    return {
      data: result.items.map(({ comment, replyCount }) => toCommentDto(comment, replyCount)),
      meta: {
        nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null,
        publications: result.publications.map(toPublicationDto),
      },
    };
  });

  // Pull fresh comments from the platform(s) now. An action endpoint rather than a resource:
  // there is no job to inspect later, the result is the run itself. Runs inline here; in
  // production this would enqueue and return 202 (see docs/DESIGN.md). Rate-limited because
  // every call spends platform quota.
  app.post(
    '/posts/:postId/comments/sync',
    { config: { rateLimit: { max: limits.syncPerMinute, timeWindow: '1 minute' } } },
    async (request) => {
      const { postId } = PostParams.parse(request.params);
      const query = SyncQuery.parse(request.query);
      const { results } = await comments.syncPost(request.workspaceId, postId, query);
      return { data: results.map(toSyncResultDto) };
    },
  );

  app.get('/comments/:commentId', async (request) => {
    const { commentId } = CommentParams.parse(request.params);
    const { comment, replyCount } = await comments.getById(request.workspaceId, commentId);
    return { data: toCommentDto(comment, replyCount) };
  });

  // Direct replies, oldest first. `replyCount` on a comment counts exactly this set.
  app.get('/comments/:commentId/replies', async (request) => {
    const { commentId } = CommentParams.parse(request.params);
    const query = PageQuery.parse(request.query);
    const result = await comments.listReplies(request.workspaceId, commentId, {
      limit: query.limit,
      cursor: decodeCursor(query.cursor),
    });
    return {
      data: result.items.map(({ comment, replyCount }) => toCommentDto(comment, replyCount)),
      meta: { nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null },
    };
  });

  // Whole subtree under a comment, flat, oldest first; clients rebuild the tree via parentId.
  app.get('/comments/:commentId/thread', async (request) => {
    const { commentId } = CommentParams.parse(request.params);
    const query = PageQuery.parse(request.query);
    const result = await comments.listThread(request.workspaceId, commentId, {
      limit: query.limit,
      cursor: decodeCursor(query.cursor),
    });
    return {
      data: result.items.map(({ comment, replyCount }) => toCommentDto(comment, replyCount)),
      meta: { nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null },
    };
  });

  app.post(
    '/comments/:commentId/replies',
    { config: { rateLimit: { max: limits.replyPerMinute, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { commentId } = CommentParams.parse(request.params);
      const body = ReplyBody.parse(request.body);
      const headers = ReplyHeaders.parse(request.headers);
      const result = await comments.reply(request.workspaceId, commentId, {
        text: body.text,
        idempotencyKey: headers['idempotency-key'],
      });
      if (result.created) void reply.code(201).header('location', `/v1/comments/${result.comment.id}`);
      return { data: toCommentDto(result.comment, result.replyCount) };
    },
  );
}

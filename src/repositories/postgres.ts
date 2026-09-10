import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { UniqueViolationError } from '../domain/errors.js';
import {
  isPlatform,
  type Comment,
  type CommentSyncState,
  type Page,
  type Platform,
  type Post,
  type PostPublication,
  type SocialAccount,
  type SocialAccountStatus,
  type SyncContinuation,
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
 * Postgres implementation on top of `pg`, hand-written SQL. Schema: db/schema.sql.
 * Kept free of an ORM on purpose: the interesting queries (multi-row upsert, keyset
 * pagination, set-based parent resolution, fenced lease, SKIP LOCKED claim) are clearer as SQL.
 */

type Queryable = Pick<Pool, 'query'> | PoolClient;

const COMMENT_COLUMNS = `
  id, workspace_id, publication_id, platform, external_id, external_parent_id, parent_id, root_id,
  thread_path, depth, author_external_id, author_name, author_handle, author_avatar_url,
  is_own, body, permalink, origin, status, idempotency_key, idempotency_fingerprint, error, metrics,
  posted_at, synced_at, created_at, updated_at`;

interface CommentRow {
  id: string;
  workspace_id: string;
  publication_id: string;
  platform: string;
  external_id: string | null;
  external_parent_id: string | null;
  parent_id: string | null;
  root_id: string;
  thread_path: string;
  depth: number;
  author_external_id: string | null;
  author_name: string | null;
  author_handle: string | null;
  author_avatar_url: string | null;
  is_own: boolean;
  body: string;
  permalink: string | null;
  origin: string;
  status: string;
  idempotency_key: string | null;
  idempotency_fingerprint: string | null;
  error: Comment['error'];
  metrics: Record<string, number>;
  posted_at: Date;
  synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Text columns are validated on the way out; a corrupt value is a loud error, not a silent cast. */
function asPlatform(value: string): Platform {
  if (!isPlatform(value)) throw new Error(`corrupt platform value in database: ${value}`);
  return value;
}

function asOneOf<T extends string>(value: string, allowed: readonly T[], column: string): T {
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`corrupt ${column} value in database: ${value}`);
  return value as T;
}

const COMMENT_STATUSES = ['published', 'pending', 'failed', 'deleted'] as const;
const COMMENT_ORIGINS = ['platform', 'app'] as const;
const POST_STATUSES = ['draft', 'scheduled', 'publishing', 'published', 'failed'] as const;
const ACCOUNT_STATUSES = ['connected', 'reauth_required', 'disconnected'] as const;
const SYNC_STATUSES = ['idle', 'running', 'failed'] as const;

function toComment(r: CommentRow): Comment {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    publicationId: r.publication_id,
    platform: asPlatform(r.platform),
    externalId: r.external_id,
    externalParentId: r.external_parent_id,
    parentId: r.parent_id,
    rootId: r.root_id,
    threadPath: r.thread_path,
    depth: r.depth,
    author: {
      externalId: r.author_external_id,
      name: r.author_name,
      handle: r.author_handle,
      avatarUrl: r.author_avatar_url,
    },
    isOwn: r.is_own,
    body: r.body,
    permalink: r.permalink,
    origin: asOneOf(r.origin, COMMENT_ORIGINS, 'origin'),
    status: asOneOf(r.status, COMMENT_STATUSES, 'status'),
    idempotencyKey: r.idempotency_key,
    idempotencyFingerprint: r.idempotency_fingerprint,
    error: r.error,
    metrics: r.metrics ?? {},
    postedAt: r.posted_at,
    syncedAt: r.synced_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function translateError(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (e && e.code === '23505') throw new UniqueViolationError(e.constraint ?? 'unknown');
  throw err;
}

async function inTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export class PgPostRepository implements PostRepository {
  constructor(private readonly db: Queryable) {}
  async findById(workspaceId: string, postId: string): Promise<Post | null> {
    const { rows } = await this.db.query<{ id: string; workspace_id: string; status: string }>(
      'SELECT id, workspace_id, status FROM posts WHERE id = $1 AND workspace_id = $2',
      [postId, workspaceId],
    );
    const r = rows[0];
    return r
      ? { id: r.id, workspaceId: r.workspace_id, status: asOneOf(r.status, POST_STATUSES, 'posts.status') }
      : null;
  }
}

const PUBLICATION_COLUMNS =
  'id, post_id, social_account_id, workspace_id, platform, external_post_id, permalink, published_at';

interface PublicationRow {
  id: string;
  post_id: string;
  workspace_id: string;
  social_account_id: string;
  platform: string;
  external_post_id: string;
  permalink: string | null;
  published_at: Date;
}

function toPublication(r: PublicationRow): PostPublication {
  return {
    id: r.id,
    postId: r.post_id,
    workspaceId: r.workspace_id,
    socialAccountId: r.social_account_id,
    platform: asPlatform(r.platform),
    externalPostId: r.external_post_id,
    permalink: r.permalink,
    publishedAt: r.published_at,
  };
}

export class PgPublicationRepository implements PublicationRepository {
  constructor(private readonly db: Queryable) {}
  async findById(id: string): Promise<PostPublication | null> {
    const { rows } = await this.db.query<PublicationRow>(
      `SELECT ${PUBLICATION_COLUMNS} FROM post_publications WHERE id = $1`,
      [id],
    );
    return rows[0] ? toPublication(rows[0]) : null;
  }
  async listByPost(workspaceId: string, postId: string): Promise<PostPublication[]> {
    const { rows } = await this.db.query<PublicationRow>(
      `SELECT ${PUBLICATION_COLUMNS} FROM post_publications WHERE workspace_id = $1 AND post_id = $2 ORDER BY published_at`,
      [workspaceId, postId],
    );
    return rows.map(toPublication);
  }
}

interface AccountRow {
  id: string;
  workspace_id: string;
  platform: string;
  external_account_id: string;
  display_name: string | null;
  handle: string | null;
  avatar_url: string | null;
  status: string;
}

export class PgSocialAccountRepository implements SocialAccountRepository {
  constructor(private readonly db: Queryable) {}
  async findById(id: string): Promise<SocialAccount | null> {
    const { rows } = await this.db.query<AccountRow>(
      `SELECT id, workspace_id, platform, external_account_id, display_name, handle, avatar_url, status
       FROM social_accounts WHERE id = $1`,
      [id],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      platform: asPlatform(r.platform),
      externalAccountId: r.external_account_id,
      displayName: r.display_name,
      handle: r.handle,
      avatarUrl: r.avatar_url,
      status: asOneOf(r.status, ACCOUNT_STATUSES, 'social_accounts.status'),
    };
  }
  async setStatus(id: string, status: SocialAccountStatus): Promise<void> {
    await this.db.query('UPDATE social_accounts SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
  }
}

export class PgCommentRepository implements CommentRepository {
  constructor(private readonly db: Pool) {}

  async findById(workspaceId: string, id: string): Promise<Comment | null> {
    const { rows } = await this.db.query<CommentRow>(
      `SELECT ${COMMENT_COLUMNS} FROM comments WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId],
    );
    return rows[0] ? toComment(rows[0]) : null;
  }

  async findByExternalId(publicationId: string, externalId: string): Promise<Comment | null> {
    const { rows } = await this.db.query<CommentRow>(
      `SELECT ${COMMENT_COLUMNS} FROM comments WHERE publication_id = $1 AND external_id = $2`,
      [publicationId, externalId],
    );
    return rows[0] ? toComment(rows[0]) : null;
  }

  async findByIdempotencyKey(workspaceId: string, key: string): Promise<Comment | null> {
    const { rows } = await this.db.query<CommentRow>(
      `SELECT ${COMMENT_COLUMNS} FROM comments WHERE workspace_id = $1 AND idempotency_key = $2`,
      [workspaceId, key],
    );
    return rows[0] ? toComment(rows[0]) : null;
  }

  async listTopLevel(input: ListTopLevelInput): Promise<Page<Comment>> {
    const desc = input.sort === 'newest';
    const params: unknown[] = [input.publicationIds, input.limit + 1];
    let cursorClause = '';
    if (input.cursor) {
      params.push(input.cursor.postedAt, input.cursor.id);
      cursorClause = `AND (posted_at, id) ${desc ? '<' : '>'} ($3, $4::uuid)`;
    }
    const { rows } = await this.db.query<CommentRow>(
      `SELECT ${COMMENT_COLUMNS} FROM comments
       WHERE publication_id = ANY($1::uuid[]) AND parent_id IS NULL AND status <> 'deleted' ${cursorClause}
       ORDER BY posted_at ${desc ? 'DESC' : 'ASC'}, id ${desc ? 'DESC' : 'ASC'}
       LIMIT $2`,
      params,
    );
    return toPage(rows, input.limit);
  }

  async listChildren(input: ListChildrenInput): Promise<Page<Comment>> {
    const params: unknown[] = [input.parentId, input.limit + 1];
    let cursorClause = '';
    if (input.cursor) {
      params.push(input.cursor.postedAt, input.cursor.id);
      cursorClause = `AND (posted_at, id) > ($3, $4::uuid)`;
    }
    const { rows } = await this.db.query<CommentRow>(
      `SELECT ${COMMENT_COLUMNS} FROM comments
       WHERE parent_id = $1 AND status <> 'deleted' ${cursorClause}
       ORDER BY posted_at ASC, id ASC
       LIMIT $2`,
      params,
    );
    return toPage(rows, input.limit);
  }

  async listDescendants(input: ListDescendantsInput): Promise<Page<Comment>> {
    // A whole thread uses the (root_id, posted_at, id) index; a nested subtree (rare, small)
    // falls back to the path prefix.
    const scope = input.depth === 0 ? `root_id = $1::uuid AND id <> $1::uuid` : `thread_path LIKE $1`;
    const params: unknown[] = [input.depth === 0 ? input.rootId : `${escapeLike(input.threadPath)}/%`, input.limit + 1];
    let cursorClause = '';
    if (input.cursor) {
      params.push(input.cursor.postedAt, input.cursor.id);
      cursorClause = `AND (posted_at, id) > ($3, $4::uuid)`;
    }
    const { rows } = await this.db.query<CommentRow>(
      `SELECT ${COMMENT_COLUMNS} FROM comments
       WHERE ${scope} AND status <> 'deleted' ${cursorClause}
       ORDER BY posted_at ASC, id ASC
       LIMIT $2`,
      params,
    );
    return toPage(rows, input.limit);
  }

  async countReplies(commentIds: string[]): Promise<Map<string, number>> {
    if (commentIds.length === 0) return new Map();
    const { rows } = await this.db.query<{ parent_id: string; n: string }>(
      `SELECT parent_id, count(*)::text AS n FROM comments
       WHERE parent_id = ANY($1::uuid[]) AND status = 'published' GROUP BY parent_id`,
      [commentIds],
    );
    return new Map(rows.map((r) => [r.parent_id, Number(r.n)]));
  }

  async insert(c: Comment): Promise<void> {
    await this.db
      .query(
        `INSERT INTO comments (${COMMENT_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
        insertParams(c),
      )
      .catch(translateError);
  }

  async update(c: Comment): Promise<void> {
    await updateComment(this.db, c);
  }

  async replacePending(pendingId: string, adopted: Comment): Promise<void> {
    await inTransaction(this.db, async (client) => {
      // Delete first so the unique (workspace_id, idempotency_key) index lets the adopted row take the key.
      await client.query('DELETE FROM comments WHERE id = $1', [pendingId]);
      await updateComment(client, adopted);
    });
  }

  async upsertFromPlatform(
    ctx: UpsertContext,
    rows: PlatformCommentRow[],
  ): Promise<{ created: number; updated: number }> {
    if (rows.length === 0) return { created: 0, updated: 0 };
    // One statement per page: columns are passed as parallel arrays and unnested server-side.
    // `xmax = 0` is true only for freshly inserted rows, so the same statement reports insert vs update.
    const { rows: result } = await this.db.query<{ inserted: boolean }>(
      `INSERT INTO comments (
         id, workspace_id, publication_id, platform, external_id, external_parent_id, parent_id, root_id,
         thread_path, depth, author_external_id, author_name, author_handle, author_avatar_url,
         is_own, body, permalink, origin, status, metrics, posted_at, synced_at, created_at, updated_at)
       SELECT r.id, $1, $2, $3, r.external_id, r.external_parent_id, NULL, r.id,
              r.id::text, 0, r.author_external_id, r.author_name, r.author_handle, r.author_avatar_url,
              r.is_own, r.body, r.permalink, 'platform', 'published', r.metrics, r.posted_at, $4, $4, $4
       FROM unnest(
         $5::uuid[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[],
         $12::boolean[], $13::text[], $14::text[], $15::jsonb[], $16::timestamptz[]
       ) AS r(id, external_id, external_parent_id, author_external_id, author_name, author_handle,
              author_avatar_url, is_own, body, permalink, metrics, posted_at)
       ON CONFLICT (publication_id, external_id) DO UPDATE SET
         body = EXCLUDED.body,
         permalink = EXCLUDED.permalink,
         author_external_id = EXCLUDED.author_external_id,
         author_name = EXCLUDED.author_name,
         author_handle = EXCLUDED.author_handle,
         author_avatar_url = EXCLUDED.author_avatar_url,
         is_own = EXCLUDED.is_own,
         metrics = EXCLUDED.metrics,
         posted_at = EXCLUDED.posted_at,
         status = 'published',
         synced_at = EXCLUDED.synced_at,
         updated_at = EXCLUDED.updated_at
       RETURNING (xmax = 0) AS inserted`,
      [
        ctx.workspaceId,
        ctx.publicationId,
        ctx.platform,
        ctx.now,
        rows.map(() => randomUUID()),
        rows.map((r) => r.externalId),
        rows.map((r) => r.externalParentId),
        rows.map((r) => r.authorExternalId),
        rows.map((r) => r.authorName),
        rows.map((r) => r.authorHandle),
        rows.map((r) => r.authorAvatarUrl),
        rows.map((r) => r.isOwn),
        rows.map((r) => r.body),
        rows.map((r) => r.permalink),
        rows.map((r) => JSON.stringify(r.metrics)),
        rows.map((r) => r.postedAt),
      ],
    );
    const created = result.filter((r) => r.inserted).length;
    return { created, updated: result.length - created };
  }

  async resolveParents(publicationId: string, now: Date): Promise<number> {
    let total = 0;
    // Each pass links rows whose parent is already resolved (or is top-level), so a chain of
    // depth N settles in N passes and grandchildren inherit final paths.
    for (let pass = 0; pass < 32; pass++) {
      const { rowCount } = await this.db.query(
        `UPDATE comments c
         SET parent_id = p.id,
             root_id = p.root_id,
             thread_path = p.thread_path || '/' || c.id::text,
             depth = p.depth + 1,
             updated_at = $2
         FROM comments p
         WHERE c.publication_id = $1
           AND c.parent_id IS NULL
           AND c.external_parent_id IS NOT NULL
           AND p.publication_id = c.publication_id
           AND p.external_id = c.external_parent_id
           AND p.id <> c.id
           AND (p.external_parent_id IS NULL OR p.parent_id IS NOT NULL)`,
        [publicationId, now],
      );
      total += rowCount ?? 0;
      if (!rowCount) break;
    }
    return total;
  }

  async listStalePending(publicationId: string, before: Date): Promise<Comment[]> {
    const { rows } = await this.db.query<CommentRow>(
      `SELECT ${COMMENT_COLUMNS} FROM comments
       WHERE publication_id = $1 AND status = 'pending' AND origin = 'app' AND created_at < $2
       ORDER BY created_at`,
      [publicationId, before],
    );
    return rows.map(toComment);
  }

  async findOwnPlatformMatch(
    publicationId: string,
    body: string,
    parentExternalIds: string[],
    postedAfter: Date,
  ): Promise<Comment | null> {
    const { rows } = await this.db.query<CommentRow>(
      `SELECT ${COMMENT_COLUMNS} FROM comments
       WHERE publication_id = $1 AND is_own AND origin = 'platform' AND body = $2
         AND external_parent_id = ANY($3::text[]) AND posted_at >= $4
       ORDER BY posted_at, id
       LIMIT 1`,
      [publicationId, body, parentExternalIds, postedAfter],
    );
    return rows[0] ? toComment(rows[0]) : null;
  }
}

async function updateComment(db: Queryable, c: Comment): Promise<void> {
  await db
    .query(
      `UPDATE comments SET
         external_id = $3, external_parent_id = $4, parent_id = $5, root_id = $6, thread_path = $7, depth = $8,
         author_external_id = $9, author_name = $10, author_handle = $11, author_avatar_url = $12,
         is_own = $13, body = $14, permalink = $15, origin = $16, status = $17, idempotency_key = $18,
         idempotency_fingerprint = $19, error = $20, metrics = $21, posted_at = $22, synced_at = $23,
         updated_at = $24
       WHERE id = $1 AND workspace_id = $2`,
      [
        c.id,
        c.workspaceId,
        c.externalId,
        c.externalParentId,
        c.parentId,
        c.rootId,
        c.threadPath,
        c.depth,
        c.author.externalId,
        c.author.name,
        c.author.handle,
        c.author.avatarUrl,
        c.isOwn,
        c.body,
        c.permalink,
        c.origin,
        c.status,
        c.idempotencyKey,
        c.idempotencyFingerprint,
        c.error ? JSON.stringify(c.error) : null,
        JSON.stringify(c.metrics),
        c.postedAt,
        c.syncedAt,
        c.updatedAt,
      ],
    )
    .catch(translateError);
}

function insertParams(c: Comment): unknown[] {
  return [
    c.id,
    c.workspaceId,
    c.publicationId,
    c.platform,
    c.externalId,
    c.externalParentId,
    c.parentId,
    c.rootId,
    c.threadPath,
    c.depth,
    c.author.externalId,
    c.author.name,
    c.author.handle,
    c.author.avatarUrl,
    c.isOwn,
    c.body,
    c.permalink,
    c.origin,
    c.status,
    c.idempotencyKey,
    c.idempotencyFingerprint,
    c.error ? JSON.stringify(c.error) : null,
    JSON.stringify(c.metrics),
    c.postedAt,
    c.syncedAt,
    c.createdAt,
    c.updatedAt,
  ];
}

function toPage(rows: CommentRow[], limit: number): Page<Comment> {
  const items = rows.slice(0, limit).map(toComment);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? { postedAt: last.postedAt, id: last.id } : null };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

const SYNC_STATE_COLUMNS =
  'publication_id, status, cursor, continuation, last_synced_at, next_sync_at, lock_token, lock_expires_at, consecutive_failures, last_error';

interface SyncStateRow {
  publication_id: string;
  status: string;
  cursor: string | null;
  continuation: SyncContinuation | null;
  last_synced_at: Date | null;
  next_sync_at: Date | null;
  lock_token: string | null;
  lock_expires_at: Date | null;
  consecutive_failures: number;
  last_error: string | null;
}

function toSyncState(r: SyncStateRow): CommentSyncState {
  return {
    publicationId: r.publication_id,
    status: asOneOf(r.status, SYNC_STATUSES, 'comment_sync_states.status'),
    cursor: r.cursor,
    continuation: r.continuation,
    lastSyncedAt: r.last_synced_at,
    nextSyncAt: r.next_sync_at,
    lockToken: r.lock_token,
    lockExpiresAt: r.lock_expires_at,
    consecutiveFailures: r.consecutive_failures,
    lastError: r.last_error,
  };
}

export class PgSyncStateRepository implements SyncStateRepository {
  constructor(private readonly db: Queryable) {}

  async get(publicationId: string): Promise<CommentSyncState | null> {
    const { rows } = await this.db.query<SyncStateRow>(
      `SELECT ${SYNC_STATE_COLUMNS} FROM comment_sync_states WHERE publication_id = $1`,
      [publicationId],
    );
    return rows[0] ? toSyncState(rows[0]) : null;
  }

  async listByPublications(publicationIds: string[]): Promise<CommentSyncState[]> {
    if (publicationIds.length === 0) return [];
    const { rows } = await this.db.query<SyncStateRow>(
      `SELECT ${SYNC_STATE_COLUMNS} FROM comment_sync_states WHERE publication_id = ANY($1::uuid[])`,
      [publicationIds],
    );
    return rows.map(toSyncState);
  }

  async ensure(publicationId: string, nextSyncAt: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO comment_sync_states (publication_id, next_sync_at) VALUES ($1, $2)
       ON CONFLICT (publication_id) DO NOTHING`,
      [publicationId, nextSyncAt],
    );
  }

  async tryAcquire(publicationId: string, now: Date, leaseMs: number): Promise<SyncLease | null> {
    const lockToken = randomUUID();
    // Single statement, so two workers racing for the same publication cannot both win.
    // A fresh row gets next_sync_at = now so a crash before finish/fail leaves it visible to the poller.
    const { rows } = await this.db.query<SyncStateRow>(
      `INSERT INTO comment_sync_states (publication_id, status, lock_token, lock_expires_at, next_sync_at, updated_at)
       VALUES ($1, 'running', $2, $3, $4, $4)
       ON CONFLICT (publication_id) DO UPDATE
         SET status = 'running', lock_token = EXCLUDED.lock_token,
             lock_expires_at = EXCLUDED.lock_expires_at, updated_at = EXCLUDED.updated_at
         WHERE comment_sync_states.status <> 'running'
            OR comment_sync_states.lock_expires_at IS NULL
            OR comment_sync_states.lock_expires_at < $4
       RETURNING ${SYNC_STATE_COLUMNS}`,
      [publicationId, lockToken, new Date(now.getTime() + leaseMs), now],
    );
    return rows[0] ? { state: toSyncState(rows[0]), lockToken } : null;
  }

  async renew(publicationId: string, lockToken: string, now: Date, leaseMs: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE comment_sync_states SET lock_expires_at = $3, updated_at = $4
       WHERE publication_id = $1 AND lock_token = $2 AND status = 'running'`,
      [publicationId, lockToken, new Date(now.getTime() + leaseMs), now],
    );
    return (rowCount ?? 0) > 0;
  }

  async finish(publicationId: string, lockToken: string, patch: SyncFinishPatch): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE comment_sync_states
       SET status = 'idle', cursor = $3, continuation = $4, last_synced_at = $5, next_sync_at = $6,
           lock_token = NULL, lock_expires_at = NULL, consecutive_failures = 0, last_error = NULL, updated_at = $5
       WHERE publication_id = $1 AND lock_token = $2`,
      [
        publicationId,
        lockToken,
        patch.cursor,
        patch.continuation ? JSON.stringify(patch.continuation) : null,
        patch.lastSyncedAt,
        patch.nextSyncAt,
      ],
    );
    return (rowCount ?? 0) > 0;
  }

  async fail(publicationId: string, lockToken: string, patch: SyncFailPatch): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE comment_sync_states
       SET status = 'failed', last_error = $3, next_sync_at = $4, lock_token = NULL, lock_expires_at = NULL,
           consecutive_failures = consecutive_failures + 1, updated_at = $5
       WHERE publication_id = $1 AND lock_token = $2`,
      [publicationId, lockToken, patch.error, patch.nextSyncAt, patch.now],
    );
    return (rowCount ?? 0) > 0;
  }

  async claimDue(now: Date, limit: number, leaseMs: number): Promise<SyncLease[]> {
    // SKIP LOCKED lets N poller instances each grab a disjoint slice of the queue; the lease is
    // taken in the same statement, so a claimed row is already fenced against everyone else.
    // Each claimed row gets its own token (uuid per row), returned alongside the state.
    const { rows } = await this.db.query<SyncStateRow>(
      `UPDATE comment_sync_states s
       SET status = 'running', lock_token = gen_random_uuid(), lock_expires_at = $2, updated_at = $1
       FROM (
         SELECT publication_id FROM comment_sync_states
         WHERE next_sync_at <= $1 AND (status <> 'running' OR lock_expires_at IS NULL OR lock_expires_at < $1)
         ORDER BY next_sync_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       ) due
       WHERE s.publication_id = due.publication_id
       RETURNING ${SYNC_STATE_COLUMNS.split(', ')
         .map((c) => `s.${c}`)
         .join(', ')}`,
      [now, new Date(now.getTime() + leaseMs), limit],
    );
    return rows.map((r) => ({ state: toSyncState(r), lockToken: r.lock_token! }));
  }
}

export function createPgRepositories(pool: Pool): Repositories {
  return {
    posts: new PgPostRepository(pool),
    publications: new PgPublicationRepository(pool),
    accounts: new PgSocialAccountRepository(pool),
    comments: new PgCommentRepository(pool),
    syncStates: new PgSyncStateRepository(pool),
  };
}

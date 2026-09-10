-- =============================================================================
-- Comment system schema (PostgreSQL 14+)
--
-- Tables marked [existing] are assumed to already exist in the scheduling API.
-- They are shown here in reduced form so the new tables can reference them and
-- the file can be applied to an empty database for local development / tests.
--
-- Design notes live in docs/DESIGN.md. Short version:
--   * A Post is the logical entity the user schedules. When it is published it
--     fans out into one PostPublication per connected social account. Comments
--     belong to a publication, because that is the thing that has an external
--     id on a specific platform.
--   * The comments table is a local mirror of platform state, refreshed by the
--     sync process. Replies created through our API are written through to
--     the platform and stored here with origin = 'app'.
--   * Platform is stored as text (not an enum) on purpose: adding a platform
--     must not require a migration.
-- =============================================================================

-- ---------------------------------------------------------------- [existing]
CREATE TABLE IF NOT EXISTS workspaces (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- [existing]
-- A connected social account (X profile, YouTube channel, IG business account, ...).
CREATE TABLE IF NOT EXISTS social_accounts (
  id                    uuid PRIMARY KEY,
  workspace_id          uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  platform              text NOT NULL,
  external_account_id   text NOT NULL,            -- platform-side user / channel / page id
  display_name          text,
  handle                text,
  avatar_url            text,
  -- OAuth tokens are stored encrypted (envelope encryption with a KMS-managed key).
  -- The comment system never reads this column directly; it goes through CredentialsProvider.
  credentials_encrypted bytea,
  status                text NOT NULL DEFAULT 'connected'
                        CHECK (status IN ('connected', 'reauth_required', 'disconnected')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, platform, external_account_id)
);

-- ---------------------------------------------------------------- [existing]
CREATE TABLE IF NOT EXISTS posts (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status        text NOT NULL CHECK (status IN ('draft', 'scheduled', 'publishing', 'published', 'failed')),
  body          text,
  scheduled_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- [existing]
-- One row per (post, social account) that was actually published.
-- This is the anchor for comments: it carries the platform-side post id.
CREATE TABLE IF NOT EXISTS post_publications (
  id                 uuid PRIMARY KEY,
  post_id            uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  social_account_id  uuid NOT NULL REFERENCES social_accounts(id) ON DELETE CASCADE,
  workspace_id       uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, -- denormalised for tenant scoping
  platform           text NOT NULL,                                             -- denormalised from social_accounts
  external_post_id   text NOT NULL,   -- tweet id / video id / IG media id / LinkedIn URN ...
  permalink          text,
  published_at       timestamptz NOT NULL,
  UNIQUE (social_account_id, external_post_id)
);

CREATE INDEX IF NOT EXISTS post_publications_post_idx ON post_publications (post_id);

-- ---------------------------------------------------------------- [new]
-- Local mirror of comments on a publication + replies created through our API.
CREATE TABLE IF NOT EXISTS comments (
  id                  uuid PRIMARY KEY,
  -- workspace_id and platform are copied from the publication by the service so the hot
  -- queries (tenant scoping, platform filter) need no join. They never change for a row.
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  publication_id      uuid NOT NULL REFERENCES post_publications(id) ON DELETE CASCADE,
  platform            text NOT NULL,

  -- Platform identity. NULL while an app-originated reply is still pending.
  external_id         text,
  -- Platform-side parent id as reported by the platform (NULL = top-level comment on the post).
  -- Kept even when parent_id is resolved, so orphans (parent not synced / deleted) can be re-linked later.
  external_parent_id  text,

  -- Thread structure, resolved from external ids after each sync (see CommentRepository.resolveParents).
  -- Rows are never hard-deleted once they carry an external id (deletions are status = 'deleted'),
  -- hence RESTRICT: a dangling parent would silently turn its children into top-level comments.
  parent_id           uuid REFERENCES comments(id) ON DELETE RESTRICT,
  -- Top-level comment of the thread (own id for a top-level comment). Indexed for thread listing.
  root_id             uuid NOT NULL,
  -- Materialised path "rootId/childId/grandchildId" (comment's own id is the last segment).
  -- Gives "all descendants of any node" with a prefix match; no recursive CTE needed.
  thread_path         text NOT NULL,
  depth               smallint NOT NULL DEFAULT 0,

  author_external_id  text,
  author_name         text,
  author_handle       text,
  author_avatar_url   text,
  -- True when the author is the connected account itself (our own replies, or the owner commenting natively).
  is_own              boolean NOT NULL DEFAULT false,

  body                text NOT NULL,
  permalink           text,
  origin              text NOT NULL CHECK (origin IN ('platform', 'app')),
  status              text NOT NULL CHECK (status IN ('published', 'pending', 'failed', 'deleted')),

  -- Client-supplied key for app-originated replies. Makes POST /replies safe to retry.
  idempotency_key     text,
  -- sha256(target comment id + text): a reused key with a different payload is rejected, not replayed.
  idempotency_fingerprint text,
  -- Last delivery error for app-originated replies: { "code", "message", "retryable" }.
  -- jsonb because it is a diagnostic payload shown to the user, not something we query by;
  -- failure analytics belong in logs/metrics, not in this table.
  error               jsonb,
  -- Platform-specific counters (likes, platform-reported reply count, ...). Not used for logic.
  metrics             jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- When the comment was posted on the platform. For app-originated replies it is set at
  -- creation time and refined with the platform's timestamp on the next sync.
  posted_at           timestamptz NOT NULL,
  synced_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (publication_id, external_id),          -- NULLs are distinct, so pending replies never collide
  UNIQUE (workspace_id, idempotency_key)
);

-- Top-level listing per publication, newest first, keyset-paginated on (posted_at, id).
CREATE INDEX IF NOT EXISTS comments_publication_top_level_idx
  ON comments (publication_id, posted_at DESC, id DESC)
  WHERE parent_id IS NULL;

-- Whole thread of a top-level comment, oldest first, keyset-paginated: (root_id, posted_at, id).
CREATE INDEX IF NOT EXISTS comments_root_idx
  ON comments (root_id, posted_at, id);

-- Subtree of a nested comment: thread_path LIKE '<path>/%' (rare; sorted in memory, subtrees are small).
CREATE INDEX IF NOT EXISTS comments_thread_path_idx
  ON comments (thread_path text_pattern_ops);

-- Direct replies of a comment, oldest first, and reply counts.
CREATE INDEX IF NOT EXISTS comments_parent_idx ON comments (parent_id, posted_at, id);

-- Reconciliation of replies whose delivery outcome is unknown (see CommentSyncService.reconcilePendingReplies).
CREATE INDEX IF NOT EXISTS comments_pending_idx
  ON comments (publication_id, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS comments_own_platform_idx
  ON comments (publication_id, posted_at)
  WHERE is_own AND origin = 'platform';
CREATE INDEX IF NOT EXISTS comments_unresolved_parent_idx
  ON comments (publication_id, external_parent_id)
  WHERE parent_id IS NULL AND external_parent_id IS NOT NULL;

-- ---------------------------------------------------------------- [new]
-- Per-publication sync bookkeeping. Doubles as the work queue for the background poller
-- (claimDue: UPDATE ... FROM (SELECT ... WHERE next_sync_at <= now() FOR UPDATE SKIP LOCKED)) and
-- as a fenced, lease-based lock that prevents two workers from syncing the same publication.
CREATE TABLE IF NOT EXISTS comment_sync_states (
  publication_id        uuid PRIMARY KEY REFERENCES post_publications(id) ON DELETE CASCADE,
  status                text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'failed')),
  -- Opaque, provider-defined incremental cursor (e.g. X since_id). NULL = provider has no incremental mode.
  -- Only advanced once a walk over the backlog completes, so partial runs never skip pages.
  cursor                text,
  -- In-progress walk that hit the per-run page cap, NULL when idle:
  --   { "pageToken": "...", "sinceCursor": "...", "candidateCursor": "..." }
  -- pageToken = where to resume, sinceCursor = the cursor the walk was started with (a
  -- continuation must reuse the same query), candidateCursor = value to commit on completion.
  continuation          jsonb,
  last_synced_at        timestamptz,
  -- Last time a complete walk over the whole backlog finished. Incremental runs only see new
  -- comments, so a periodic full walk refreshes metrics and edits of older ones.
  last_full_sync_at     timestamptz,
  next_sync_at          timestamptz,
  -- Lease. A crashed worker's lock expires instead of blocking forever; the token fences
  -- finish/fail so a worker whose lease expired cannot overwrite a newer run's state.
  lock_token            uuid,
  lock_expires_at       timestamptz,
  consecutive_failures  integer NOT NULL DEFAULT 0,
  last_error            text,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- Not partial on purpose: the poller's predicate also admits running rows with an expired lease.
CREATE INDEX IF NOT EXISTS comment_sync_states_due_idx
  ON comment_sync_states (next_sync_at);

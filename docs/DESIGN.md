# Design

Comment system for a social media scheduling API that publishes to several platforms.
This document explains the choices; the code and schema are the reference.

Contents

1. Context and assumptions
2. Data model
3. Platform abstraction
4. Sync: how comments get into the system
5. Replies: the write path
6. REST API shape
7. Known gaps and next steps
8. Adding a platform

## 1. Context and assumptions

The task leaves things open on purpose. What I assumed:

- **Multi-tenant SaaS.** Every request belongs to a _workspace_ (the paying customer, which
  may be a person or a team). Every table carries `workspace_id` and every query filters by it.
- **The scheduler already exists.** Users connect social accounts (OAuth), create posts, and
  the system publishes them. I therefore treat `workspaces`, `social_accounts`, `posts` and
  `post_publications` as existing tables and only add what the comment feature needs.
  They are included in `db/schema.sql` in reduced form so the schema applies cleanly.
- **A post can be published to several accounts.** "Post to X, LinkedIn and Threads at 9am"
  is the core use case of a scheduler, so one post yields N publications, each with its own
  platform-side id. Comments exist per publication.
- **"Comments" means public replies on the platform.** For X that is replies in the
  conversation; for YouTube, comment threads; for Instagram, comments on the media.
  DMs and mentions elsewhere are out of scope.
- **Only the connected account replies.** A reply is posted as the account that owns the
  publication. Replying "as" a different account is not a use case.
- **Read-mostly, bursty.** Most comments arrive in the first hours after publishing; users
  check them a few times a day. That shapes the sync schedule.
- **Platforms differ and will keep differing.** Threading depth, reply length, pagination,
  the existence of an incremental fetch, quotas, and webhook support all vary. The system
  must absorb that variance in one place.

## 2. Data model

```
workspaces 1 ─── * social_accounts          (platform, external_account_id, tokens)   [existing]
workspaces 1 ─── * posts                                                               [existing]
posts      1 ─── * post_publications        (social_account_id, external_post_id)     [existing]
post_publications 1 ─── * comments          (external_id, parent_id, thread_path, status, origin)
post_publications 1 ─── 1 comment_sync_states (cursor, continuation, lease, schedule)
```

### comments

A local mirror of what the platform has, plus replies we created.

| Column                                               | Why it exists                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `publication_id`                                     | The anchor. A comment lives on one platform-side post.                                     |
| `external_id`                                        | Platform id. `UNIQUE (publication_id, external_id)` is what makes sync an upsert.          |
| `external_parent_id`                                 | Parent as the platform reports it. Kept even after resolution so orphans can be re-linked. |
| `parent_id`, `thread_path`, `depth`                  | Local thread structure (see below).                                                        |
| `origin` = platform \| app                           | Whether the row came from sync or from our reply endpoint.                                 |
| `status` = published \| pending \| failed \| deleted | Lifecycle of app-originated replies; `deleted` reserved for platform deletions.            |
| `idempotency_key`                                    | `UNIQUE (workspace_id, idempotency_key)` enforces at-most-once reply delivery.             |
| `is_own`                                             | Author is the connected account. Lets a UI show "you replied" and filter conversations.    |
| `metrics jsonb`                                      | Likes and other platform counters. Displayed, never used for logic.                        |
| `posted_at`                                          | Platform timestamp; the sort key. Set to `now()` for pending replies and refined on sync.  |

Threads use a **materialised path** (`thread_path = rootId/childId/.../thisId`) plus a
denormalised `root_id`:

- "the whole thread of a top-level comment" (the common read) is `root_id = X`, served by
  the `(root_id, posted_at, id)` index with keyset pagination; a 50k-reply thread pages
  without sorting the thread.
- "the subtree under a nested comment" (rare, small) is `thread_path LIKE 'X-path/%'`.
- "direct replies" is `parent_id = X` on `(parent_id, posted_at, id)`, and `replyCount`
  counts exactly that set, so the number and the list never disagree.
- Depth is stored so the API can return it without parsing. Arbitrary depth exists because
  X nests without limit; a product UI may still flatten past two levels.
- `parent_id` is `ON DELETE RESTRICT`: rows with a platform id are never hard-deleted
  (deletions are `status = 'deleted'`), so a dangling parent cannot silently turn its
  children into top-level comments.
- A row is inserted with `thread_path = id` and `parent_id = NULL`; **parent resolution**
  runs after each sync as a set-based `UPDATE ... FROM comments p` that links rows whose
  parent is itself already resolved. It loops until no rows change, so a chain of depth N
  settles in N passes regardless of arrival order (platforms usually return newest first,
  i.e. children before parents).
- Orphans (parent deleted or never fetched) stay unresolved and show up as top-level with
  `externalParentId` set, which is what X itself does with "this post was deleted".

Why not adjacency-list only? Fetching a thread would need a recursive CTE per request.
Why not `ltree`? It would work, but a text prefix with `text_pattern_ops` needs no extension
and no escaping rules beyond `LIKE`. Why not nested sets? Inserts would rewrite siblings.
The path is a read optimisation; writes pay for it in `resolveParents`, which is set-based
and bounded by the number of unresolved rows.

Why `platform` is `text` and not an enum: adding a platform must not need a migration.
Validation happens in code (`PLATFORMS`).

### comment_sync_states

One row per publication with everything the sync process needs to be restartable:

- `cursor`: committed incremental cursor (X `since_id`). Advanced only when a walk completes.
- `continuation`: a walk that hit the per-run page cap stores its page token, the cursor
  it was started with, and the cursor candidate to commit. The next run resumes there.
- `status` + `lock_expires_at`: a lease. Two workers cannot sync the same publication at
  once, and a crashed worker's lock expires instead of blocking forever.
- `next_sync_at`, `consecutive_failures`: the schedule and the backoff state. This table
  _is_ the work queue: `WHERE next_sync_at <= now()`.

## 3. Platform abstraction

`src/platforms/provider.ts` defines the port:

```ts
interface CommentProvider {
  platform: Platform;
  capabilities: { threading: 'nested' | 'single-level'; maxReplyLength; incrementalSync; webhooks };
  fetchComments(input): Promise<{ comments: ExternalComment[]; nextPageToken; syncCursor }>;
  createReply(input): Promise<{ externalId; externalParentId; postedAt }>;
}
```

Decisions:

- **Two methods, not a generic client.** The rest of the system needs exactly these two
  things. Everything platform-specific (auth headers, field names, pagination style,
  nesting rules, which endpoint to hit) stays behind the port.
- **Capabilities are data, not code paths.** The service validates reply length and
  chooses the sync mode from `capabilities`; it never branches on `platform === 'youtube'`.
- **Adapters return the truth, the service reconciles.** On YouTube a reply to a reply is
  posted to the thread root; the adapter reports the real parent and the service attaches
  the local row where the platform put it (`test/reply.test.ts`, "single-level").
- **Two opaque cursors.** `pageToken` is within-run pagination; `syncCursor` is the cross-run
  incremental position. X has both (`next_token`, `since_id`); YouTube only has the first.
- **A request budget, not a page cap.** `fetchComments` receives `requestBudget` and reports
  `requestsUsed`, because a YouTube "page" can cost many HTTP calls (one per thread with more
  than five replies). The sync service budgets runs on real calls, which is what quotas count.
- **Typed failures, refined per platform.** Adapters translate HTTP failures into
  `PlatformError{kind}` with `auth | rate_limited | not_found | rejected | unavailable | unknown`,
  `retryable`, and `outcomeUnknown` (timeouts and 5xx: the request may have been applied).
  The generic status mapping is refined where platforms overload codes: X answers 403 for
  duplicate text and reply restrictions (`rejected`, not `auth`); YouTube answers 403 with a
  `reason` that distinguishes `quotaExceeded` (`rate_limited`) from `commentsDisabled`
  (`rejected`) from `insufficientPermissions` (`auth`). Getting this wrong tells a user to
  reconnect their account because they posted a duplicate.
- **Malformed items are skipped, not fatal.** A tweet without text or a thread without a
  snippet is dropped and logged; one odd item must not fail a run.
- **Injected HTTP client.** Adapters take a `fetch`-shaped function so they are unit-tested
  with recorded response shapes and can get retries/instrumentation in one place.

Shipped adapters: **X** (nested threads, `since_id`, 280 chars, 7-day search window) and
**YouTube** (single-level, no incremental fetch, 10k chars, quota-sensitive), plus an
in-memory **fake** used by tests and demo mode. Instagram, Facebook, LinkedIn, TikTok and
Threads fit the same port; notes per platform are in section 8.

## 4. Sync: how comments get into the system

### Mirror locally vs proxy the platform

| Proxy on every request                               | Mirror locally (chosen)                                |
| ---------------------------------------------------- | ------------------------------------------------------ |
| always fresh                                         | seconds to minutes stale, with explicit `syncedAt`     |
| N platform calls per page view, user waits           | one DB query, platform calls in the background         |
| cross-platform listing needs merge-pagination        | one keyset-paginated query across publications         |
| burns quota on every reload (YouTube: 10k units/day) | quota spent on a schedule that matches comment arrival |
| X search only returns 7 days                         | history is kept                                        |
| no place to hang unread state, assignments, search   | comments are rows: everything else builds on them      |

The product (comment management, dashboards) makes the second column the obvious choice.
Freshness is handled three ways, all going through the same `syncPublication`:

1. **Stale-while-revalidate on read.** `GET .../comments` returns what is stored and, if the
   publication was last synced more than `staleAfterMs` (2 min) ago, triggers a background
   sync. The response carries `meta.publications[].sync.lastSyncedAt` so a UI can show it.
2. **Background poller.** Re-syncs publications whose `next_sync_at` has passed. The delay
   decays with post age (1 min in the first hour, 5 min in the first day, 30 min in the
   first week, then 6 h / 24 h). This is where quota is spent proportionally to value.
3. **On demand.** `POST .../comments/sync` for "refresh now" buttons and for tests.

### One run

acquire lease -> fetch pages within the request budget -> upsert + link each page -> reconcile
pending replies -> commit cursor and schedule -> release. Properties:

- **Idempotent.** Re-running upserts the same rows (`ON CONFLICT (publication_id, external_id)`),
  as one multi-row statement per page (`unnest` over parallel arrays). A full re-sync is the
  same code with `mode=full`.
- **Bounded.** A viral post with 50k replies cannot monopolise a worker or a quota: a run stops
  after `maxRequestsPerRun` platform calls, stores its continuation and is rescheduled
  immediately. The incremental cursor is committed only when the walk completes, otherwise the
  next run would silently skip pages. Tested in both storages.
- **Linked per page.** Parent resolution runs after every page, so a reply never appears as a
  top-level comment while the rest of the walk is still in flight.
- **Concurrency-safe.** The lease is taken in a single `INSERT ... ON CONFLICT DO UPDATE ...
WHERE status <> 'running' OR lock_expires_at < now()`, renewed after each page, and fenced
  by a token: if a slow worker loses its lease, its `renew` fails, it aborts, and its later
  `finish`/`fail` are no-ops. Two workers cannot both commit.
- **Failure-aware.** Retryable platform failures (rate limit, 5xx) back off exponentially
  (1 min doubling, capped at 6 h). Non-retryable ones (revoked token, unsupported platform,
  a bug) pause the publication for `pausedRetryMs` (24 h) instead of retrying into a wall,
  and an `auth` failure flips the account to `reauth_required` so every other publication
  of that account stops too, until the user reconnects. Only domain/platform messages are
  stored in `last_error` (it is visible through the API); internals stay in the logs.

### Who triggers a run, and when it is refused

| Trigger    | Rule                                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| publishing | `scheduleInitialSync(publication)` puts a new publication on the poller's schedule (hook for the existing pipeline; demo mode calls it). |
| poller     | `next_sync_at <= now()`, one lease per publication; safe with several API instances.                                                     |
| read       | stale-while-revalidate, but never while a lease is live, never during a failed publication's backoff.                                    |
| manual     | `POST .../sync`: rate-limited per workspace and refused (`recently_synced`) within a short cooldown, so a client loop cannot burn quota. |

### Deletions and edits

Edits are picked up by upsert. Deletions are not detected: a platform simply stops returning
the comment. Marking "not seen in a full walk" as deleted is unreliable (hidden comments,
partial pages) so it is deliberately not done; `status = 'deleted'` is reserved for explicit
signals (webhook, or a reply failing with `not_found`).

## 5. Replies: the write path

```
1. Idempotency-Key seen before?  -> replay (table below), never touching the platform twice
2. load target comment, its publication, the account; check connected; check status published
3. validate text against provider.capabilities.maxReplyLength
4. INSERT comments row: status=pending, origin=app, idempotency_key + fingerprint   <- the unique index is the lock
5. provider.createReply(...)
6a. success            -> UPDATE row: external_id, status=published, parent as the platform attached it
6b. platform said no   -> UPDATE row: status=failed, error={kind, message, retryable}; rethrow (mapped to 4xx/5xx)
6c. outcome unknown    -> row stays pending with the error; the sync reconciles it (see below)
```

Replay rules for a repeated `Idempotency-Key`:

| Stored row                      | Response                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------- |
| different target or text        | `422 idempotency_key_reused` (a client bug, not a retry)                     |
| `published`                     | `200` with the reply                                                         |
| `pending`, no error (in flight) | `409 reply_in_progress { reason: in_flight }`                                |
| `pending` with error (unknown)  | `409 reply_in_progress { reason: awaiting_reconciliation }`                  |
| `failed`, `retryable: true`     | delivered again on the same row (rate limit, or reconciled as not delivered) |
| `failed`, `retryable: false`    | the original error again; a new key is needed after fixing the input         |

Decisions:

- **Synchronous, not queued.** A user clicking "reply" expects to see the result; platform
  latency is a second or two. Queueing would add a state to poll for no user benefit.
  What a queue would buy (retries on transient failure) is handled by the key: the client
  retries with the same key, and the pending row guarantees we never post twice.
- **Pending row before the platform call.** This is the important bit. It makes concurrent
  retries with the same key collide on the unique index (the second gets `409`), leaves an
  audit trail of failed attempts (visible in the thread with `status: failed`), and gives the
  reconciliation something to find after a crash between steps 4 and 6.
- **Unknown outcomes are reconciled, not guessed.** A timeout or 5xx means the platform may
  have posted the reply. Marking it failed and letting the client retry would double-post;
  marking it published would lie. So the row stays `pending` and the next sync of that
  publication reconciles it: if an own comment with the same text appeared after the attempt,
  that row is adopted (it keeps the platform id, takes over the key); if nothing appeared
  within `giveUpAfterMs` (10 min), the row becomes `failed` with `retryable: true` and the
  same key delivers again. Matching by author + text + time is a heuristic; it is the same
  one a human would apply, and the window is short.
- **The sync race is handled atomically.** If the poller syncs between steps 5 and 6a it
  inserts the reply under its external id first; our update then hits the unique index. The
  service adopts the synced row in one transaction (drop the pending row, transfer the key),
  so a crash in between cannot leave the key orphaned. Tested in both storages.
- **Own replies survive sync.** The next sync sees our comment on the platform and upserts
  the same row (same external id), keeping `origin=app` and the key.
- **A `not_found` from the platform marks the target `deleted`.** It is the one explicit
  deletion signal we get for free; the comment leaves the listing and further replies are
  refused with `409` instead of failing at the platform again.

### Transaction boundaries

Invariants that must hold atomically, and where they are enforced:

| Invariant                                         | Mechanism                                                    |
| ------------------------------------------------- | ------------------------------------------------------------ |
| one local row per (publication, platform comment) | unique index + single-statement multi-row upsert             |
| at most one delivery per Idempotency-Key          | unique index on the pending row, inserted before the call    |
| adopting a raced row never orphans the key        | `replacePending`: delete + update in one transaction         |
| two workers never both commit a run               | fenced lease: `finish`/`fail`/`renew` match the lock token   |
| the incremental cursor never skips pages          | committed only when a walk completes; continuation otherwise |

Everything else (linking parents, reconciliation, marking deleted) is idempotent and safe
to repeat, so it runs outside transactions.

## 6. REST API shape

Full reference in `API.md` / `openapi.yaml`. The choices:

- **Two thread views.** `GET /comments/{id}/replies` is direct replies (what `replyCount`
  counts); `GET /comments/{id}/thread` is the whole subtree, flat, for conversation views.
  One endpoint doing both under a `depth` flag would leave `replyCount` ambiguous.
- **Post-level listing, publication-level truth.** `GET /v1/posts/{postId}/comments` is what
  the requirement asks for and what a UI wants ("comments on my Tuesday post"), so it
  aggregates across the post's publications; every comment carries `platform` and
  `publicationId`, and `?platform=` narrows it. `meta.publications` lists what was
  aggregated with per-platform sync status, because "X is 30 s fresh, YouTube failed auth"
  is information the client needs.
- **Top-level first, thread on demand.** The list returns top-level comments with
  `replyCount`; `GET /v1/comments/{id}/replies` returns the whole subtree flat with
  `parentId`/`depth`, oldest first. Flat + parent ids paginates; nested JSON does not.
- **Keyset cursors** on `(posted_at, id)`, opaque base64. Offsets break as new comments
  arrive; cursors do not. `sort=newest|oldest`.
- **`replyCount` is the local count of synced replies**, consistent with what the replies
  endpoint returns. Platform-reported counts are exposed separately under `metrics`.
- **Reply is `POST /v1/comments/{id}/replies`** with a required `Idempotency-Key` header
  (a double-click without a key is two replies on the platform). `201` with `Location` on
  creation, `200` on replay. Errors are one shape everywhere:
  `{ error: { code, message, details } }`; platform failures keep their platform, `retryable`
  and `outcomeUnknown` flags, platform rate limits become `429` with `Retry-After`, auth
  failures become `502` with `action: reconnect_account`.
- **Ids are uuids and are validated as such** (`400` otherwise), so a garbage id never reaches
  the database as a cast error.
- **Rate limits per workspace**, with stricter budgets on the two endpoints that spend platform
  quota (`sync`, `replies`). Keyed by workspace, not IP, because one customer can have many
  clients and one IP can front many customers.
- **`POST /v1/posts/{postId}/comments/sync`** is an action, not a resource (there is no job
  to inspect later). It runs inline, isolates failures per publication (`status: failed`
  with a public error, HTTP still `200`), and is rate-limited. In production it would
  enqueue and return `202` with a job to poll; inline is fine for a refresh button and makes
  the demo and tests direct.
- **Errors are one envelope**, `{ error: { code, message, details } }`, rather than RFC 7807:
  our own UI and SDKs already consume this shape across the product, and one envelope beats
  two. Platform failures are `platform_<kind>`; the same codes are stored on a comment's
  `error`, so a client needs one dictionary.
- **Auth** is a bearer API key resolved to a workspace by SHA-256 digest (no plaintext keys in
  memory, no prototype-name lookups). Tenancy is structural rather than per query: every
  entry point takes the workspace (`posts.findById`, `comments.findById`, `listByPost`), and
  id-only lookups (a comment's publication, its account) are only reached through rows
  obtained that way. A cross-workspace HTTP test covers every route. Postgres row-level
  security with `SET app.workspace_id` would make the guarantee mechanical; that is the
  upgrade path, not a rewrite.

## 7. Known gaps and next steps

Ordered by what I would do first in the real product.

1. **Token lifecycle.** `CredentialsProvider` is a port with a static implementation.
   Production: decrypt, refresh when near expiry, persist. Marking `reauth_required` on an
   `auth` failure is done; flipping it back belongs to the reconnect flow.
2. **Webhooks** for platforms that offer them (Meta for Instagram/Facebook, LinkedIn).
   Treated as a _signal_, not a data source: a verified event just sets `next_sync_at = now`
   for the publication and the normal run fetches the truth. Meta's events are unordered,
   duplicated and occasionally lost, so the poller stays as an hourly fallback.
3. **Per-account rate limiting** in front of the adapters (token bucket keyed by
   `social_account_id`), plus honouring `Retry-After`. Today backoff is per publication and
   our own API is limited per workspace; the platform side is not throttled proactively.
4. **Worker separation.** Move the poller into a worker process on a queue (`FOR UPDATE SKIP
LOCKED` over `comment_sync_states`, or BullMQ). The fenced lease already makes this safe.
5. **Cross-publication listing at scale.** `GET /posts/{id}/comments` orders across N
   publications; the index is per publication, so Postgres sorts the union for each page.
   Fine for thousands of comments; for a viral post, denormalise `post_id` into `comments` and
   index `(post_id, posted_at, id) WHERE parent_id IS NULL`, or `UNION ALL` per publication.
   Beyond that: partition `comments` by `workspace_id` (tenant-local scans, easy retention),
   archive publications older than a year to cold storage.
6. **Deletions and moderation.** Only the reply-time `not_found` signal is handled. Next:
   tombstone on two consecutive full walks that do not return a comment while the parent's
   `platformReplies` dropped, and the write side (hide, delete, like) as further adapter methods.
7. **X weighted length.** Replies are pre-checked in UTF-16 units; X counts URLs as 23 and
   CJK as 2. A `measureLength` capability per adapter (twitter-text rules) would make the
   `422 validation_error` match the platform's answer exactly.
8. **More adapters** (section 8) and the write side of moderation: hide, delete, like.
9. **Observability.** Sync duration, requests per run, failures by `kind` and platform,
   reply latency, reconciliation outcomes. Structured logs exist; metrics do not.
10. **Multi-instance rate limiting.** `@fastify/rate-limit` keeps counters in process memory,
    so N instances multiply every limit by N; production uses its Redis store.
11. **Idempotency-Key retention.** Keys are unique per workspace forever. A client that
    recycles keys after months would get `422`; production expires them (Stripe: 24 h) with a
    periodic delete of `idempotency_key` on old published rows.
12. **Late-arriving parents.** If a parent arrives after its child was treated as a root,
    the child is re-linked but grandchildren keep the old path until a full walk. Rare, and
    fixable by re-resolving descendants of re-linked rows (`UPDATE ... WHERE thread_path LIKE old || '/%'`).
13. **Re-publication.** If the scheduler retries a publication whose outcome was unknown, the
    same post can end up with two publication rows on one account. The API already aggregates
    by post, so both threads show; a `superseded` status on publications would let the UI
    hide the dead one.

## 8. Adding a platform

1. Create `src/platforms/<name>.ts` implementing `CommentProvider`; declare capabilities honestly.
2. Map the platform's list endpoint to `ExternalComment[]` (top-level = `externalParentId: null`),
   return `nextPageToken` and, if the platform supports it, a `syncCursor`.
3. Map the reply endpoint; return the parent the platform actually used.
4. Translate errors with `throwForStatus`, passing a classifier for the platform's overloaded
   codes (Meta uses `code`/`error_subcode` pairs the way YouTube uses `reason`).
5. Add the platform to `PLATFORMS` (and the OpenAPI enum) if it is new, register the adapter
   in `container.ts`. No schema change, no service change.

Notes for the likely next ones:

| Platform  | Threading    | Incremental                    | Reply limit | Quirks                                                                |
| --------- | ------------ | ------------------------------ | ----------- | --------------------------------------------------------------------- |
| Instagram | single-level | no (`since` on some endpoints) | 2200        | Only business/creator accounts; replies via `/{comment-id}/replies`.  |
| Facebook  | nested       | `since` timestamp              | 8000        | `filter=stream` for flat listing; page tokens with page-level scopes. |
| LinkedIn  | nested (1)   | no                             | 1250        | URN-based ids; `socialActions/{urn}/comments`, `parentComment`.       |
| TikTok    | single-level | no                             | 150         | Comment APIs gated behind app review.                                 |
| Threads   | nested       | no                             | 500         | Graph-API shaped, like Instagram; replies via `/{id}/replies`.        |

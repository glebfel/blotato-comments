# REST API

Base path `/v1`. JSON in and out. Machine-readable version: [`openapi.yaml`](openapi.yaml).

## Authentication

`Authorization: Bearer <api key>`. A key resolves to exactly one workspace; every resource in
this API is scoped to it. Missing or unknown key: `401 unauthorized`.

Requests are rate-limited per workspace (`429 rate_limited`, with `Retry-After`); the sync
and reply endpoints have their own, stricter budgets because they spend platform quota.
All ids are uuids; anything else is `400 bad_request`.

## Resources

| Method | Path                            | Purpose                                               |
| ------ | ------------------------------- | ----------------------------------------------------- |
| GET    | `/posts/{postId}/comments`      | Top-level comments on a published post, all platforms |
| POST   | `/posts/{postId}/comments/sync` | Pull fresh comments from the platform(s) now          |
| GET    | `/comments/{commentId}`         | One comment                                           |
| GET    | `/comments/{commentId}/replies` | Whole thread under a comment, any depth               |
| POST   | `/comments/{commentId}/replies` | Reply to a comment                                    |
| GET    | `/health` (unauthenticated)     | Liveness                                              |

### Comment object

```json
{
  "id": "5d4c…",
  "publicationId": "…",
  "platform": "twitter",
  "externalId": "1834…",
  "parentId": null,
  "depth": 0,
  "author": { "externalId": "44196397", "name": "Alice", "handle": "alice", "avatarUrl": "https://…" },
  "isOwn": false,
  "text": "Does it support Threads?",
  "status": "published",
  "origin": "platform",
  "replyCount": 2,
  "metrics": { "likes": 5, "platformReplies": 2 },
  "error": null,
  "postedAt": "2026-09-10T09:12:44.000Z",
  "syncedAt": "2026-09-10T09:13:02.117Z",
  "createdAt": "2026-09-10T09:13:02.117Z"
}
```

- `status`: `published` (on the platform), `pending` (our reply is being delivered, or its
  outcome is unknown and awaits reconciliation), `failed` (our reply was not delivered; see
  `error`, whose `retryable` says whether the same key may try again), `deleted`.
- `origin`: `platform` (found by sync) or `app` (created through this API).
- `replyCount`: published direct replies known locally, i.e. exactly what
  `GET /comments/{id}/replies` returns. Platform-reported counts, where available, are in
  `metrics.platformReplies`.
- `permalink`: link to the comment on the platform, when the platform has stable URLs.
- `isOwn`: written by the connected account (our replies, or the owner commenting natively).

### GET /posts/{postId}/comments

Query: `platform` (one of the supported platforms), `limit` 1..100 (default 25),
`cursor` (opaque, from `meta.nextCursor`), `sort` = `newest` (default) | `oldest`.

Returns top-level comments across every publication of the post. Serves the local mirror
immediately; if a publication is older than the freshness window it is refreshed in the
background (`meta.publications[].sync` tells you how fresh each one is).

```json
{
  "data": [{ "...": "comment objects" }],
  "meta": {
    "nextCursor": "eyJ0IjoiMjAyNi0wOS0xMFQwOToxMjo0NC4wMDBaIiwiaWQiOiI1ZDRjIn0",
    "publications": [
      {
        "id": "…",
        "postId": "…",
        "platform": "twitter",
        "socialAccountId": "…",
        "externalPostId": "1834…",
        "permalink": "https://x.com/…",
        "publishedAt": "…",
        "sync": { "status": "idle", "lastSyncedAt": "…", "nextSyncAt": "…", "lastError": null }
      }
    ]
  }
}
```

Errors: `404 not_found` (no such post in this workspace), `409 post_not_published`
(post exists but has no publications yet), `422 validation_error` (bad cursor),
`400 bad_request` (bad query parameters).

### POST /posts/{postId}/comments/sync

Query: `platform` (optional), `mode` = `incremental` (default where supported) | `full`.

Runs the sync inline for each matching publication and returns what happened. Publications
already being synced by another worker are reported as `skipped`.

```json
{
  "data": [
    {
      "publicationId": "…",
      "status": "ok",
      "reason": null,
      "fetched": 12,
      "created": 3,
      "updated": 9,
      "linked": 2,
      "complete": true
    }
  ]
}
```

Platform failures surface with their kind (see Errors). In production this endpoint would
enqueue and return `202`; inline is deliberate for the take-home.

### GET /comments/{commentId}/replies

Query: `limit`, `cursor`. Direct replies of the comment, oldest first. Includes own pending
and failed replies so a UI can show delivery state.

### GET /comments/{commentId}/thread

Query: `limit`, `cursor`. Every descendant of the comment (any depth), flat, oldest first;
rebuild the tree with `parentId` / `depth`. On single-level platforms this is the same set
as `/replies`; on X it is the whole conversation under the comment.

### POST /comments/{commentId}/replies

Headers: `Idempotency-Key` (required; any string up to 255 chars, unique per workspace;
`400` without it, because a double-click without a key is two replies on the platform).
Body: `{ "text": "…" }` (empty or whitespace-only text is `422 validation_error`).

- `201` with the created comment and a `Location` header. `status` is `published` and
  `externalId` is set: the platform accepted it.
- `200` (no `Location`) with the previously stored reply when the same `Idempotency-Key` is
  sent again with the same target and text (no second platform call).
- Repeating a key after a failure: if the failure was retryable (`error.retryable`), the
  reply is delivered again under the same key; otherwise the original error is returned again
  and a new key is needed once the input is fixed. Repeating a key while the reply is pending
  answers `409 reply_in_progress`; `details.reason` is `in_flight` or, after a timeout,
  `awaiting_reconciliation` (the next sync settles it; `POST .../sync` forces that).
- Reusing a key with a different target or text is `422 idempotency_key_reused`.
- On single-level platforms (YouTube, Instagram) a reply to a reply is attached to the
  thread root, as the platform does; the response reflects the real parent.

Errors:

| Status | code                          | When                                                                     |
| ------ | ----------------------------- | ------------------------------------------------------------------------ |
| 400    | `bad_request`                 | body/params fail schema validation                                       |
| 404    | `not_found`                   | comment not in this workspace                                            |
| 409    | `reply_target_not_published`  | target is pending/failed/deleted                                         |
| 409    | `reply_in_progress`           | same key is being delivered right now                                    |
| 409    | `account_not_connected`       | owning social account needs re-authorisation                             |
| 422    | `validation_error`            | empty text or longer than the platform allows (`details.maxLength`)      |
| 422    | `platform_not_supported`      | no adapter for the platform                                              |
| 422    | `platform_rejected`           | platform refused (comments disabled, blocked, …)                         |
| 429    | `platform_rate_limited`       | platform rate limit; `Retry-After` when known                            |
| 404    | `platform_resource_not_found` | comment or post no longer exists on the platform                         |
| 502    | `platform_auth_error`         | token invalid; `details.action = reconnect_account`                      |
| 502    | `platform_unavailable`        | platform 5xx / timeout; outcome unknown, safe to retry with the same key |

## Error shape

```json
{
  "error": {
    "code": "platform_rate_limited",
    "message": "twitter create reply failed with HTTP 429: Too Many Requests",
    "details": { "platform": "twitter", "retryable": true }
  }
}
```

`code` is stable and meant for programmatic handling; `message` is for humans and may change.
Platform failures use `platform_<kind>` with kind in `auth | rate_limited | not_found | rejected |
unavailable | unknown`; the same codes appear in a comment's stored `error.code`, so a client
needs one dictionary. Errors raised by the framework (malformed JSON, payload too large) are
`400 bad_request` with the original code in `details.originalCode`. Unknown routes are
`404 not_found` in the same shape.

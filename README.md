# Comment system for a multi-platform scheduling API

Take-home for Blotato. Retrieve comments on a published post and reply to them across
several social platforms, exposed through a REST API. Partially implemented on purpose:
the design is complete, the code covers the core paths end to end (with tests), and the
gaps are listed explicitly.

| Asked for                        | Where                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| Database schema                  | [`db/schema.sql`](db/schema.sql) (annotated DDL), [Data model](docs/DESIGN.md#2-data-model) |
| API design                       | [`docs/API.md`](docs/API.md), [`docs/openapi.yaml`](docs/openapi.yaml)                      |
| TypeScript code                  | [`src/`](src), tests in [`test/`](test)                                                     |
| Design decisions and assumptions | [`docs/DESIGN.md`](docs/DESIGN.md)                                                          |

## The design in five sentences

1. A scheduled **post** fans out into one **publication** per connected social account, and
   comments belong to publications, because that is the thing that has a platform-side id.
2. Comments are **mirrored locally** and refreshed by a sync (background poll whose
   frequency decays with post age, stale-while-revalidate on reads, and an on-demand
   endpoint) rather than proxied live, which gives unified cross-platform pagination,
   protects platform quotas, and keeps history that platforms stop serving (X search only
   covers 7 days).
3. Each platform is an **adapter** behind a two-method port (`fetchComments`,
   `createReply`) that also declares its capabilities (nested vs single-level threading,
   reply length, incremental sync); adding a platform is one file and no schema change.
4. Threads are stored as a **materialised path** plus `root_id`, resolved from platform
   parent ids after each page in a set-based pass, so out-of-order arrival and arbitrary
   depth both work and a thread pages without sorting itself.
5. Replies are **written through synchronously** with an `Idempotency-Key`: a `pending`
   row is persisted before the platform call and becomes `published` or `failed`; when the
   platform's answer is lost (timeout), the row stays pending and the next sync reconciles
   it against what the platform actually has, so retries never double-post.

## Running it

Requirements: Node 20+. Postgres only for the `STORAGE=postgres` mode and the integration test.

```bash
npm install
npm run dev          # DEMO_MODE: in-memory storage + simulated X and YouTube with seeded threads
```

```bash
# Comments on the demo post (top-level, newest first, both platforms)
curl -s -H 'Authorization: Bearer demo' \
  localhost:3000/v1/posts/00000000-0000-4000-8000-000000000010/comments | jq

# Pick a comment id from the output, then read its replies / whole thread and reply to it
curl -s -H 'Authorization: Bearer demo' localhost:3000/v1/comments/<id>/replies | jq
curl -s -H 'Authorization: Bearer demo' localhost:3000/v1/comments/<id>/thread | jq
curl -s -X POST -H 'Authorization: Bearer demo' -H 'Idempotency-Key: 1' \
  -H 'Content-Type: application/json' -d '{"text":"Thanks!"}' \
  localhost:3000/v1/comments/<id>/replies | jq

# Pull fresh comments from the platform(s) now
curl -s -X POST -H 'Authorization: Bearer demo' \
  'localhost:3000/v1/posts/00000000-0000-4000-8000-000000000010/comments/sync' | jq
```

Tests:

```bash
npm test                                   # unit + HTTP tests, in-memory storage
docker compose up -d                       # Postgres 16 with db/schema.sql applied
DATABASE_URL=postgres://postgres:postgres@localhost:5432/blotato_comments npm test
                                           # ...also runs the Postgres integration test
npm run check                              # typecheck + eslint/prettier + tests (what CI runs)
npm run build
```

Against a real database with real platforms: `STORAGE=postgres DATABASE_URL=... DEMO_MODE=false
API_KEYS=key:workspaceId TWITTER_ACCESS_TOKEN=... npm start` (after `npm run build`). The
X and YouTube adapters are written from the public API references and unit-tested against
recorded response shapes; they have not been run against the live APIs from this repo.

## Layout

```
db/schema.sql               Postgres DDL, annotated
docs/DESIGN.md              decisions, assumptions, trade-offs, what is next
docs/API.md, openapi.yaml   REST API
src/domain                  types and error model (no framework imports)
src/platforms               CommentProvider port, registry, X + YouTube adapters, fake for tests/demo
src/repositories            persistence ports, in-memory and Postgres implementations
src/services                CommentService (list / thread / reply), CommentSyncService, poll schedule
src/http                    Fastify app: auth, routes, cursors, DTOs, error mapping
src/jobs/poller.ts          background re-sync loop
src/container.ts            composition root and config
test/                       vitest: services, HTTP, adapters, schedule, Postgres integration
```

## Scope

Implemented and tested:

- list top-level comments for a post across platforms with keyset pagination and platform filter
- read a comment, its direct replies, and its whole thread (any depth)
- reply to a comment with idempotency (replay rules per status, reused-key detection),
  validation against platform limits, single-level re-parenting, unknown-outcome
  reconciliation, and the sync race handled atomically
- sync: incremental cursors, request budget with continuation, fenced lease with renewal,
  retryable-aware backoff, account flagged for re-auth on token failures, stale-while-revalidate
  that respects backoff and post age, poller that claims with `SKIP LOCKED` and runs
  concurrently, set-based thread resolution, manual-sync cooldown, per-publication failure
  isolation
- X and YouTube adapters with per-platform error classification and permalinks, one public
  error vocabulary for HTTP and stored delivery errors, per-workspace rate limiting
- Postgres (multi-row upsert) and in-memory storage behind the same ports
- tooling: strict TypeScript, zod-validated configuration, ESLint (type-checked) + Prettier,
  CI workflow with Postgres

Deliberately left out (each is discussed in [DESIGN.md](docs/DESIGN.md#7-known-gaps-and-next-steps)):
OAuth token refresh, webhooks, deletion/hide/like, per-account platform-side rate limiting,
a real job queue, other platform adapters, X weighted-length rules, metrics/tracing.

## AI usage

This submission was built with Claude Code (Anthropic's CLI agent) doing most of the typing.

- I set the brief, the constraints and the direction (mirror the comments locally instead of
  proxying, attach them to publications rather than posts, synchronous replies guarded by an
  idempotency key), and reviewed and accepted each design decision. The assistant produced the
  first version of the schema, the code and these documents from that brief.
- I then ran two review passes with the assistant: a checklist review (security, efficiency,
  architecture, tests, adapted from the review checklist my current team uses) and an
  "interviewer" review whose job was to break the design. They produced about 85 findings.
  The medium ones changed the design and are the parts I would defend most carefully: the
  fenced sync lease, request budgets instead of page caps, reconciliation of replies whose
  outcome was unknown, the required `Idempotency-Key` with request fingerprinting,
  per-platform error classification, `SKIP LOCKED` claims for the poller.
- For calibration, things the first version got wrong and the reviews caught: the
  adopt-after-race path was two statements without a transaction; every platform 403 was
  mapped to "reconnect your account"; read-triggered refreshes ignored the failure backoff;
  an API key named `constructor` passed authentication because keys lived in a plain object.
- Verification was done outside the model after every round: typecheck, ESLint, the test
  suite including the Postgres integration tests in Docker, and a curl smoke test of the demo
  server. The X and YouTube adapters were written from the public API references and tested
  against recorded response shapes; they have not been run against the live APIs.

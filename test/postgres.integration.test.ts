import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateReplyInput } from '../src/platforms/provider.js';
import { StaticCredentialsProvider } from '../src/platforms/credentials.js';
import { FakeCommentProvider } from '../src/platforms/fake.js';
import { ProviderRegistry } from '../src/platforms/registry.js';
import { createPgRepositories } from '../src/repositories/postgres.js';
import type { Repositories } from '../src/repositories/interfaces.js';
import { CommentService } from '../src/services/comment-service.js';
import { CommentSyncService } from '../src/services/sync-service.js';
import { FixedClock, silentLogger } from './helpers.js';

/**
 * Runs the same flows as the in-memory tests against real Postgres.
 * Skipped unless DATABASE_URL is set. Uses a throw-away schema so it is safe to point at a dev DB.
 */
const url = process.env.DATABASE_URL;
const describeDb = url ? describe : describe.skip;

describeDb('Postgres repositories', () => {
  const schema = `t_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const ids = {
    workspace: randomUUID(),
    account: randomUUID(),
    post: randomUUID(),
    publication: randomUUID(),
  };
  let pool: pg.Pool;
  let repos: Repositories;
  let twitter: FakeCommentProvider;
  let sync: CommentSyncService;
  let comments: CommentService;
  const clock = new FixedClock();

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();

    pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await pool.query(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
    await pool.query(`INSERT INTO workspaces (id, name) VALUES ($1, 'test')`, [ids.workspace]);
    await pool.query(
      `INSERT INTO social_accounts (id, workspace_id, platform, external_account_id, display_name, handle)
       VALUES ($1, $2, 'twitter', 'x-own', 'Own', 'own')`,
      [ids.account, ids.workspace],
    );
    await pool.query(`INSERT INTO posts (id, workspace_id, status) VALUES ($1, $2, 'published')`, [
      ids.post,
      ids.workspace,
    ]);
    await pool.query(
      `INSERT INTO post_publications (id, post_id, social_account_id, workspace_id, platform, external_post_id, published_at)
       VALUES ($1, $2, $3, $4, 'twitter', 'tweet-1', $5)`,
      [ids.publication, ids.post, ids.account, ids.workspace, new Date(clock.now().getTime() - 60_000)],
    );

    repos = createPgRepositories(pool);
    twitter = new FakeCommentProvider({ platform: 'twitter', ownAccountId: 'x-own', pageSize: 2, clock });
    const providers = new ProviderRegistry().register(twitter);
    const credentials = new StaticCredentialsProvider({}, 'test-token');
    sync = new CommentSyncService({
      repos,
      providers,
      credentials,
      clock,
      logger: silentLogger,
      options: { maxRequestsPerRun: 1, manualCooldownMs: 0, reconcileAfterMs: 1_000, giveUpAfterMs: 5_000 },
    });
    comments = new CommentService({ repos, providers, credentials, sync, clock, logger: silentLogger });
  });

  afterAll(async () => {
    await pool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool?.end();
  });

  it('syncs in bounded runs, resolves nested threads set-based and paginates with keyset cursors', async () => {
    const a = twitter.seed('tweet-1', { body: 'A' });
    const b = twitter.seed('tweet-1', { body: 'B -> A', externalParentId: a });
    const c = twitter.seed('tweet-1', { body: 'C -> B', externalParentId: b });
    twitter.seed('tweet-1', { body: 'D' });
    twitter.seed('tweet-1', { body: 'E' });

    // pageSize 2, one request per run: three runs to walk five comments, cursor committed only at the end.
    expect(await sync.syncPublication(ids.publication)).toMatchObject({ fetched: 2, complete: false });
    expect((await repos.syncStates.get(ids.publication))?.cursor).toBeNull();
    expect(await sync.syncPublication(ids.publication)).toMatchObject({ fetched: 2, complete: false });
    expect(await sync.syncPublication(ids.publication)).toMatchObject({ fetched: 1, complete: true });
    expect((await repos.syncStates.get(ids.publication))?.cursor).toBe('5');

    const rowA = (await repos.comments.findByExternalId(ids.publication, a))!;
    const rowB = (await repos.comments.findByExternalId(ids.publication, b))!;
    const rowC = (await repos.comments.findByExternalId(ids.publication, c))!;
    expect(rowB).toMatchObject({ parentId: rowA.id, depth: 1, threadPath: `${rowA.id}/${rowB.id}` });
    expect(rowC).toMatchObject({ parentId: rowB.id, depth: 2, threadPath: `${rowA.id}/${rowB.id}/${rowC.id}` });

    const page1 = await repos.comments.listTopLevel({
      publicationIds: [ids.publication],
      limit: 2,
      cursor: null,
      sort: 'newest',
    });
    expect(page1.items.map((i) => i.body)).toEqual(['E', 'D']);
    const page2 = await repos.comments.listTopLevel({
      publicationIds: [ids.publication],
      limit: 2,
      cursor: page1.nextCursor,
      sort: 'newest',
    });
    expect(page2.items.map((i) => i.body)).toEqual(['A']);
    expect(page2.nextCursor).toBeNull();

    const scope = { rootId: rowA.rootId, threadPath: rowA.threadPath, depth: rowA.depth };
    const subtree = await repos.comments.listDescendants({ ...scope, limit: 1, cursor: null });
    expect(subtree.items.map((i) => i.body)).toEqual(['B -> A']);
    const rest = await repos.comments.listDescendants({ ...scope, limit: 1, cursor: subtree.nextCursor });
    expect(rest.items.map((i) => i.body)).toEqual(['C -> B']);
    const nested = await repos.comments.listDescendants({
      rootId: rowB.rootId,
      threadPath: rowB.threadPath,
      depth: rowB.depth,
      limit: 10,
      cursor: null,
    });
    expect(nested.items.map((i) => i.body)).toEqual(['C -> B']);
    const children = await repos.comments.listChildren({ parentId: rowA.id, limit: 10, cursor: null });
    expect(children.items.map((i) => i.body)).toEqual(['B -> A']);
    expect(rowC.rootId).toBe(rowA.id);
    expect(await repos.comments.countReplies([rowA.id, rowB.id, rowC.id])).toEqual(
      new Map([
        [rowA.id, 1],
        [rowB.id, 1],
      ]),
    );

    // An explicit full walk re-reads everything (budget still applies) and updates instead of duplicating.
    expect(await sync.syncPublication(ids.publication, { mode: 'full' })).toMatchObject({
      created: 0,
      updated: 2,
      complete: false,
    });
    expect((await repos.syncStates.get(ids.publication))?.continuation).toEqual({
      pageToken: '2',
      sinceCursor: null,
      candidateCursor: '5',
    });
    expect(await sync.syncPublication(ids.publication)).toMatchObject({ created: 0, updated: 2, complete: false });
    expect(await sync.syncPublication(ids.publication)).toMatchObject({ created: 0, updated: 1, complete: true });
    expect(await repos.syncStates.get(ids.publication)).toMatchObject({ cursor: '5', continuation: null });
  });

  it('breaks keyset ties on id so identical timestamps paginate without gaps', async () => {
    const sameSecond = new Date('2026-02-02T00:00:00Z');
    for (let i = 1; i <= 3; i++) twitter.seed('tweet-1', { body: `tie${i}`, postedAt: sameSecond });
    await sync.syncPublication(ids.publication, { mode: 'full' });
    await sync.syncPublication(ids.publication);
    await sync.syncPublication(ids.publication);
    await sync.syncPublication(ids.publication);

    const seen: string[] = [];
    let cursor = null;
    do {
      const page = await repos.comments.listTopLevel({
        publicationIds: [ids.publication],
        limit: 2,
        cursor,
        sort: 'newest',
      });
      seen.push(...page.items.map((i) => i.body));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.filter((b) => b.startsWith('tie')).sort()).toEqual(['tie1', 'tie2', 'tie3']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('replies with idempotency enforced by the unique index and survives a racing sync', async () => {
    const rowA = (await repos.comments.findByExternalId(ids.publication, 'twitter-c1'))!;
    const first = await comments.reply(ids.workspace, rowA.id, { text: 'thanks', idempotencyKey: 'k1' });
    expect(first.comment).toMatchObject({
      status: 'published',
      origin: 'app',
      isOwn: true,
      parentId: rowA.id,
      depth: 1,
    });
    expect(first.comment.externalId).toBeTruthy();

    const replay = await comments.reply(ids.workspace, rowA.id, { text: 'thanks', idempotencyKey: 'k1' });
    expect(replay).toMatchObject({ created: false, comment: { id: first.comment.id } });
    expect(twitter.calls.reply).toBe(1);

    // The next sync sees our reply on the platform and updates the same row.
    expect(await sync.syncPublication(ids.publication)).toMatchObject({
      fetched: 1,
      created: 0,
      updated: 1,
      complete: true,
    });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM comments WHERE external_id = $1', [
      first.comment.externalId,
    ]);
    expect(rows[0].n).toBe(1);

    // Race: a sync inserts the platform row before we finalise -> adopt it inside one transaction.
    const original = twitter.createReply.bind(twitter);
    twitter.createReply = async (input: CreateReplyInput) => {
      const result = await original(input);
      await sync.syncPublication(ids.publication);
      return result;
    };
    const raced = await comments.reply(ids.workspace, rowA.id, { text: 'racy', idempotencyKey: 'k2' });
    twitter.createReply = original;
    expect(raced.comment).toMatchObject({ status: 'published', origin: 'app', idempotencyKey: 'k2' });
    const { rows: racy } = await pool.query(`SELECT count(*)::int AS n FROM comments WHERE body = 'racy'`);
    expect(racy[0].n).toBe(1);
    expect((await comments.getById(ids.workspace, rowA.id)).replyCount).toBe(3); // B -> A, thanks, racy
  });

  it('reconciles an unknown-outcome reply against the platform', async () => {
    const rowA = (await repos.comments.findByExternalId(ids.publication, 'twitter-c1'))!;
    twitter.failNext('unavailable', 'timeout', { afterApply: true });
    await expect(comments.reply(ids.workspace, rowA.id, { text: 'lost', idempotencyKey: 'k3' })).rejects.toMatchObject({
      kind: 'unavailable',
    });
    expect((await repos.comments.findByIdempotencyKey(ids.workspace, 'k3'))?.status).toBe('pending');

    clock.advance(2_000);
    expect(await sync.syncPublication(ids.publication)).toMatchObject({ reconciled: 1 });
    const adopted = (await repos.comments.findByIdempotencyKey(ids.workspace, 'k3'))!;
    expect(adopted).toMatchObject({ status: 'published', origin: 'app', body: 'lost', parentId: rowA.id });
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM comments WHERE body = 'lost'`);
    expect(rows[0].n).toBe(1);
  });

  it('hands the sync lease to exactly one caller and fences stale holders', async () => {
    const now = clock.now();
    const [first, second] = await Promise.all([
      repos.syncStates.tryAcquire(ids.publication, now, 60_000),
      repos.syncStates.tryAcquire(ids.publication, now, 60_000),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    const lease = (first ?? second)!;

    const later = new Date(now.getTime() + 61_000);
    expect(await repos.syncStates.claimDue(now, 10, 60_000)).toEqual([]); // running with a live lease
    const takeover = await repos.syncStates.tryAcquire(ids.publication, later, 60_000);
    expect(takeover).not.toBeNull();
    expect(await repos.syncStates.renew(ids.publication, lease.lockToken, later, 60_000)).toBe(false);
    expect(
      await repos.syncStates.finish(ids.publication, lease.lockToken, {
        cursor: 'x',
        continuation: null,
        lastSyncedAt: later,
        nextSyncAt: later,
      }),
    ).toBe(false);
    expect(
      await repos.syncStates.finish(ids.publication, takeover!.lockToken, {
        cursor: 'y',
        continuation: null,
        lastSyncedAt: later,
        nextSyncAt: later,
      }),
    ).toBe(true);
    expect((await repos.syncStates.get(ids.publication))?.cursor).toBe('y');
  });

  it('claims due publications with their lease in one statement', async () => {
    const due = new Date(clock.now().getTime() + 120_000);
    const holder = (await repos.syncStates.tryAcquire(ids.publication, due, 1))!;
    await repos.syncStates.finish(ids.publication, holder.lockToken, {
      cursor: null,
      continuation: null,
      lastSyncedAt: due,
      nextSyncAt: due,
    });
    const claimed = await repos.syncStates.claimDue(due, 10, 60_000);
    expect(claimed.map((l) => l.state.publicationId)).toEqual([ids.publication]);
    expect(claimed[0]!.state.status).toBe('running');
    expect(await repos.syncStates.claimDue(due, 10, 60_000)).toEqual([]); // already claimed
    expect(await repos.syncStates.renew(ids.publication, claimed[0]!.lockToken, due, 60_000)).toBe(true);
    expect(await sync.syncPublication(ids.publication, { lease: claimed[0] })).toMatchObject({ status: 'ok' });

    // scheduleNoLaterThan only ever moves the run earlier.
    const scheduled = (await repos.syncStates.get(ids.publication))!.nextSyncAt!;
    const earlier = new Date(scheduled.getTime() - 1_000);
    await repos.syncStates.scheduleNoLaterThan(ids.publication, earlier);
    expect((await repos.syncStates.get(ids.publication))?.nextSyncAt).toEqual(earlier);
    await repos.syncStates.scheduleNoLaterThan(ids.publication, new Date(scheduled.getTime() + 60_000));
    expect((await repos.syncStates.get(ids.publication))?.nextSyncAt).toEqual(earlier);
  });
});

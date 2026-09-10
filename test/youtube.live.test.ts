import { describe, expect, it } from 'vitest';
import { createFetchHttpClient } from '../src/platforms/http.js';
import { StaticCredentialsProvider } from '../src/platforms/credentials.js';
import { ProviderRegistry } from '../src/platforms/registry.js';
import { YouTubeCommentProvider } from '../src/platforms/youtube.js';
import { createInMemoryRepositories } from '../src/repositories/memory.js';
import { CommentSyncService } from '../src/services/sync-service.js';
import { FixedClock, IDS, silentLogger } from './helpers.js';

/**
 * Runs the YouTube adapter against the real Data API. Needs a Google API key with the
 * YouTube Data API v3 enabled (reading public comments costs 1 quota unit per call):
 *   YOUTUBE_API_KEY=... npm test
 * Optional: YOUTUBE_LIVE_VIDEO_ID (default: a public video with a large comment section).
 * Skipped when the key is absent, so CI and offline runs are unaffected.
 */
const apiKey = process.env.YOUTUBE_API_KEY;
const videoId = process.env.YOUTUBE_LIVE_VIDEO_ID ?? 'dQw4w9WgXcQ';
const describeLive = apiKey ? describe : describe.skip;

describeLive('YouTube adapter against the live Data API', () => {
  const credentials = { accessToken: null, apiKey: apiKey ?? null };
  const provider = new YouTubeCommentProvider(createFetchHttpClient({ timeoutMs: 20_000 }));

  it('reads real comment threads with an API key and maps them to the domain shape', async () => {
    const page = await provider.fetchComments({
      credentials,
      externalPostId: videoId,
      pageToken: null,
      syncCursor: null,
      requestBudget: 3,
    });

    expect(page.comments.length).toBeGreaterThan(0);
    expect(page.requestsUsed).toBeGreaterThanOrEqual(1);
    expect(page.requestsUsed).toBeLessThanOrEqual(3);
    expect(page.syncCursor).toBeNull();
    expect(page.nextPageToken).toBeTruthy(); // the default video has far more than one page

    const topLevel = page.comments.filter((c) => c.externalParentId === null);
    const topIds = new Set(topLevel.map((c) => c.externalId));
    expect(topLevel.length).toBeGreaterThan(0);
    for (const c of page.comments) {
      expect(c.externalId).toMatch(/\S/);
      expect(typeof c.body).toBe('string');
      expect(Number.isNaN(c.postedAt.getTime())).toBe(false);
      expect(c.permalink).toBe(`https://www.youtube.com/watch?v=${videoId}&lc=${encodeURIComponent(c.externalId)}`);
      expect(c.metrics.likes).toBeGreaterThanOrEqual(0);
      if (c.externalParentId !== null) expect(topIds.has(c.externalParentId)).toBe(true); // replies belong to threads on this page
    }
  });

  it('syncs a real video into the local mirror end to end', async () => {
    const repos = createInMemoryRepositories();
    const clock = new FixedClock(new Date());
    repos.accounts.add({
      id: IDS.youtubeAccount,
      workspaceId: IDS.workspace,
      platform: 'youtube',
      externalAccountId: 'channel-under-test',
      displayName: null,
      handle: null,
      avatarUrl: null,
      status: 'connected',
    });
    repos.publications.add({
      id: IDS.youtubePublication,
      postId: IDS.post,
      workspaceId: IDS.workspace,
      socialAccountId: IDS.youtubeAccount,
      platform: 'youtube',
      externalPostId: videoId,
      permalink: null,
      publishedAt: new Date(clock.now().getTime() - 3_600_000),
    });
    const sync = new CommentSyncService({
      repos,
      providers: new ProviderRegistry().register(provider),
      credentials: new StaticCredentialsProvider({ youtube: { apiKey: apiKey! } }),
      clock,
      logger: silentLogger,
      options: { maxRequestsPerRun: 3 },
    });

    const result = await sync.syncPublication(IDS.youtubePublication);
    expect(result.status).toBe('ok');
    expect(result.fetched).toBeGreaterThan(0);
    expect(result.created).toBe(result.fetched);

    const top = await repos.comments.listTopLevel({
      publicationIds: [IDS.youtubePublication],
      limit: 5,
      cursor: null,
      sort: 'newest',
    });
    expect(top.items.length).toBeGreaterThan(0);
    expect(top.items[0]!).toMatchObject({ platform: 'youtube', origin: 'platform', status: 'published', depth: 0 });
    const state = (await repos.syncStates.get(IDS.youtubePublication))!;
    expect(state.status).toBe('idle');
    expect(state.lastSyncedAt).toEqual(clock.now());
  });

  it('classifies real failures: unknown video is not_found, bad key is auth', async () => {
    await expect(
      provider.fetchComments({
        credentials,
        externalPostId: 'no-such-video-id-000',
        pageToken: null,
        syncCursor: null,
        requestBudget: 1,
      }),
    ).rejects.toMatchObject({ kind: 'not_found', retryable: false });

    await expect(
      provider.fetchComments({
        credentials: { accessToken: null, apiKey: 'definitely-invalid-key' },
        externalPostId: videoId,
        pageToken: null,
        syncCursor: null,
        requestBudget: 1,
      }),
    ).rejects.toMatchObject({ kind: 'auth' });
  });
});

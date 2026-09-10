import type { Clock, Platform } from '../src/domain/types.js';
import { silentLogger } from '../src/logger.js';
import { StaticCredentialsProvider } from '../src/platforms/credentials.js';
import { FakeCommentProvider } from '../src/platforms/fake.js';
import { ProviderRegistry } from '../src/platforms/registry.js';
import { createInMemoryRepositories, type InMemoryRepositories } from '../src/repositories/memory.js';
import { CommentService } from '../src/services/comment-service.js';
import { CommentSyncService, type SyncOptions } from '../src/services/sync-service.js';

export { silentLogger };

export class FixedClock implements Clock {
  constructor(public current = new Date('2026-09-10T12:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Fixed uuids so HTTP tests can use them in paths (the API validates ids as uuids). */
export const IDS = {
  workspace: '11111111-1111-4111-8111-111111111111',
  otherWorkspace: '22222222-2222-4222-8222-222222222222',
  post: '33333333-3333-4333-8333-333333333333',
  draftPost: '33333333-3333-4333-8333-333333333334',
  otherPost: '33333333-3333-4333-8333-333333333335',
  twitterAccount: '44444444-4444-4444-8444-444444444441',
  youtubeAccount: '44444444-4444-4444-8444-444444444442',
  instagramAccount: '44444444-4444-4444-8444-444444444443',
  twitterPublication: '55555555-5555-4555-8555-555555555551',
  youtubePublication: '55555555-5555-4555-8555-555555555552',
  instagramPublication: '55555555-5555-4555-8555-555555555553',
  tweet: 'tweet-1',
  video: 'video-1',
  igMedia: 'ig-1',
} as const;

export interface Harness {
  repos: InMemoryRepositories;
  providers: ProviderRegistry;
  twitter: FakeCommentProvider;
  youtube: FakeCommentProvider;
  sync: CommentSyncService;
  comments: CommentService;
  clock: FixedClock;
}

export interface HarnessOptions extends Partial<SyncOptions> {
  pageSize?: number;
  staleAfterMs?: number;
  staleMaxMs?: number;
  /** Age of the demo post at harness creation (default 30 minutes). */
  postAgeMs?: number;
  /** Also publish the post to an 'instagram' account for which no adapter is registered. */
  withUnsupportedPlatform?: boolean;
}

export function createHarness(opts: HarnessOptions = {}): Harness {
  const { pageSize, staleAfterMs, staleMaxMs, postAgeMs, withUnsupportedPlatform, ...syncOptions } = opts;
  const repos = createInMemoryRepositories();
  const clock = new FixedClock();
  const twitter = new FakeCommentProvider({
    platform: 'twitter',
    threading: 'nested',
    maxReplyLength: 280,
    ownAccountId: 'x-own',
    pageSize,
    clock,
    postedAtBase: new Date('2026-01-01T00:00:00Z'),
  });
  const youtube = new FakeCommentProvider({
    platform: 'youtube',
    threading: 'single-level',
    maxReplyLength: 10_000,
    incrementalSync: false,
    ownAccountId: 'yt-own',
    pageSize,
    clock,
    postedAtBase: new Date('2026-01-01T01:00:00Z'), // youtube comments sort after twitter ones
  });
  const providers = new ProviderRegistry().register(twitter).register(youtube);
  const credentials = new StaticCredentialsProvider({}, 'test-token');
  const sync = new CommentSyncService({
    repos,
    providers,
    credentials,
    clock,
    logger: silentLogger,
    options: { maxRequestsPerRun: 20, manualCooldownMs: 0, ...syncOptions },
  });
  const comments = new CommentService({
    repos,
    providers,
    credentials,
    sync,
    clock,
    logger: silentLogger,
    staleAfterMs,
    staleMaxMs,
  });

  const publishedAt = new Date(clock.now().getTime() - (postAgeMs ?? 30 * 60_000));
  repos.posts.add({ id: IDS.post, workspaceId: IDS.workspace, status: 'published' });
  repos.posts.add({ id: IDS.draftPost, workspaceId: IDS.workspace, status: 'draft' });
  repos.posts.add({ id: IDS.otherPost, workspaceId: IDS.otherWorkspace, status: 'published' });
  addAccount(repos, IDS.twitterAccount, 'twitter', 'x-own');
  addAccount(repos, IDS.youtubeAccount, 'youtube', 'yt-own');
  addPublication(repos, IDS.twitterPublication, IDS.twitterAccount, 'twitter', IDS.tweet, publishedAt);
  addPublication(repos, IDS.youtubePublication, IDS.youtubeAccount, 'youtube', IDS.video, publishedAt);
  if (withUnsupportedPlatform) {
    addAccount(repos, IDS.instagramAccount, 'instagram', 'ig-own');
    addPublication(repos, IDS.instagramPublication, IDS.instagramAccount, 'instagram', IDS.igMedia, publishedAt);
  }

  return { repos, providers, twitter, youtube, sync, comments, clock };
}

function addAccount(repos: InMemoryRepositories, id: string, platform: Platform, externalAccountId: string): void {
  repos.accounts.add({
    id,
    workspaceId: IDS.workspace,
    platform,
    externalAccountId,
    displayName: 'Own Account',
    handle: 'own',
    avatarUrl: null,
    status: 'connected',
  });
}

function addPublication(
  repos: InMemoryRepositories,
  id: string,
  socialAccountId: string,
  platform: Platform,
  externalPostId: string,
  publishedAt: Date,
): void {
  repos.publications.add({
    id,
    postId: IDS.post,
    workspaceId: IDS.workspace,
    socialAccountId,
    platform,
    externalPostId,
    permalink: null,
    publishedAt,
  });
}

/** Waits for background (read-triggered) syncs to settle. */
export async function settle(h: Harness): Promise<void> {
  await h.sync.idle();
}

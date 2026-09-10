import type { InMemoryRepositories } from '../repositories/memory.js';
import { FakeCommentProvider } from '../platforms/fake.js';
import type { ProviderRegistry } from '../platforms/registry.js';
import type { CommentSyncService } from '../services/sync-service.js';
import { DEMO } from './demo-ids.js';

export { DEMO };

/**
 * Demo data for DEMO_MODE: one workspace, one post published to a simulated X account and a
 * simulated YouTube channel, with a few threaded comments on each. Fixed ids keep curl easy.
 */
export async function seedDemo(
  repos: InMemoryRepositories,
  providers: ProviderRegistry,
  sync: CommentSyncService,
): Promise<void> {
  const twitter = new FakeCommentProvider({
    platform: 'twitter',
    threading: 'nested',
    maxReplyLength: 280,
    ownAccountId: 'x-own',
  });
  const youtube = new FakeCommentProvider({
    platform: 'youtube',
    threading: 'single-level',
    maxReplyLength: 10_000,
    incrementalSync: false,
    ownAccountId: 'yt-own',
  });
  providers.register(twitter).register(youtube);

  repos.posts.add({ id: DEMO.postId, workspaceId: DEMO.workspaceId, status: 'published' });
  repos.accounts.add({
    id: DEMO.twitterAccountId,
    workspaceId: DEMO.workspaceId,
    platform: 'twitter',
    externalAccountId: 'x-own',
    displayName: 'Blotato',
    handle: 'blotato',
    avatarUrl: null,
    status: 'connected',
  });
  repos.accounts.add({
    id: DEMO.youtubeAccountId,
    workspaceId: DEMO.workspaceId,
    platform: 'youtube',
    externalAccountId: 'yt-own',
    displayName: 'Blotato',
    handle: null,
    avatarUrl: null,
    status: 'connected',
  });
  const publishedAt = new Date(Date.now() - 30 * 60_000);
  repos.publications.add({
    id: DEMO.twitterPublicationId,
    postId: DEMO.postId,
    workspaceId: DEMO.workspaceId,
    socialAccountId: DEMO.twitterAccountId,
    platform: 'twitter',
    externalPostId: 'tweet-1',
    permalink: 'https://x.com/blotato/status/1',
    publishedAt,
  });
  repos.publications.add({
    id: DEMO.youtubePublicationId,
    postId: DEMO.postId,
    workspaceId: DEMO.workspaceId,
    socialAccountId: DEMO.youtubeAccountId,
    platform: 'youtube',
    externalPostId: 'video-1',
    permalink: 'https://youtube.com/watch?v=1',
    publishedAt,
  });

  const t1 = twitter.seed('tweet-1', { body: 'Love this launch! 🚀', authorHandle: 'alice' });
  const t2 = twitter.seed('tweet-1', { body: 'Does it support Threads?', authorHandle: 'bob' });
  const t3 = twitter.seed('tweet-1', {
    body: 'Yes, since last week.',
    externalParentId: t2,
    authorExternalId: 'x-own',
    authorHandle: 'blotato',
  });
  twitter.seed('tweet-1', { body: 'Awesome, thanks!', externalParentId: t3, authorHandle: 'bob' });
  twitter.seed('tweet-1', { body: 'Same question here', externalParentId: t2, authorHandle: 'carol' });
  twitter.seed('tweet-1', { body: 'Congrats team', externalParentId: t1, authorHandle: 'dave' });

  const y1 = youtube.seed('video-1', { body: 'Great walkthrough', authorName: 'Eve' });
  youtube.seed('video-1', { body: 'Timestamp for the API part?', authorName: 'Frank' });
  youtube.seed('video-1', { body: '12:40', externalParentId: y1, authorName: 'Grace' });

  // What the publishing pipeline would do right after publishing, then one immediate sync so the
  // demo starts with data instead of waiting for the poller.
  for (const publicationId of [DEMO.twitterPublicationId, DEMO.youtubePublicationId]) {
    await sync.scheduleInitialSync((await repos.publications.findById(publicationId))!);
    await sync.syncPublication(publicationId);
  }
}

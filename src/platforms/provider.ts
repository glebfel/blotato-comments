import type { ExternalComment, Platform } from '../domain/types.js';

export type { ExternalComment };

/**
 * Port that every social platform adapter implements.
 *
 * The contract is deliberately small: the rest of the system only needs to
 * (1) pull comments for an external post and (2) post a reply. Everything
 * platform-specific (auth headers, pagination tokens, nesting rules, field
 * names, error codes) stays inside the adapter.
 */

export interface PlatformCapabilities {
  /**
   * 'nested'       - replies can be attached to any comment (X, Facebook, LinkedIn).
   * 'single-level' - only top-level comments accept replies; a reply to a reply is
   *                  attached to the thread root by the platform (YouTube, Instagram, TikTok).
   */
  threading: 'nested' | 'single-level';
  /** Max length of a reply body in characters. Validated before we call the platform. */
  maxReplyLength: number;
  /** True when fetchComments honours `syncCursor` and returns only newer comments. */
  incrementalSync: boolean;
}

/**
 * What an adapter may authenticate with. An OAuth access token acts as the account (needed to
 * reply); an API key only reads public data (YouTube Data API supports it for comment listing).
 */
export interface AccountCredentials {
  accessToken: string | null;
  apiKey: string | null;
}

export interface FetchCommentsInput {
  credentials: AccountCredentials;
  externalPostId: string;
  /** Within-run pagination token returned by the previous page. */
  pageToken: string | null;
  /** Cross-run incremental cursor persisted by the sync service. */
  syncCursor: string | null;
  /** Max platform HTTP calls the adapter may spend on this page (some pages need sub-requests). */
  requestBudget: number;
}

export interface FetchCommentsResult {
  comments: ExternalComment[];
  nextPageToken: string | null;
  /** New value for the incremental cursor, or null if the provider has none. */
  syncCursor: string | null;
  /** Platform HTTP calls actually made; the sync service budgets runs on this, not on pages. */
  requestsUsed: number;
}

export interface CreateReplyInput {
  credentials: AccountCredentials;
  externalPostId: string;
  /** The comment the user replied to. */
  parentExternalId: string;
  /** Top-level comment of that thread (== parentExternalId when replying to a top-level comment). */
  rootExternalId: string;
  text: string;
}

export interface CreateReplyResult {
  externalId: string;
  /** Where the platform actually attached the reply (may differ from parentExternalId on single-level platforms). */
  externalParentId: string | null;
  permalink: string | null;
  postedAt: Date;
}

export interface CommentProvider {
  readonly platform: Platform;
  readonly capabilities: PlatformCapabilities;
  fetchComments(input: FetchCommentsInput): Promise<FetchCommentsResult>;
  createReply(input: CreateReplyInput): Promise<CreateReplyResult>;
}

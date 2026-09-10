import { DomainError } from './errors.js';
import type { SocialAccount } from './types.js';

/** The one place that decides whether a social account may be used for platform calls. */
export function assertConnected(account: SocialAccount | null, socialAccountId: string): SocialAccount {
  if (!account || account.status !== 'connected') {
    throw new DomainError('account_not_connected', 'The social account that owns this post is not connected', {
      socialAccountId,
      status: account?.status ?? 'missing',
    });
  }
  return account;
}

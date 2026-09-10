import { DomainError } from '../domain/errors.js';
import type { Platform, SocialAccount } from '../domain/types.js';
import type { AccountCredentials } from './provider.js';

/**
 * Resolves usable credentials for a social account.
 *
 * Production implementation: decrypt `social_accounts.credentials_encrypted`, refresh the
 * access token if it is about to expire (per-platform OAuth flow), persist the refreshed
 * token, and mark the account `reauth_required` when refresh fails. That logic belongs to
 * the existing account-connection subsystem, so this module only defines the port plus a
 * trivial implementation used for local runs.
 */
export interface CredentialsProvider {
  getForAccount(account: SocialAccount): Promise<AccountCredentials>;
}

export interface PlatformSecrets {
  accessToken?: string;
  apiKey?: string;
}

export class StaticCredentialsProvider implements CredentialsProvider {
  /**
   * @param secrets  per-platform token / API key (env-provided stand-in for per-account storage)
   * @param fallback token used when a platform has none; only demo mode sets this, so a
   *                 misconfigured production process fails loudly instead of calling X with "demo-token"
   */
  constructor(
    private readonly secrets: Partial<Record<Platform, PlatformSecrets>> = {},
    private readonly fallback: string | null = null,
  ) {}

  async getForAccount(account: SocialAccount): Promise<AccountCredentials> {
    const configured = this.secrets[account.platform] ?? {};
    const credentials: AccountCredentials = {
      accessToken: configured.accessToken ?? this.fallback,
      apiKey: configured.apiKey ?? null,
    };
    if (!credentials.accessToken && !credentials.apiKey) {
      throw new DomainError('account_not_connected', `No credentials configured for ${account.platform}`, {
        socialAccountId: account.id,
        platform: account.platform,
      });
    }
    return credentials;
  }
}

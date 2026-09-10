import { DomainError } from '../domain/errors.js';
import type { Platform } from '../domain/types.js';
import type { CommentProvider } from './provider.js';

export class ProviderRegistry {
  private readonly providers = new Map<Platform, CommentProvider>();

  register(provider: CommentProvider): this {
    this.providers.set(provider.platform, provider);
    return this;
  }

  get(platform: Platform): CommentProvider {
    const provider = this.providers.get(platform);
    if (!provider) {
      throw new DomainError('platform_not_supported', `Comments are not supported for platform "${platform}"`, {
        platform,
      });
    }
    return provider;
  }

  platforms(): Platform[] {
    return [...this.providers.keys()];
  }
}

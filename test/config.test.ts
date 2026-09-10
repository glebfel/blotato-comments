import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/container.js';

describe('loadConfig', () => {
  it('applies defaults and parses numbers', () => {
    const config = loadConfig({ SYNC_POLLER_INTERVAL_MS: '5000', DEMO_MODE: 'true' });
    expect(config.poller.intervalMs).toBe(5000);
    expect(config.sync.maxRequestsPerRun).toBe(20);
    expect(config.apiKeys).toEqual({ demo: '00000000-0000-4000-8000-000000000001' });
    expect(config.storage).toBe('memory');
  });

  it('rejects malformed values instead of booting with NaN', () => {
    expect(() => loadConfig({ SYNC_POLLER_INTERVAL_MS: 'abc' })).toThrow(/SYNC_POLLER_INTERVAL_MS/);
    expect(() => loadConfig({ STORAGE: 'mongo' })).toThrow(/STORAGE/);
  });

  it('parses API keys as key:workspace pairs', () => {
    expect(loadConfig({ API_KEYS: 'a:ws1, b:ws2' }).apiKeys).toEqual({ a: 'ws1', b: 'ws2' });
  });
});

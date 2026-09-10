import { describe, expect, it } from 'vitest';
import { createContainer, loadConfig } from '../src/container.js';
import { DEMO } from '../src/dev/demo-ids.js';

describe('composition root', () => {
  it('boots in demo mode with seeded data and serves the API', async () => {
    const container = await createContainer(
      loadConfig({ DEMO_MODE: 'true', SYNC_POLLER_ENABLED: 'false', LOG_LEVEL: 'silent' }),
    );
    try {
      const health = await container.app.inject({ method: 'GET', url: '/health' });
      expect(health.json()).toEqual({ status: 'ok' });
      const list = await container.app.inject({
        method: 'GET',
        url: `/v1/posts/${DEMO.postId}/comments`,
        headers: { authorization: `Bearer ${DEMO.apiKey}` },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().data.length).toBeGreaterThan(0);
      expect(list.json().meta.publications.map((p: { platform: string }) => p.platform)).toEqual([
        'twitter',
        'youtube',
      ]);
    } finally {
      await container.stop();
    }
  });

  it('refuses to run demo mode on Postgres storage', async () => {
    await expect(
      createContainer(
        loadConfig({ DEMO_MODE: 'true', STORAGE: 'postgres', DATABASE_URL: 'postgres://x', LOG_LEVEL: 'silent' }),
      ),
    ).rejects.toThrow(/DEMO_MODE requires STORAGE=memory/);
  });
});

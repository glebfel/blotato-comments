import { createContainer, loadConfig } from './container.js';

const container = await createContainer(loadConfig());
await container.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void container.stop().finally(() => process.exit(0));
  });
}

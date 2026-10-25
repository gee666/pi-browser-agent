import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BrowserAgentBroker } from '../src/broker/server.ts';
import { TaskStore } from '../src/broker/task-store.ts';

test('broker rejects non-WebSocket HTTP requests and releases keep-alive transports on shutdown',
  { timeout: 5_000 }, async () => {
  await mkdir(new URL('../tmp/', import.meta.url), { recursive: true });
  const dir = await mkdtemp(fileURLToPath(new URL('../tmp/http-shutdown-', import.meta.url)));
  const broker = new BrowserAgentBroker({ port: 0, taskStore: new TaskStore({ dir }) });
  try {
    await broker.start();
    const response = await fetch(`http://127.0.0.1:${broker.port}`);
    assert.equal(response.status, 426);
    assert.equal(await response.text(), 'Upgrade Required');
    await broker.stop();
    const replacement = createServer().listen(broker.port, '127.0.0.1');
    await once(replacement, 'listening');
    await new Promise<void>((resolve) => replacement.close(() => resolve()));
  } finally {
    await broker.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

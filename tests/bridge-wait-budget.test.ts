import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket from 'ws';

// The wait budget is read once at module load, so it has to be shrunk before the
// broker modules are imported. node --test gives every file its own process, so
// this does not leak into the other suites.
process.env.PI_BA_BRIDGE_WAIT_MS = '4000';

const { BrowserAgentBroker, DEFAULT_BRIDGE_WAIT_MS } = await import('../src/broker/server.ts');
const { RemoteBrowserAgentBroker } = await import('../src/broker/remote.ts');
const { TaskStore } = await import('../src/broker/task-store.ts');

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to allocate a free port'));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function connectBridge(port: number, extensionId: string): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once('error', reject);
    socket.once('open', () => socket.send(JSON.stringify({
      v: 1, kind: 'hello', extensionId, version: '0.1.0', capabilities: ['browser_list_tabs'],
    })));
    socket.once('message', () => resolve(socket));
  });
}

test('repeated ensureReady() on a proxy with no bridge stops burning the full wait budget', async () => {
  // Once the primary has seen a bridge, every later tool call used the full
  // budget forever, so a secondary session with Chrome closed stalled for many
  // seconds on every single call.
  assert.equal(DEFAULT_BRIDGE_WAIT_MS, 4_000);

  const port = await getFreePort();
  const primaryRoot = await mkdtemp(join(tmpdir(), 'pi-browser-agent-budget-primary-'));
  const primary = new BrowserAgentBroker({
    host: '127.0.0.1',
    port,
    portRange: 1,
    fallbackToEphemeral: false,
    logger: { info() {}, warn() {}, error() {} },
    taskStore: new TaskStore({ dir: join(primaryRoot, 'tasks') }),
  });
  await primary.start();

  // Chrome connects once and then goes away: bridgeEverConnected stays true, so
  // the proxy keeps believing a bridge might come back.
  const bridge = await connectBridge(port, 'ext-budget');
  bridge.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(primary.probeConnectivity().bridgeConnected, false);

  const root = await mkdtemp(join(tmpdir(), 'pi-browser-agent-budget-'));
  const remote = new RemoteBrowserAgentBroker({
    host: '127.0.0.1',
    port,
    logger: { info() {}, warn() {}, error() {} },
    requestTimeoutMs: 2_000,
    taskStore: new TaskStore({ dir: join(root, 'tasks') }),
  });
  await remote.start();

  const measure = async (): Promise<number> => {
    const started = Date.now();
    await remote.ensureReady();
    return Date.now() - started;
  };

  const first = await measure();
  assert.ok(first >= 3_000, `expected the first call to use the full budget, got ${first}ms`);
  const second = await measure();
  assert.ok(second < DEFAULT_BRIDGE_WAIT_MS + 1_500, `second call overran its budget: ${second}ms`);

  // Two full-budget misses are enough to conclude the browser is simply absent.
  const third = await measure();
  assert.ok(third < 2_500, `expected a short cold budget, got ${third}ms`);

  await remote.stop();
  await primary.stop();
});

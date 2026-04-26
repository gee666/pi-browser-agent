import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket, { WebSocketServer, type RawData } from 'ws';

import { BrowserAgentBroker } from '../src/broker/server.ts';
import { RemoteBrowserAgentBroker } from '../src/broker/remote.ts';
import { TaskStore } from '../src/broker/task-store.ts';

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
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function createBroker(port: number, opts: { portRange?: number; fallbackToEphemeral?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-browser-agent-broker-'));
  return new BrowserAgentBroker({
    host: '127.0.0.1',
    port,
    portRange: opts.portRange ?? 1,
    fallbackToEphemeral: opts.fallbackToEphemeral ?? false,
    logger: { info() {}, warn() {}, error() {} },
    taskStore: new TaskStore({ dir: join(root, 'tasks') }),
  });
}

test('broker probe reports server-only and bridge-connected states', async () => {
  const port = await getFreePort();
  const broker = await createBroker(port);
  await broker.start();

  assert.equal(broker.probeConnectivity().brokerListening, true);
  assert.equal(broker.probeConnectivity().bridgeConnected, false);

  const welcome = await new Promise<any>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once('error', reject);
    socket.once('open', () => {
      socket.send(JSON.stringify({
        v: 1,
        kind: 'hello',
        extensionId: 'ext-1',
        version: '0.1.0',
        capabilities: ['probe'],
      }));
    });
    socket.once('message', (data: RawData) => {
      resolve(JSON.parse(String(data)));
      socket.close();
    });
  });

  assert.equal(welcome.kind, 'welcome');
  assert.equal(broker.probeConnectivity().bridgeConnected, true);
  assert.equal(broker.probeConnectivity().bridgeVersion, '0.1.0');

  await broker.stop();
});

test('remote broker proxies requests through the primary broker bridge', async () => {
  const port = await getFreePort();
  const primary = await createBroker(port);
  await primary.start();

  const bridge = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    bridge.once('error', reject);
    bridge.once('open', () => {
      bridge.send(JSON.stringify({
        v: 1,
        kind: 'hello',
        extensionId: 'ext-remote-proxy-test',
        version: '0.1.0',
        capabilities: ['browser_list_tabs'],
      }));
    });
    bridge.once('message', () => resolve());
  });
  bridge.on('message', (data: RawData) => {
    const frame = JSON.parse(String(data));
    if (frame.kind === 'request') {
      bridge.send(JSON.stringify({
        v: 1,
        kind: 'response',
        id: frame.id,
        ok: true,
        data: { proxied: true, type: frame.type, params: frame.params },
      }));
    }
  });

  const root = await mkdtemp(join(tmpdir(), 'pi-browser-agent-remote-'));
  const remote = new RemoteBrowserAgentBroker({
    host: '127.0.0.1',
    port,
    logger: { info() {}, warn() {}, error() {} },
    taskStore: new TaskStore({ dir: join(root, 'tasks') }),
  });
  await remote.start();

  const probe = remote.probeConnectivity();
  assert.equal(probe.brokerListening, true);
  assert.equal(probe.bridgeConnected, true);
  assert.equal(probe.url, `ws://127.0.0.1:${port}`);

  const response = await remote.request('browser_list_tabs', { activeOnly: false });
  assert.equal(response.ok, true);
  assert.equal(response.data?.proxied, true);
  assert.equal(response.data?.type, 'browser_list_tabs');

  await remote.stop();
  bridge.close();
  await primary.stop();
});

test('remote broker rejects a busy primary port that is not pi-browser-agent', async () => {
  const port = await getFreePort();
  const blocker = new WebSocketServer({ host: '127.0.0.1', port });
  // Accept WebSocket connections but never respond to pi-browser-agent probe
  // frames. This simulates a different websocket app owning the port.
  blocker.on('connection', () => {});
  await new Promise<void>((resolve) => blocker.once('listening', () => resolve()));

  const root = await mkdtemp(join(tmpdir(), 'pi-browser-agent-not-broker-'));
  const remote = new RemoteBrowserAgentBroker({
    host: '127.0.0.1',
    port,
    logger: { info() {}, warn() {}, error() {} },
    requestTimeoutMs: 500,
    taskStore: new TaskStore({ dir: join(root, 'tasks') }),
  });

  await assert.rejects(() => remote.start(), /not a pi-browser-agent broker/i);
  await remote.stop();
  await new Promise<void>((resolve, reject) => blocker.close((error) => (error ? reject(error) : resolve())));
});

test('remote broker rejects an old pi-browser-agent primary without proxy support', async () => {
  const port = await getFreePort();
  const oldPrimary = new WebSocketServer({ host: '127.0.0.1', port });
  oldPrimary.on('connection', (socket) => {
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data));
      if (frame.kind === 'probe') {
        socket.send(JSON.stringify({
          v: 1,
          kind: 'response',
          id: frame.id,
          ok: true,
          data: {
            brokerReachable: true,
            brokerListening: true,
            bridgeConnected: true,
            url: `ws://127.0.0.1:${port}`,
            bridgeSessionSerial: 1,
          },
        }));
      }
    });
  });
  await new Promise<void>((resolve) => oldPrimary.once('listening', () => resolve()));

  const root = await mkdtemp(join(tmpdir(), 'pi-browser-agent-old-primary-'));
  const remote = new RemoteBrowserAgentBroker({
    host: '127.0.0.1',
    port,
    logger: { info() {}, warn() {}, error() {} },
    requestTimeoutMs: 500,
    taskStore: new TaskStore({ dir: join(root, 'tasks') }),
  });

  await assert.rejects(() => remote.start(), /old pi-browser-agent broker/i);
  await remote.stop();
  await new Promise<void>((resolve, reject) => oldPrimary.close((error) => (error ? reject(error) : resolve())));
});

test('remote broker promotes itself when the primary broker exits', async () => {
  const port = await getFreePort();
  const primary = await createBroker(port);
  await primary.start();

  const root = await mkdtemp(join(tmpdir(), 'pi-browser-agent-promote-'));
  const remote = new RemoteBrowserAgentBroker({
    host: '127.0.0.1',
    port,
    logger: { info() {}, warn() {}, error() {} },
    requestTimeoutMs: 2_000,
    taskStore: new TaskStore({ dir: join(root, 'tasks') }),
  });
  await remote.start();
  assert.equal(remote.probeConnectivity().brokerListening, true);

  await primary.stop();

  // Wait until the remote wins the bind race and becomes the new primary.
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 3_000;
    const tick = () => {
      const probe = remote.probeConnectivity();
      if (probe.brokerListening && probe.url === `ws://127.0.0.1:${port}` && probe.bridgeSessionSerial === 0) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`remote did not promote in time: ${JSON.stringify(probe)}`));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });

  // Simulate Chrome reconnecting to the same stable URL (7878 in production).
  const bridge = await new Promise<WebSocket>((resolve, reject) => {
    const deadline = Date.now() + 3_000;
    const tryConnect = () => {
      const candidate = new WebSocket(`ws://127.0.0.1:${port}`);
      let settled = false;
      candidate.once('error', (error) => {
        if (settled) return;
        settled = true;
        try { candidate.terminate(); } catch { /* ignore */ }
        if (Date.now() > deadline) return reject(error);
        setTimeout(tryConnect, 25);
      });
      candidate.once('open', () => {
        if (settled) return;
        settled = true;
        candidate.send(JSON.stringify({
          v: 1,
          kind: 'hello',
          extensionId: 'ext-promote-test',
          version: '0.1.0',
          capabilities: ['browser_list_tabs'],
        }));
      });
      candidate.once('message', () => resolve(candidate));
    };
    tryConnect();
  });
  bridge.on('message', (data: RawData) => {
    const frame = JSON.parse(String(data));
    if (frame.kind === 'request') {
      bridge.send(JSON.stringify({ v: 1, kind: 'response', id: frame.id, ok: true, data: { promoted: true } }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 1_000;
    const tick = () => {
      if (remote.probeConnectivity().bridgeConnected) return resolve();
      if (Date.now() > deadline) return reject(new Error('promoted broker bridge did not connect'));
      setTimeout(tick, 25);
    };
    tick();
  });

  const response = await remote.request('browser_list_tabs', {});
  assert.equal(response.ok, true);
  assert.equal(response.data?.promoted, true);

  bridge.close();
  await remote.stop();
});

test('broker request/response round-trips and bridge disconnect rejects in-flight requests', async () => {
  const port = await getFreePort();
  const broker = await createBroker(port);
  await broker.start();

  const socket = await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('error', reject);
    ws.once('open', () => {
      ws.send(JSON.stringify({ v: 1, kind: 'hello', extensionId: 'ext-2', version: '0.2.0', capabilities: ['request'] }));
    });
    ws.once('message', () => resolve(ws));
  });

  const responsePromise = broker.request('probe_bridge', { ok: true });
  const requestFrame = await new Promise<any>((resolve) => {
    socket.once('message', (data: RawData) => resolve(JSON.parse(String(data))));
  });
  assert.equal(requestFrame.kind, 'request');
  socket.send(JSON.stringify({ v: 1, kind: 'response', id: requestFrame.id, ok: true, data: { echoed: true } }));

  const response = await responsePromise;
  assert.equal(response.ok, true);
  assert.deepEqual(response.data, { echoed: true });

  const rejected = broker.request('will_disconnect', {});
  const secondRequest = await new Promise<any>((resolve) => {
    socket.once('message', (data: RawData) => resolve(JSON.parse(String(data))));
  });
  assert.equal(secondRequest.kind, 'request');
  socket.close();
  await assert.rejects(rejected, /E_BRIDGE_DISCONNECTED/);

  await broker.stop();
});

test('new connection without hello does not evict the active bridge', async () => {
  const port = await getFreePort();
  const broker = await createBroker(port);
  await broker.start();

  // Connect and authenticate as the first bridge.
  const first = await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('error', reject);
    ws.once('open', () => {
      ws.send(JSON.stringify({ v: 1, kind: 'hello', extensionId: 'ext-first', version: '1.0.0', capabilities: [] }));
    });
    ws.once('message', () => resolve(ws));
  });
  assert.equal(broker.probeConnectivity().bridgeConnected, true);
  const serialBefore = broker.probeConnectivity().bridgeSessionSerial;

  // Open a second socket but never send hello. It must NOT evict the active bridge.
  const second = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    second.once('error', reject);
    second.once('open', () => resolve());
  });

  // Allow any stray handlers to run.
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(broker.probeConnectivity().bridgeConnected, true);
  assert.equal(broker.probeConnectivity().bridgeSessionSerial, serialBefore);

  // The original bridge must still be usable.
  const responsePromise = broker.request('probe_bridge', {}, { timeoutMs: 2_000 });
  const reqFrame = await new Promise<any>((resolve) => first.once('message', (data: RawData) => resolve(JSON.parse(String(data)))));
  assert.equal(reqFrame.kind, 'request');
  first.send(JSON.stringify({ v: 1, kind: 'response', id: reqFrame.id, ok: true, data: { echoed: true } }));
  const response = await responsePromise;
  assert.equal(response.ok, true);

  second.close();
  first.close();
  await broker.stop();
});

test('bridge handoff keeps the old bridge active until the new hello is received, then closes the old socket', async () => {
  const port = await getFreePort();
  const broker = await createBroker(port);
  await broker.start();

  const first = await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('error', reject);
    ws.once('open', () => {
      ws.send(JSON.stringify({ v: 1, kind: 'hello', extensionId: 'ext-first', version: '1.0.0', capabilities: [] }));
    });
    ws.once('message', () => resolve(ws));
  });
  const serialBefore = broker.probeConnectivity().bridgeSessionSerial;

  // Connect a second socket. Before it sends hello the first must still be active.
  const second = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    second.once('error', reject);
    second.once('open', () => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(broker.probeConnectivity().bridgeConnected, true);

  // Now the second sends hello. It should promote and the first should be closed by the broker.
  const firstClosed = new Promise<number>((resolve) => first.once('close', (code: number) => resolve(code)));
  await new Promise<void>((resolve) => {
    second.once('message', () => resolve());
    second.send(JSON.stringify({ v: 1, kind: 'hello', extensionId: 'ext-second', version: '1.0.1', capabilities: [] }));
  });
  const closeCode = await firstClosed;
  assert.equal(closeCode, 1012);
  const serialAfter = broker.probeConnectivity().bridgeSessionSerial ?? 0;
  assert.ok(serialAfter > (serialBefore ?? 0));

  second.close();
  await broker.stop();
});

test('request rejects immediately with E_BRIDGE_DISCONNECTED if the bridge was evicted between validation and send', async () => {
  const port = await getFreePort();
  const broker = await createBroker(port);
  await broker.start();

  // Connect a bridge.
  const socket = await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('error', reject);
    ws.once('open', () => {
      ws.send(JSON.stringify({ v: 1, kind: 'hello', extensionId: 'ext-r', version: '1.0.0', capabilities: [] }));
    });
    ws.once('message', () => resolve(ws));
  });

  // Close the socket and wait for broker to observe the close.
  socket.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(broker.probeConnectivity().bridgeConnected, false);

  // Now a request must reject immediately, not wait for timeout.
  const start = Date.now();
  await assert.rejects(() => broker.request('probe_bridge', {}, { timeoutMs: 5_000 }), /E_BRIDGE_DISCONNECTED/);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1_000, `expected fast reject, got ${elapsed}ms`);

  await broker.stop();
});

test('broker throws on startup failure and does not publish a non-listening server (range=1, no ephemeral)', async () => {
  const port = await getFreePort();
  const blocker = net.createServer();
  await new Promise<void>((resolve, reject) => blocker.listen(port, '127.0.0.1', () => resolve()).once('error', reject));

  const broker = await createBroker(port, { portRange: 1, fallbackToEphemeral: false });
  await assert.rejects(() => broker.start(), /EADDRINUSE|address already in use/i);

  const probe = broker.probeConnectivity();
  assert.equal(probe.brokerReachable, false);
  assert.equal(probe.brokerListening, false);
  assert.match(probe.startupError || '', /EADDRINUSE|address already in use/i);

  await broker.stop();
  await new Promise<void>((resolve, reject) => blocker.close((error) => (error ? reject(error) : resolve())));
});

test('broker walks port range past a busy preferred port and publishes the actual bound port', async () => {
  const preferred = await getFreePort();
  const blocker = net.createServer();
  await new Promise<void>((resolve, reject) => blocker.listen(preferred, '127.0.0.1', () => resolve()).once('error', reject));

  const broker = await createBroker(preferred, { portRange: 5, fallbackToEphemeral: false });
  await broker.start();

  assert.equal(broker.probeConnectivity().brokerListening, true);
  assert.notEqual(broker.port, preferred);
  assert.ok(broker.port > preferred && broker.port <= preferred + 4, `expected port within range, got ${broker.port}`);
  assert.equal(broker.url, `ws://127.0.0.1:${broker.port}`);

  await broker.stop();
  await new Promise<void>((resolve, reject) => blocker.close((error) => (error ? reject(error) : resolve())));
});

test('two brokers can run concurrently with default port range without EADDRINUSE', async () => {
  // This is the regression test for the multi-instance hard requirement:
  // starting a second broker while the first holds the preferred port must
  // succeed on a different port instead of throwing.
  const preferred = await getFreePort();

  const brokerA = await createBroker(preferred, { portRange: 10, fallbackToEphemeral: true });
  await brokerA.start();

  const brokerB = await createBroker(preferred, { portRange: 10, fallbackToEphemeral: true });
  await brokerB.start();

  assert.equal(brokerA.probeConnectivity().brokerListening, true);
  assert.equal(brokerB.probeConnectivity().brokerListening, true);
  assert.notEqual(brokerA.port, brokerB.port);

  await brokerA.stop();
  await brokerB.stop();
});

test('broker falls back to an ephemeral port when the entire range is busy', async () => {
  const preferred = await getFreePort();
  const blocker = net.createServer();
  await new Promise<void>((resolve, reject) => blocker.listen(preferred, '127.0.0.1', () => resolve()).once('error', reject));

  // portRange=1 means only `preferred` itself is tried before fallback.
  const broker = await createBroker(preferred, { portRange: 1, fallbackToEphemeral: true });
  await broker.start();

  assert.equal(broker.probeConnectivity().brokerListening, true);
  assert.notEqual(broker.port, preferred);
  assert.ok(broker.port > 0);

  await broker.stop();
  await new Promise<void>((resolve, reject) => blocker.close((error) => (error ? reject(error) : resolve())));
});

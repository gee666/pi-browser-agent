import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket, { WebSocketServer, type RawData } from 'ws';

import { BrowserAgentBroker } from '../src/broker/server.ts';
import { RemoteBrowserAgentBroker } from '../src/broker/remote.ts';
import { LazyBrokerHandle } from '../src/broker/lazy.ts';
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

/**
 * A plain TCP server used to squat a port.
 *
 * It MUST destroy the connections it accepts on close: a `ws` client aborted
 * while still in CONNECTING does not FIN the peer, so an accepting-but-silent
 * server keeps the accepted socket (and the whole test process) alive forever.
 */
async function startPortBlocker(port: number): Promise<{ close: () => Promise<void> }> {
  const accepted: net.Socket[] = [];
  const server = net.createServer((socket) => {
    accepted.push(socket);
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve()).once('error', reject);
  });
  return {
    close: async () => {
      for (const socket of accepted) {
        try { socket.destroy(); } catch { /* ignore */ }
      }
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
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

test('concurrent start() calls share one listener lifecycle', async () => {
  const port = await getFreePort();
  const broker = await createBroker(port);

  await Promise.all(Array.from({ length: 12 }, () => broker.start()));

  assert.equal(broker.probeConnectivity().brokerListening, true);
  assert.equal(broker.port, port);
  await broker.stop();
});

test('stop() racing an in-flight start() tears down the late listener', async () => {
  const port = await getFreePort();
  const broker = await createBroker(port);
  let releaseInit!: () => void;
  let initEntered!: () => void;
  const entered = new Promise<void>((resolve) => { initEntered = resolve; });
  const release = new Promise<void>((resolve) => { releaseInit = resolve; });
  const originalInit = broker.taskStore.init.bind(broker.taskStore);
  (broker.taskStore as any).init = async () => {
    initEntered();
    await release;
    await originalInit();
  };

  const starting = broker.start();
  await entered;
  const stopping = broker.stop();
  releaseInit();
  await Promise.all([starting, stopping]);

  assert.equal(broker.probeConnectivity().brokerListening, false);
  const successor = await createBroker(port);
  await successor.start();
  await successor.stop();
});

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
  assert.deepEqual(response.data, {
    proxied: true,
    type: 'browser_list_tabs',
    params: { activeOnly: false },
  });

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
  await blocker.close();
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
  assert.deepEqual(response.data, { promoted: true });

  bridge.close();
  await remote.stop();
});

test('remote broker ensureReady() lazily promotes when the primary is gone', async () => {
  const port = await getFreePort();
  const primary = await createBroker(port);
  await primary.start();

  const root = await mkdtemp(join(tmpdir(), 'pi-browser-agent-ensure-'));
  const remote = new RemoteBrowserAgentBroker({
    host: '127.0.0.1',
    port,
    logger: { info() {}, warn() {}, error() {} },
    requestTimeoutMs: 2_000,
    taskStore: new TaskStore({ dir: join(root, 'tasks') }),
  });
  await remote.start();
  assert.equal(remote.probeConnectivity().brokerListening, true);

  // Primary process dies. No tool request or close handler has run yet from the
  // caller's perspective — the next browser tool call drives recovery.
  await primary.stop();

  // ensureReady() awaits the reconnect-or-promote decision, so once it resolves
  // the remote must own the port (it competed and won the bind race).
  await remote.ensureReady();

  const probe = remote.probeConnectivity();
  assert.equal(probe.brokerListening, true);
  assert.equal(probe.url, `ws://127.0.0.1:${port}`);

  // A fresh hard broker must not be able to bind the same port: single owner.
  const intruder = await createBroker(port);
  await assert.rejects(() => intruder.start(), /EADDRINUSE|address already in use/i);

  await remote.stop();
});

test('with many secondaries, exactly one promotes when the primary stops and all keep working', async () => {
  const port = await getFreePort();
  const primary = await createBroker(port);
  await primary.start();

  // Original Chrome bridge attached to the primary.
  const firstBridge = await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once('error', reject);
    socket.once('open', () => socket.send(JSON.stringify({
      v: 1, kind: 'hello', extensionId: 'ext-orig', version: '0.1.0', capabilities: ['browser_list_tabs'],
    })));
    socket.once('message', () => resolve(socket));
  });

  // 9 secondary pi processes, all proxying through the primary.
  const REMOTES = 9;
  const remotes: RemoteBrowserAgentBroker[] = [];
  for (let i = 0; i < REMOTES; i += 1) {
    const root = await mkdtemp(join(tmpdir(), `pi-browser-agent-elect-${i}-`));
    const remote = new RemoteBrowserAgentBroker({
      host: '127.0.0.1',
      port,
      logger: { info() {}, warn() {}, error() {} },
      requestTimeoutMs: 2_000,
      taskStore: new TaskStore({ dir: join(root, 'tasks') }),
    });
    await remote.start();
    assert.equal(remote.probeConnectivity().brokerListening, true);
    remotes.push(remote);
  }

  // Primary is Ctrl+Z'd -> graceful stop releases the port + closes the bridge.
  firstBridge.close();
  await primary.stop();

  // The 9 secondaries race to bind; exactly one wins (the OS makes bind
  // exclusive). Wait until the port is listening again.
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 4_000;
    const tick = () => {
      if (remotes.some((r) => r.probeConnectivity().url === `ws://127.0.0.1:${port}`
          && r.probeConnectivity().brokerListening)) return resolve();
      if (Date.now() > deadline) return reject(new Error('no secondary promoted in time'));
      setTimeout(tick, 25);
    };
    tick();
  });

  // Prove single ownership: a fresh hard broker cannot bind the same port.
  const intruder = await createBroker(port);
  await assert.rejects(() => intruder.start(), /EADDRINUSE|address already in use/i);

  // Chrome reconnects to the same stable URL; it lands on the new primary.
  const bridge = await new Promise<WebSocket>((resolve, reject) => {
    const deadline = Date.now() + 4_000;
    const tryConnect = () => {
      const candidate = new WebSocket(`ws://127.0.0.1:${port}`);
      let settled = false;
      candidate.once('error', () => {
        if (settled) return; settled = true;
        try { candidate.terminate(); } catch { /* ignore */ }
        if (Date.now() > deadline) return reject(new Error('bridge could not reconnect'));
        setTimeout(tryConnect, 25);
      });
      candidate.once('open', () => {
        if (settled) return; settled = true;
        candidate.send(JSON.stringify({
          v: 1, kind: 'hello', extensionId: 'ext-new', version: '0.1.0', capabilities: ['browser_list_tabs'],
        }));
      });
      candidate.once('message', () => resolve(candidate));
    };
    tryConnect();
  });
  bridge.on('message', (data: RawData) => {
    const frame = JSON.parse(String(data));
    if (frame.kind === 'request') {
      bridge.send(JSON.stringify({ v: 1, kind: 'response', id: frame.id, ok: true, data: { served: true } }));
    }
  });

  // Every one of the 9 secondaries can still drive the browser: the promoted
  // one talks to the bridge directly, the other 8 proxy through it.
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 2_000;
    const tick = () => {
      if (remotes.every((r) => r.probeConnectivity().brokerListening)) return resolve();
      if (Date.now() > deadline) return reject(new Error('not all secondaries recovered'));
      setTimeout(tick, 25);
    };
    tick();
  });
  const results = await Promise.all(remotes.map((r) => r.request('browser_list_tabs', {})));
  for (const response of results) {
    assert.equal(response.ok, true);
    assert.deepEqual(response.data, { served: true });
  }

  bridge.close();
  await Promise.all(remotes.map((r) => r.stop()));
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
  const blocker = await startPortBlocker(port);

  const broker = await createBroker(port, { portRange: 1, fallbackToEphemeral: false });
  await assert.rejects(() => broker.start(), /EADDRINUSE|address already in use/i);

  const probe = broker.probeConnectivity();
  assert.equal(probe.brokerReachable, false);
  assert.equal(probe.brokerListening, false);
  assert.match(probe.startupError || '', /EADDRINUSE|address already in use/i);

  await broker.stop();
  await blocker.close();
});

test('broker walks port range past a busy preferred port and publishes the actual bound port', async () => {
  const preferred = await getFreePort();
  const blocker = await startPortBlocker(preferred);

  const broker = await createBroker(preferred, { portRange: 5, fallbackToEphemeral: false });
  await broker.start();

  assert.equal(broker.probeConnectivity().brokerListening, true);
  assert.notEqual(broker.port, preferred);
  assert.ok(broker.port > preferred && broker.port <= preferred + 4, `expected port within range, got ${broker.port}`);
  assert.equal(broker.url, `ws://127.0.0.1:${broker.port}`);

  await broker.stop();
  await blocker.close();
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
  const blocker = await startPortBlocker(preferred);

  // portRange=1 means only `preferred` itself is tried before fallback.
  const broker = await createBroker(preferred, { portRange: 1, fallbackToEphemeral: true });
  await broker.start();

  assert.equal(broker.probeConnectivity().brokerListening, true);
  assert.notEqual(broker.port, preferred);
  assert.ok(broker.port > 0);

  await broker.stop();
  await blocker.close();
});

// ─── Self-healing / diagnostics regressions ─────────────────────────────────
// These cover the failure that left long-lived pi instances permanently unable
// to reach a running Chrome: nothing re-established the bridge, and the error
// the agent saw was a bare "connection is down".

test('ensureReady() waits out an in-flight bridge reconnect instead of failing', async () => {
  const port = await getFreePort();
  const broker = await createBroker(port);
  await broker.start();

  // First bridge connects, then drops — mirroring a service-worker teardown.
  const first = await connectBridge(port, 'ext-flap-1');
  await waitFor(() => broker.probeConnectivity().bridgeConnected, 1_000, 'first bridge connect');
  first.close();
  await waitFor(() => !broker.probeConnectivity().bridgeConnected, 1_000, 'first bridge drop');

  const probeAfterDrop = broker.probeConnectivity();
  assert.equal(probeAfterDrop.bridgeEverConnected, true);
  assert.ok(probeAfterDrop.lastBridgeDisconnectedAt);
  assert.match(String(probeAfterDrop.lastBridgeDisconnectReason), /closed|error/i);

  // The extension reconnects 200ms later. ensureReady() must absorb that window.
  const late: { second?: WebSocket } = {};
  setTimeout(() => { void connectBridge(port, 'ext-flap-2').then((socket) => { late.second = socket; }); }, 200);

  await broker.ensureReady({ waitForBridgeMs: 3_000 });
  assert.equal(broker.probeConnectivity().bridgeConnected, true);

  late.second?.close();
  await broker.stop();
});

test('ensureReady() rebinds a listener that was closed underneath the broker', async () => {
  const port = await getFreePort();
  const broker = await createBroker(port);
  await broker.start();
  assert.equal(broker.probeConnectivity().brokerListening, true);

  await broker.stop();
  assert.equal(broker.probeConnectivity().brokerListening, false);

  // A later tool call must transparently re-acquire the port.
  await broker.ensureReady({ waitForBridgeMs: 0 });
  assert.equal(broker.probeConnectivity().brokerListening, true);
  assert.equal(broker.port, port);

  await broker.stop();
});

test('bridge state transitions are reported so the user is told what happened', async () => {
  const port = await getFreePort();
  const broker = await createBroker(port);
  const events: boolean[] = [];
  broker.addBridgeStateListener(({ connected }) => { events.push(connected); });
  await broker.start();

  const bridge = await connectBridge(port, 'ext-report');
  await waitFor(() => broker.probeConnectivity().bridgeConnected, 1_000, 'bridge connect');
  bridge.close();
  await waitFor(() => !broker.probeConnectivity().bridgeConnected, 1_000, 'bridge drop');

  assert.deepEqual(events, [true, false]);
  await broker.stop();
});

test('a secondary heals itself in the background when the primary dies, with no tool call', async () => {
  const port = await getFreePort();
  const primary = await createBroker(port);
  await primary.start();

  const root = await mkdtemp(join(tmpdir(), 'pi-browser-agent-bgheal-'));
  const remote = new RemoteBrowserAgentBroker({
    host: '127.0.0.1',
    port,
    logger: { info() {}, warn() {}, error() {} },
    requestTimeoutMs: 2_000,
    taskStore: new TaskStore({ dir: join(root, 'tasks') }),
  });
  await remote.start();

  // Primary vanishes. Nobody calls a browser tool. The secondary must still take
  // over the port promptly so the Chrome extension has something to reconnect to.
  await primary.stop();
  await waitFor(() => remote.probeConnectivity().role === 'promoted', 5_000, 'background promotion');
  assert.equal(remote.probeConnectivity().brokerListening, true);

  await remote.stop();
});

for (const failure of ['invalid', 'silent'] as const) {
  test(`background recovery closes connections with ${failure} probes and keeps retrying`, async () => {
    const port = await getFreePort();
    const server = new WebSocketServer({ host: '127.0.0.1', port });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    let valid = true;
    let failedProbes = 0;
    server.on('connection', (socket) => {
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.kind !== 'probe') return;
        if (!valid) {
          failedProbes += 1;
          if (failure === 'silent') return;
        }
        socket.send(JSON.stringify({
          v: 1, kind: 'response', id: frame.id, ok: true,
          data: valid ? {
            brokerReachable: true, brokerListening: true, bridgeConnected: true,
            supportsBrokerProxy: true, bridgeSessionSerial: 1,
          } : { notABroker: true },
        }));
      });
    });
    const tmp = join(process.cwd(), 'tmp');
    await mkdir(tmp, { recursive: true });
    const root = await mkdtemp(join(tmp, 'broker-invalid-probe-'));
    const remote = new RemoteBrowserAgentBroker({
      host: '127.0.0.1', port,
      logger: { info() {}, warn() {}, error() {} },
      requestTimeoutMs: 100,
      taskStore: new TaskStore({ dir: join(root, 'tasks') }),
    });
    try {
      await remote.start();
      assert.equal(remote.probeConnectivity().bridgeConnected, true);
      valid = false;
      for (const socket of server.clients) socket.terminate();

      await waitFor(() => failedProbes >= 1 && server.clients.size === 0, 2_000, 'failed connection cleanup');
      assert.equal(remote.probeConnectivity().brokerListening, false);
      assert.equal(remote.probeConnectivity().bridgeConnected, false);
      await waitFor(() => failedProbes >= 2 && server.clients.size === 0, 3_000, 'background retry cleanup');

      // No foreground call should be needed once a valid primary is available.
      valid = true;
      await waitFor(() => remote.probeConnectivity().bridgeConnected, 4_000, 'validated reconnect');
      assert.equal(remote.probeConnectivity().role, 'proxy');
      assert.equal(remote.probeConnectivity().startupError, undefined);
    } finally {
      await remote.stop();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('a proxy secondary never claims a live bridge once its socket to the primary is gone', async () => {
  const port = await getFreePort();
  const primary = await createBroker(port);
  await primary.start();
  const bridge = await connectBridge(port, 'ext-proxy');

  const root = await mkdtemp(join(tmpdir(), 'pi-browser-agent-stale-'));
  const remote = new RemoteBrowserAgentBroker({
    host: '127.0.0.1',
    port,
    logger: { info() {}, warn() {}, error() {} },
    requestTimeoutMs: 2_000,
    taskStore: new TaskStore({ dir: join(root, 'tasks') }),
  });
  await remote.start();
  await remote.ensureReady({ waitForBridgeMs: 1_000 });
  assert.equal(remote.probeConnectivity().bridgeConnected, true);

  // Kill the proxy socket without refreshing the cached snapshot.
  (remote as any).socket?.terminate();
  (remote as any).socket = null;
  assert.equal(remote.probeConnectivity().bridgeConnected, false);

  bridge.close();
  await remote.stop();
  await primary.stop();
});

test('ensureReady() rebind leaves exactly one heartbeat interval running', async () => {
  // Two live heartbeats flap the bridge forever: interval A clears isAlive and
  // pings, interval B fires before the pong lands, sees isAlive===false and
  // terminates a perfectly healthy bridge. The existing rebind test goes through
  // stop(), which clears the timer and hides the leak, so this one closes the
  // listener underneath the broker instead.
  const port = await getFreePort();
  const broker = await createBroker(port);

  const heartbeats: Array<{ fn: () => void; timer: unknown; cleared: boolean }> = [];
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  (globalThis as any).setInterval = (fn: any, ms?: number, ...rest: any[]) => {
    const timer = realSetInterval(fn, ms as number, ...rest);
    if (ms === 25_000) heartbeats.push({ fn, timer, cleared: false });
    return timer;
  };
  (globalThis as any).clearInterval = (timer: any) => {
    for (const entry of heartbeats) {
      if (entry.timer === timer) entry.cleared = true;
    }
    return realClearInterval(timer);
  };

  let bridge: WebSocket | undefined;
  try {
    await broker.start();
    const listener = (broker as any).server;
    await new Promise<void>((resolve) => listener.close(() => resolve()));

    await broker.ensureReady({ waitForBridgeMs: 0 });
    assert.equal(broker.probeConnectivity().brokerListening, true);
    assert.equal(heartbeats.length, 2, 'rebind should create a fresh heartbeat');
    assert.equal(heartbeats.filter((entry) => !entry.cleared).length, 1, 'only one heartbeat may survive');

    bridge = await connectBridge(port, 'ext-heartbeat');
    await waitFor(() => broker.probeConnectivity().bridgeConnected, 1_000, 'bridge connect after rebind');

    // Drive every heartbeat callback that was ever created, several rounds over,
    // allowing the pong to land between rounds. A leaked interval would kill the
    // bridge inside the very first round.
    for (let round = 0; round < 3; round += 1) {
      for (const entry of heartbeats) entry.fn();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(broker.probeConnectivity().bridgeConnected, true);
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    bridge?.close();
    await broker.stop();
  }
});

test('remote stop() rejects a pending proxy request and does not reconnect', async () => {
  const port = await getFreePort();
  const primary = await createBroker(port);
  await primary.start();
  const bridge = await connectBridge(port, 'ext-stop-proxy');

  const root = await mkdtemp(join(tmpdir(), 'pi-browser-agent-stop-proxy-'));
  const remote = new RemoteBrowserAgentBroker({
    host: '127.0.0.1',
    port,
    logger: { info() {}, warn() {}, error() {} },
    requestTimeoutMs: 2_000,
    taskStore: new TaskStore({ dir: join(root, 'tasks') }),
  });

  try {
    await remote.start();
    const received = new Promise<void>((resolve) => bridge.once('message', () => resolve()));
    const rejected = assert.rejects(
      remote.request('browser_list_tabs', {}),
      /E_BRIDGE_DISCONNECTED/,
    );
    await received;
    await remote.stop();
    await rejected;

    await remote.ensureReady({ waitForBridgeMs: 0 });
    assert.equal(remote.probeConnectivity().brokerListening, false);
    assert.equal(remote.probeConnectivity().bridgeConnected, false);
    await assert.rejects(() => remote.request('browser_list_tabs', {}), /E_BRIDGE_DISCONNECTED/);
    assert.equal(primary.probeConnectivity().brokerListening, true);
  } finally {
    bridge.close();
    await remote.stop();
    await primary.stop();
  }
});

test('remote stop() awaits an in-flight promotion and prevents a late bind', async () => {
  const port = await getFreePort();
  const primary = await createBroker(port);
  await primary.start();

  const root = await mkdtemp(join(tmpdir(), 'pi-browser-agent-stop-promotion-'));
  const remote = new RemoteBrowserAgentBroker({
    host: '127.0.0.1',
    port,
    logger: { info() {}, warn() {}, error() {} },
    requestTimeoutMs: 2_000,
    taskStore: new TaskStore({ dir: join(root, 'tasks') }),
  });
  await remote.start();
  await primary.stop();

  let initEntered!: () => void;
  let releaseInit!: () => void;
  const entered = new Promise<void>((resolve) => { initEntered = resolve; });
  const release = new Promise<void>((resolve) => { releaseInit = resolve; });
  const originalInit = remote.taskStore.init.bind(remote.taskStore);
  (remote.taskStore as any).init = async () => {
    initEntered();
    await release;
    await originalInit();
  };

  const promotion = (remote as any).promoteOrReconnect() as Promise<BrowserAgentBroker | null>;
  await entered;
  const stopping = remote.stop();
  releaseInit();
  await Promise.all([promotion, stopping]);

  assert.equal(remote.probeConnectivity().brokerListening, false);
  const successor = await createBroker(port);
  await successor.start();
  await successor.stop();
});

test('an operation resuming after remote stop() cannot start a new promotion', async () => {
  const port = await getFreePort();
  const primary = await createBroker(port);
  await primary.start();

  const root = await mkdtemp(join(tmpdir(), 'pi-browser-agent-late-promotion-'));
  const remote = new RemoteBrowserAgentBroker({
    host: '127.0.0.1',
    port,
    logger: { info() {}, warn() {}, error() {} },
    requestTimeoutMs: 2_000,
    taskStore: new TaskStore({ dir: join(root, 'tasks') }),
  });
  await remote.start();

  let probeEntered!: () => void;
  let releaseProbe!: () => void;
  const entered = new Promise<void>((resolve) => { probeEntered = resolve; });
  const release = new Promise<void>((resolve) => { releaseProbe = resolve; });
  const originalProbe = (remote as any).probePrimary.bind(remote);
  (remote as any).probePrimary = async () => {
    probeEntered();
    await release;
    return await originalProbe();
  };

  const ensuring = remote.ensureReady({ waitForBridgeMs: 0 });
  await entered;
  await remote.stop();
  await primary.stop();
  releaseProbe();
  await ensuring;

  const successor = await createBroker(port);
  await successor.start();
  await successor.stop();
});

test('a remote broker restarted after stop() resumes background healing', async () => {
  // Ctrl+Z stops the broker and SIGCONT start()s the same instance. If stop()'s
  // `stopped` flag is never cleared, every heal path is dead for the rest of the
  // process's life and the session silently loses all recovery.
  const port = await getFreePort();
  const primary = await createBroker(port);
  await primary.start();

  const root = await mkdtemp(join(tmpdir(), 'pi-browser-agent-resume-'));
  const remote = new RemoteBrowserAgentBroker({
    host: '127.0.0.1',
    port,
    logger: { info() {}, warn() {}, error() {} },
    requestTimeoutMs: 2_000,
    taskStore: new TaskStore({ dir: join(root, 'tasks') }),
  });
  await remote.start();

  await remote.stop();
  await remote.start();
  assert.equal(remote.probeConnectivity().brokerListening, true);

  await primary.stop();
  await waitFor(() => remote.probeConnectivity().role === 'promoted', 5_000, 'background promotion after resume');

  await remote.stop();
});

test('a lazy handle keeps its proxy across a not-listening window and stays the only port owner', async () => {
  // Dropping the proxy here orphaned a broker that kept its heal loop and could
  // still bind the port, so one process ended up with two competing brokers.
  const port = await getFreePort();
  const blocker = await startPortBlocker(port);

  const root = await mkdtemp(join(tmpdir(), 'pi-browser-agent-lazyproxy-'));
  const remote = new RemoteBrowserAgentBroker({
    host: '127.0.0.1',
    port,
    logger: { info() {}, warn() {}, error() {} },
    requestTimeoutMs: 500,
    taskStore: new TaskStore({ dir: join(root, 'tasks') }),
  });
  await assert.rejects(() => remote.start(), /not a pi-browser-agent broker/i);

  const handle = new LazyBrokerHandle(
    async () => remote as any,
    new TaskStore({ dir: join(root, 'handle-tasks') }),
    `ws://127.0.0.1:${port}`,
  );
  handle.adopt(remote as any);

  await handle.ensureReady({ waitForBridgeMs: 0 });
  assert.equal(handle.probeConnectivity().brokerListening, false);
  assert.equal(handle.resolved, remote, 'a proxy must survive a not-listening window');

  // Port frees up: the SAME object heals itself into the new primary.
  await blocker.close();
  await handle.ensureReady({ waitForBridgeMs: 0 });
  await waitFor(() => remote.probeConnectivity().role === 'promoted', 5_000, 'self-promotion');
  assert.equal(handle.resolved, remote);

  // ...and it is the only owner of the port.
  const intruder = await createBroker(port);
  await assert.rejects(() => intruder.start(), /EADDRINUSE|address already in use/i);

  await remote.stop();
});

test('a disposed lazy handle never re-binds the port after session shutdown', async () => {
  const port = await getFreePort();
  const broker = await createBroker(port);
  await broker.start();

  const root = await mkdtemp(join(tmpdir(), 'pi-browser-agent-dispose-'));
  const handle = new LazyBrokerHandle(
    async () => broker as any,
    new TaskStore({ dir: join(root, 'tasks') }),
    `ws://127.0.0.1:${port}`,
  );
  handle.adopt(broker as any);

  // session_shutdown: stop the broker, then disarm the handle the tools still hold.
  await broker.stop();
  handle.dispose();

  await handle.ensureReady({ waitForBridgeMs: 0 });
  await assert.rejects(() => handle.request('browser_list_tabs', {}), /E_BRIDGE_DISCONNECTED/);
  const probe = handle.probeConnectivity();
  assert.equal(probe.brokerListening, false);
  assert.match(String(probe.startupError), /shut down with this pi session/i);

  // Nothing was resurrected behind our back: a fresh broker still gets the port.
  const successor = await createBroker(port);
  await successor.start();
  assert.equal(successor.probeConnectivity().brokerListening, true);
  await successor.stop();
});

test('a proxy is told when the primary loses its Chrome bridge, without polling', async () => {
  const port = await getFreePort();
  const primary = await createBroker(port);
  await primary.start();
  const bridge = await connectBridge(port, 'ext-notify');

  const root = await mkdtemp(join(tmpdir(), 'pi-browser-agent-notify-'));
  const remote = new RemoteBrowserAgentBroker({
    host: '127.0.0.1',
    port,
    logger: { info() {}, warn() {}, error() {} },
    requestTimeoutMs: 2_000,
    taskStore: new TaskStore({ dir: join(root, 'tasks') }),
  });
  await remote.start();
  await remote.ensureReady({ waitForBridgeMs: 1_000 });
  assert.equal(remote.probeConnectivity().bridgeConnected, true);

  const events: boolean[] = [];
  remote.addBridgeStateListener(({ connected }) => { events.push(connected); });

  bridge.close();
  await waitFor(() => events.includes(false), 2_000, 'pushed bridge_state notification');
  assert.equal(remote.probeConnectivity().bridgeConnected, false);

  await remote.stop();
  await primary.stop();
});

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

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

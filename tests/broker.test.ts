import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket, { type RawData } from 'ws';

import { BrowserAgentBroker } from '../src/broker/server.ts';
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

async function createBroker(port: number) {
  const root = await mkdtemp(join(tmpdir(), 'pi-browser-agent-broker-'));
  return new BrowserAgentBroker({
    host: '127.0.0.1',
    port,
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

test('broker surfaces startup failure without throwing', async () => {
  const port = await getFreePort();
  const blocker = net.createServer();
  await new Promise<void>((resolve, reject) => blocker.listen(port, '127.0.0.1', () => resolve()).once('error', reject));

  const broker = await createBroker(port);
  await broker.start();

  const probe = broker.probeConnectivity();
  assert.equal(probe.brokerReachable, false);
  assert.equal(probe.brokerListening, false);
  assert.match(probe.startupError || '', /EADDRINUSE|address already in use/i);

  await broker.stop();
  await new Promise<void>((resolve, reject) => blocker.close((error) => (error ? reject(error) : resolve())));
});

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { RemoteBrowserAgentBroker } from '../src/broker/remote.ts';
import { BrowserAgentBroker } from '../src/broker/server.ts';
import { TaskStore } from '../src/broker/task-store.ts';

for (const failure of ['handshake rejection', 'connection timeout']) {
  test(`a proxy handles repeated socket errors after ${failure} and can reconnect`, { timeout: 10_000 }, async (t) => {
    await mkdir(join(process.cwd(), 'tmp'), { recursive: true });
    const root = await mkdtemp(join(process.cwd(), 'tmp', 'proxy-errors-'));
    const server = createServer((_request, response) => {
      if (failure === 'handshake rejection') {
        response.writeHead(503);
        response.end();
      }
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const options = { host: '127.0.0.1', port: address.port, logger: { info() {}, warn() {}, error() {} } };
    const remote = new RemoteBrowserAgentBroker({
      ...options, requestTimeoutMs: 100,
      taskStore: new TaskStore({ dir: join(root, 'remote') }),
    });
    const primary = new BrowserAgentBroker({
      ...options, portRange: 1, fallbackToEphemeral: false,
      taskStore: new TaskStore({ dir: join(root, 'primary') }),
    });
    let failedSocket: WebSocket | undefined;
    let closed: Promise<void> | undefined;
    const terminate = WebSocket.prototype.terminate;
    t.mock.method(WebSocket.prototype, 'terminate', function (this: WebSocket) {
      failedSocket = this;
      closed = new Promise<void>((resolve) => this.once('close', () => resolve()));
      terminate.call(this);
    });
    try {
      await assert.rejects(remote.start(), /not a pi-browser-agent broker/);
      assert.ok(failedSocket, 'the failed connection must be terminated');
      const retired = failedSocket;
      await closed;
      // Bun can emit another transport error after the first error/termination.
      assert.doesNotThrow(() => retired.emit('error', new Error('late transport error')));
      assert.doesNotThrow(() => retired.emit('error', new Error('another transport error')));

      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await primary.start();
      await remote.start();
      assert.equal(remote.probeConnectivity().brokerListening, true);
      assert.equal(remote.probeConnectivity().role, 'proxy');
      assert.doesNotThrow(() => retired.emit('error', new Error('error after replacement')));
      assert.equal(remote.probeConnectivity().brokerListening, true, 'an old socket cannot disrupt its replacement');
      await remote.stop();
      assert.doesNotThrow(() => retired.emit('error', new Error('error after shutdown')));
    } finally {
      await remote.stop();
      await primary.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
}

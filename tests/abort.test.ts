import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket from 'ws';

import { BrowserAgentBroker } from '../src/broker/server.ts';
import { TaskStore } from '../src/broker/task-store.ts';
import { ABORT_ERROR_CODE, isAbortError, sleepUnlessAborted } from '../src/broker/abort.ts';
import { createBrowserEvaluateJsTool } from '../src/tools/browser_js_navigation_tools.ts';
import { createReadOnlyBrowserTools } from '../src/tools/read_only/index.ts';
import type { ResponseFrame } from '../src/broker/protocol.ts';

/**
 * Regression tests for Escape / tool-call cancellation.
 *
 * Before this, every browser_* tool ignored the AbortSignal pi passes as the
 * third argument of execute(), so pressing Escape left the call pending until
 * its own timeout (15s for browser_evaluate_js, 30s for browser_run_js, 5min
 * for browser_run_task). Each test below asserts we now settle promptly and
 * report the cancellation as such instead of as a browser failure.
 */

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

/** Connects a fake extension bridge that accepts requests and never answers,
 *  which is exactly the shape of a long-running in-page evaluation. */
async function connectSilentBridge(port: number): Promise<WebSocket> {
  return await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.once('error', reject);
    socket.once('open', () => socket.send(JSON.stringify({
      v: 1,
      kind: 'hello',
      extensionId: 'ext-abort-test',
      version: '0.1.0',
      capabilities: ['browser_evaluate_js', 'browser_get_html'],
    })));
    socket.once('message', () => resolve(socket));
  });
}

function textOf(result: any): string {
  return result.content[0]?.text || '';
}

async function createBroker(port: number): Promise<BrowserAgentBroker> {
  const root = await mkdtemp(join(tmpdir(), 'pi-ba-abort-'));
  return new BrowserAgentBroker({
    host: '127.0.0.1',
    port,
    portRange: 1,
    fallbackToEphemeral: false,
    logger: { info() {}, warn() {}, error() {} },
    taskStore: new TaskStore({ dir: join(root, 'tasks') }),
  } as any);
}

test('broker.request rejects immediately when the caller aborts mid-flight', async () => {
  const port = await getFreePort();
  const broker = await createBroker(port);
  await broker.start();
  const bridge = await connectSilentBridge(port);

  try {
    const controller = new AbortController();
    const startedAt = Date.now();
    // A 30s timeout stands in for browser_run_js: without abort support the
    // promise below could only settle after those 30 seconds.
    const pending = broker.request('browser_evaluate_js', { expression: 'while(true){}' }, {
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);

    const error = await pending.then(() => null, (reason) => reason);
    const elapsed = Date.now() - startedAt;

    assert.ok(error, 'request should reject when aborted');
    assert.equal(error.code, ABORT_ERROR_CODE);
    assert.ok(isAbortError(error));
    assert.ok(elapsed < 2_000, `expected a prompt rejection, took ${elapsed}ms`);
  } finally {
    bridge.close();
    await broker.stop();
  }
});

test('broker.request refuses to send a request that is already cancelled', async () => {
  const port = await getFreePort();
  const broker = await createBroker(port);
  await broker.start();
  const bridge = await connectSilentBridge(port);
  const received: unknown[] = [];
  bridge.on('message', (raw) => received.push(JSON.parse(String(raw))));

  try {
    const controller = new AbortController();
    controller.abort();

    const error = await broker
      .request('browser_evaluate_js', { expression: '1' }, { signal: controller.signal })
      .then(() => null, (reason) => reason);

    assert.ok(error);
    assert.equal(error.code, ABORT_ERROR_CODE);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(received.length, 0, 'no frame should reach the bridge for an already-cancelled call');
  } finally {
    bridge.close();
    await broker.stop();
  }
});

test('waitForBridge stops waiting when the tool call is cancelled', async () => {
  const port = await getFreePort();
  const broker = await createBroker(port);
  await broker.start();

  try {
    const controller = new AbortController();
    const startedAt = Date.now();
    // No bridge ever connects, so this would otherwise burn the whole budget.
    const pending = broker.waitForBridge(10_000, controller.signal);
    setTimeout(() => controller.abort(), 20);

    const connected = await pending;
    const elapsed = Date.now() - startedAt;

    assert.equal(connected, false);
    assert.ok(elapsed < 2_000, `expected an early return, took ${elapsed}ms`);
  } finally {
    await broker.stop();
  }
});

test('browser_evaluate_js reports cancellation instead of a browser failure', async () => {
  let capturedSignal: AbortSignal | undefined;
  const broker = {
    async ensureReady(options: { signal?: AbortSignal } = {}) {
      capturedSignal = options.signal;
    },
    probeConnectivity() {
      return {
        brokerReachable: true,
        brokerListening: true,
        bridgeConnected: true,
        url: 'ws://127.0.0.1:7878',
        bridgeSessionSerial: 1,
      };
    },
    async request(_type: string, _params: unknown, options: { signal?: AbortSignal } = {}): Promise<ResponseFrame> {
      return await new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const error: any = new Error('browser_evaluate_js was cancelled');
          error.code = ABORT_ERROR_CODE;
          reject(error);
        });
      });
    },
  } as any;

  const tool = createBrowserEvaluateJsTool(broker);
  const controller = new AbortController();
  const pending = tool.execute('call-1', { expression: 'document.title' }, controller.signal);
  setTimeout(() => controller.abort(), 20);

  const result: any = await pending;

  // The signal must reach ensureReady too: that is the 8s bridge-reconnect
  // wait, which used to swallow Escape before any request was even sent.
  assert.ok(capturedSignal, 'ensureReady should receive the abort signal');
  assert.equal(result.details.ok, false);
  assert.equal(result.details.cancelled, true);
  assert.equal(result.details.error.code, ABORT_ERROR_CODE);
  assert.match(textOf(result), /cancelled/i);
  assert.doesNotMatch(textOf(result), /failed/i);
});

test('read-only tools forward the abort signal and label cancellation', async () => {
  const broker = {
    async ensureReady() {},
    probeConnectivity() {
      return {
        brokerReachable: true,
        brokerListening: true,
        bridgeConnected: true,
        url: 'ws://127.0.0.1:7878',
        bridgeSessionSerial: 1,
      };
    },
    async request(_type: string, _params: unknown, options: { signal?: AbortSignal } = {}): Promise<ResponseFrame> {
      return await new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          const error: any = new Error('cancelled');
          error.code = ABORT_ERROR_CODE;
          reject(error);
        });
      });
    },
  } as any;

  const htmlTool = createReadOnlyBrowserTools(broker).find((tool) => tool.name === 'browser_get_html');
  assert.ok(htmlTool);

  const controller = new AbortController();
  const pending = htmlTool.execute('call-2', { url: 'https://example.com' }, controller.signal);
  setTimeout(() => controller.abort(), 20);

  const result: any = await pending;
  assert.equal(result.details.ok, false);
  assert.equal(result.details.cancelled, true);
  assert.equal(result.details.error.code, ABORT_ERROR_CODE);
  assert.match(textOf(result), /cancelled/i);
});

test('sleepUnlessAborted wakes early and reports that it was cut short', async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  setTimeout(() => controller.abort(), 20);

  const completed = await sleepUnlessAborted(5_000, controller.signal);

  assert.equal(completed, false);
  assert.ok(Date.now() - startedAt < 2_000);
  assert.equal(await sleepUnlessAborted(1, undefined), true);
});

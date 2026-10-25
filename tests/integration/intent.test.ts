import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import WebSocket from 'ws';
import { Value } from 'typebox/value';

import { RemoteBrowserAgentBroker } from '../../src/broker/remote.ts';
import { BrowserAgentBroker, type EnsureReadyOptions } from '../../src/broker/server.ts';
import type { BrokerRequestOptions } from '../../src/broker/abort.ts';
import {
  parseIncomingFrame,
  WelcomeFrameSchema,
  type ResponseFrame,
} from '../../src/broker/protocol.ts';
import { TaskStore } from '../../src/broker/task-store.ts';
import {
  createBrowserGetTaskHistoryTool,
  createBrowserListTasksTool,
  createBrowserRunTaskTool,
} from '../../src/tools/browser_task_tools.ts';

const logger = { info() {}, warn() {}, error() {} };

// Tool factories require the nominal primary class, although they only use this
// public surface. Delegate it to the real secondary without a type assertion.
class SecondaryToolBroker extends BrowserAgentBroker {
  private readonly secondary: RemoteBrowserAgentBroker;

  constructor(secondary: RemoteBrowserAgentBroker) {
    super({ taskStore: secondary.taskStore, logger });
    this.secondary = secondary;
  }

  override ensureReady(options?: EnsureReadyOptions) {
    return this.secondary.ensureReady(options);
  }

  override probeConnectivity() {
    return this.secondary.probeConnectivity();
  }

  override request(type: string, params: unknown, options?: BrokerRequestOptions) {
    return this.secondary.request(type, params, options);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function records(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value));
  return value.map((entry: unknown) => record(entry));
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

interface Scenario {
  task: string;
  params: { tab_id?: number; use_active_tab?: boolean; debugMode?: boolean; timeoutMs: number };
  target: { tab_id: number } | { use_active_tab: boolean };
  reply: Pick<ResponseFrame, 'ok' | 'data' | 'error'>;
  status: string;
  code?: string;
}

const scenarios: Scenario[] = [
  {
    task: 'Read the active page',
    params: { timeoutMs: 2_000 },
    target: { use_active_tab: true },
    reply: {
      ok: true,
      data: { status: 'done', message: 'Read page', historySummary: { steps: 1, text: '1. Read page' } },
    },
    status: 'done',
  },
  {
    task: 'Fail on the selected tab',
    params: { tab_id: 42, use_active_tab: true, debugMode: true, timeoutMs: 3_000 },
    target: { tab_id: 42 },
    reply: { ok: true, data: { status: 'error', error: { code: 'E_RUNTIME', message: 'Model failed' } } },
    status: 'error',
    code: 'E_RUNTIME',
  },
  {
    task: 'Reject a busy task',
    params: { use_active_tab: false, timeoutMs: 2_000 },
    target: { use_active_tab: false },
    reply: { ok: false, error: { code: 'E_BUSY', message: 'Already running' } },
    status: 'rejected',
    code: 'E_BUSY',
  },
  {
    task: 'Reject a malformed success',
    params: { timeoutMs: 2_000 },
    target: { use_active_tab: true },
    reply: { ok: true, data: {} },
    status: 'error',
    code: 'E_PROTOCOL',
  },
  {
    task: 'Report a bridge failure',
    params: { timeoutMs: 2_000 },
    target: { use_active_tab: true },
    reply: { ok: false, error: { code: 'E_EXTENSION', message: 'Browser action failed' } },
    status: 'error',
    code: 'E_EXTENSION',
  },
];

test('secondary task tools forward through the primary bridge and retain history after restart', { timeout: 20_000 }, async (t) => {
  const port = await freePort();
  const root = await mkdtemp(join(tmpdir(), 'pi-browser-intent-'));
  const primaryDir = join(root, 'primary');
  const secondaryDir = join(root, 'secondary');
  const options = { host: '127.0.0.1', port, logger, requestTimeoutMs: 4_000 };
  let primary = new BrowserAgentBroker({ ...options, taskStore: new TaskStore({ dir: primaryDir }) });
  let secondary = new RemoteBrowserAgentBroker({ ...options, taskStore: new TaskStore({ dir: secondaryDir }) });
  let bridge: WebSocket | undefined;
  t.after(async () => {
    try {
      await secondary.stop();
    } finally {
      bridge?.terminate();
      try {
        await primary.stop();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  await primary.start();
  assert.equal(primary.port, port);
  bridge = new WebSocket(primary.url);
  await once(bridge, 'open');
  const welcome = once(bridge, 'message');
  bridge.send(JSON.stringify({
    v: 1, kind: 'hello', extensionId: 'intent-fixture', version: '1.0.0', capabilities: ['browser_run_task'],
  }));
  const [welcomeData] = await welcome;
  const welcomeFrame: unknown = JSON.parse(String(welcomeData));
  assert.ok(Value.Check(WelcomeFrameSchema, welcomeFrame));

  const received: Record<string, unknown>[] = [];
  const fixtureErrors: unknown[] = [];
  const fixtureSocket = bridge;
  bridge.on('message', (raw) => {
    try {
      const frame = parseIncomingFrame(String(raw));
      assert.equal(frame.kind, 'request');
      assert.ok(frame.kind === 'request');
      assert.equal(frame.type, 'browser_run_task');
      const params = record(frame.params);
      const scenario = scenarios[received.length];
      assert.ok(scenario, 'unexpected extra bridge request');
      received.push(params);
      const response: ResponseFrame = { v: 1, kind: 'response', id: frame.id, ...scenario.reply };
      fixtureSocket.send(JSON.stringify(response));
    } catch (error) {
      fixtureErrors.push(error);
      fixtureSocket.close();
    }
  });

  await secondary.start();
  assert.equal(secondary.probeConnectivity().role, 'proxy');
  assert.equal(secondary.probeConnectivity().bridgeConnected, true);
  const tools = new SecondaryToolBroker(secondary);
  const run = createBrowserRunTaskTool(tools);
  const saved: Array<{ taskId: string; scenario: Scenario; history: unknown }> = [];

  for (const scenario of scenarios) {
    const result = await run.execute('intent-run', { task: scenario.task, ...scenario.params });
    assert.deepEqual(fixtureErrors, []);
    const { taskId } = result.details;
    assert.equal(typeof taskId, 'string');
    assert.ok(typeof taskId === 'string');
    assert.equal(result.details.ok, !scenario.code);
    assert.equal(result.details.success, scenario.status === 'done');
    assert.equal(result.details.status, scenario.status);
    assert.match(result.content[0].text, scenario.status === 'done' ? /Success: yes/ : /Success: no/);
    if (scenario.code) {
      assert.equal(record(result.details.error).code, scenario.code);
    } else {
      assert.deepEqual(result.details.historySummary, record(scenario.reply.data).historySummary);
      assert.match(result.content[0].text, /History summary:\n1\. Read page/);
    }
    const expectedRequest = {
      taskId, task: scenario.task, debugMode: scenario.params.debugMode ?? false, ...scenario.target,
    };
    assert.deepEqual(received.at(-1), expectedRequest);
    const history = records(result.details.history);
    assert.equal(history.length, 2);
    assert.equal(history[0].kind, 'task_started');
    assert.equal(history[0].status, 'running');
    assert.equal(history[0].taskId, taskId);
    assert.equal(typeof history[0].startedAt, 'number');
    assert.deepEqual(history[0].request, { ...expectedRequest, timeoutMs: scenario.params.timeoutMs });
    assert.equal(history[1].kind, 'task_finished');
    assert.equal(history[1].taskId, taskId);
    assert.equal(history[1].status, scenario.status);
    assert.equal(typeof history[1].endedAt, 'number');
    if (scenario.code) assert.equal(record(history[1].error).code, scenario.code);
    else assert.deepEqual(history[1].result, scenario.reply.data);
    saved.push({ taskId, scenario, history });
  }
  assert.equal(received.length, scenarios.length);
  assert.deepEqual(await primary.taskStore.list(), [], 'history belongs to the calling secondary');

  await secondary.stop();
  bridge.terminate();
  await primary.stop();
  primary = new BrowserAgentBroker({ ...options, taskStore: new TaskStore({ dir: primaryDir }) });
  secondary = new RemoteBrowserAgentBroker({ ...options, taskStore: new TaskStore({ dir: secondaryDir }) });
  await primary.start();
  await secondary.start();
  assert.equal(secondary.probeConnectivity().role, 'proxy');
  assert.equal(secondary.probeConnectivity().bridgeConnected, false);
  const freshTools = new SecondaryToolBroker(secondary);
  const historyTool = createBrowserGetTaskHistoryTool(freshTools);
  const listTool = createBrowserListTasksTool(freshTools);
  for (const { taskId, scenario, history } of saved) {
    const loaded = await historyTool.execute('intent-history', { taskId });
    assert.equal(loaded.details.ok, true);
    assert.deepEqual(loaded.details.history, history);
    const summary = record(loaded.details.summary);
    assert.equal(summary.taskId, taskId);
    assert.equal(summary.task, scenario.task);
    assert.equal(summary.status, scenario.status);
    assert.equal(summary.events, 2);
    if (scenario.code) assert.equal(record(summary.error).code, scenario.code);
    else assert.deepEqual(summary.result, scenario.reply.data);
  }
  const listed = await listTool.execute('intent-list', { limit: 20 });
  assert.equal(listed.details.ok, true);
  const tasks = records(listed.details.tasks);
  assert.equal(tasks.length, saved.length);
  for (const { taskId, scenario } of saved) {
    const summary = tasks.find((entry) => entry.taskId === taskId);
    assert.ok(summary);
    assert.equal(summary.task, scenario.task);
    assert.equal(summary.status, scenario.status);
  }
  const filtered = await listTool.execute('intent-filter', { status: 'done', limit: 20 });
  assert.equal(filtered.details.ok, true);
  assert.deepEqual(records(filtered.details.tasks).map((entry) => entry.taskId), [saved[0].taskId]);
  assert.equal(received.length, scenarios.length, 'history tools must not call the bridge');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import WebSocket, { type RawData } from 'ws';

import { BrowserAgentBroker } from '../../src/broker/server.ts';
import { TaskStore } from '../../src/broker/task-store.ts';
import { registerAllTools, resetRegisteredBrowserTools } from '../../src/tools/_register.ts';

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to allocate a free port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function createBroker() {
  const port = await getFreePort();
  const root = await mkdtemp(join(tmpdir(), 'pi-browser-agent-tool-tests-'));
  const taskStore = new TaskStore({ dir: join(root, 'tasks') });
  const broker = new BrowserAgentBroker({
    host: '127.0.0.1',
    port,
    logger: { info() {}, warn() {}, error() {} },
    taskStore,
    requestTimeoutMs: 1_000,
  });
  await broker.start();
  return { broker, taskStore };
}

async function connectBridge(broker: BrowserAgentBroker, onRequest: (frame: any, socket: WebSocket) => void | Promise<void>) {
  const socket = await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(broker.url);
    ws.once('error', reject);
    ws.once('open', () => {
      ws.send(JSON.stringify({
        v: 1,
        kind: 'hello',
        extensionId: 'ext-test',
        version: '0.0.1',
        capabilities: ['browser_run_task'],
      }));
    });
    ws.once('message', () => resolve(ws));
  });

  socket.on('message', (data: RawData) => {
    const frame = JSON.parse(String(data));
    if (frame.kind === 'request') {
      void onRequest(frame, socket);
    }
  });

  return socket;
}

function createToolHarness(broker: BrowserAgentBroker) {
  resetRegisteredBrowserTools();
  const tools = new Map<string, any>();
  registerAllTools(
    {
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
    },
    { broker },
  );
  return tools;
}

function textOf(result: any): string {
  return result.content[0]?.text || '';
}

test('browser_run_task happy path records history and browser_list/get_history return useful data', async () => {
  const { broker } = await createBroker();
  const socket = await connectBridge(broker, async (frame, ws) => {
    if (frame.type !== 'browser_run_task') return;
    ws.send(JSON.stringify({
      v: 1,
      kind: 'response',
      id: frame.id,
      ok: true,
      data: {
        taskId: frame.params.taskId,
        status: 'done',
        message: 'Completed successfully',
        historySummary: {
          steps: 2,
          text: '1. result: Executed click: {"index":1}\n2. result: Executed type: {"index":2,"text":"hello"}',
        },
      },
    }));
  });
  const tools = createToolHarness(broker);

  try {
    const runResult = await tools.get('browser_run_task').execute('call-1', { task: 'Open example.com' });
    assert.match(textOf(runResult), /completed/i);
    assert.match(textOf(runResult), /Success: yes/i);
    assert.match(textOf(runResult), /History summary:/i);
    assert.equal(runResult.details.ok, true);
    assert.equal(runResult.details.success, true);
    assert.equal(runResult.details.status, 'done');
    assert.equal(runResult.details.historySummary.steps, 2);
    const taskId = String(runResult.details.taskId);

    const historyResult = await tools.get('browser_get_task_history').execute('call-2', { taskId });
    assert.equal(historyResult.details.ok, true);
    assert.equal(historyResult.details.history.length, 2);
    assert.equal(historyResult.details.summary.status, 'done');

    const listResult = await tools.get('browser_list_tasks').execute('call-3', { limit: 10 });
    assert.equal(listResult.details.tasks.length, 1);
    assert.equal(listResult.details.tasks[0].taskId, taskId);
    assert.equal(listResult.details.tasks[0].task, 'Open example.com');
    assert.equal(listResult.details.tasks[0].status, 'done');
  } finally {
    socket.close();
    await broker.stop();
  }
});

test('concurrent browser_run_task attempts return E_BUSY without crashing the caller', async () => {
  const { broker } = await createBroker();
  let activeRunId: string | null = null;
  let activeSocket: WebSocket | null = null;

  const socket = await connectBridge(broker, async (frame, ws) => {
    if (frame.type !== 'browser_run_task') return;
    if (activeRunId) {
      ws.send(JSON.stringify({
        v: 1,
        kind: 'response',
        id: frame.id,
        ok: false,
        error: {
          code: 'E_BUSY',
          message: 'A browser task is already running',
        },
      }));
      return;
    }

    activeRunId = frame.id;
    activeSocket = ws;
  });
  const tools = createToolHarness(broker);

  try {
    const firstRun = tools.get('browser_run_task').execute('call-1', { task: 'Task one' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const secondRun = await tools.get('browser_run_task').execute('call-2', { task: 'Task two' });
    assert.equal(secondRun.details.ok, false);
    assert.equal(secondRun.details.error.code, 'E_BUSY');
    assert.match(textOf(secondRun), /rejected/i);

    assert.ok(activeRunId);
    activeSocket?.send(JSON.stringify({
      v: 1,
      kind: 'response',
      id: activeRunId,
      ok: true,
      data: {
        status: 'done',
        message: 'Finished first task',
      },
    }));

    const firstResult = await firstRun;
    assert.equal(firstResult.details.ok, true);
    assert.equal(firstResult.details.status, 'done');
  } finally {
    socket.close();
    await broker.stop();
  }
});

test('browser_run_task treats runtime error payloads as failures instead of successes', async () => {
  const { broker } = await createBroker();
  const socket = await connectBridge(broker, async (frame, ws) => {
    if (frame.type === 'browser_run_task') {
      ws.send(JSON.stringify({
        v: 1,
        kind: 'response',
        id: frame.id,
        ok: true,
        data: {
          taskId: frame.params.taskId,
          status: 'error',
          message: 'Model failed',
          error: { code: 'E_RUNTIME', message: 'Model failed' },
        },
      }));
    }
  });
  const tools = createToolHarness(broker);

  try {
    const result = await tools.get('browser_run_task').execute('call-1', { task: 'Fail please' });
    assert.equal(result.details.ok, false);
    assert.equal(result.details.status, 'error');
    assert.equal(result.details.error.code, 'E_RUNTIME');

    const history = await tools.get('browser_get_task_history').execute('call-2', { taskId: result.details.taskId });
    assert.equal(history.details.summary.status, 'error');
    assert.equal(history.details.summary.error.code, 'E_RUNTIME');
  } finally {
    socket.close();
    await broker.stop();
  }
});

test('browser_get_task_history rejects invalid task ids safely', async () => {
  const { broker } = await createBroker();
  const tools = createToolHarness(broker);

  try {
    const result = await tools.get('browser_get_task_history').execute('call-1', { taskId: '../../etc/passwd' });
    assert.equal(result.details.ok, false);
    assert.match(String(result.details.error.message), /Invalid task id/);
  } finally {
    await broker.stop();
  }
});

test('browser_run_task surfaces bridge disconnect as a structured error result', async () => {
  const { broker } = await createBroker();
  const socket = await connectBridge(broker, async (frame, ws) => {
    if (frame.type === 'browser_run_task') {
      ws.close();
    }
  });
  const tools = createToolHarness(broker);

  try {
    const result = await tools.get('browser_run_task').execute('call-1', { task: 'Disconnect me' });
    assert.equal(result.details.ok, false);
    assert.equal(result.details.status, 'error');
    assert.equal(result.details.error.code, 'E_BRIDGE_DISCONNECTED');

    const history = await tools.get('browser_get_task_history').execute('call-2', { taskId: result.details.taskId });
    assert.equal(history.details.summary.status, 'error');
    assert.equal(history.details.summary.error.code, 'E_BRIDGE_DISCONNECTED');
  } finally {
    socket.close();
    await broker.stop();
  }
});

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

test('browser_run_task rejects malformed success payloads without a recognized terminal status', async () => {
  const { broker } = await createBroker();
  const socket = await connectBridge(broker, async (frame, ws) => {
    if (frame.type !== 'browser_run_task') return;
    // "ok: true, data: {}" with no status field should NOT be recorded as completed.
    ws.send(JSON.stringify({
      v: 1,
      kind: 'response',
      id: frame.id,
      ok: true,
      data: {},
    }));
  });
  const tools = createToolHarness(broker);

  try {
    const result = await tools.get('browser_run_task').execute('call-1', { task: 'Malformed payload' });
    assert.equal(result.details.ok, false);
    assert.equal(result.details.status, 'error');
    assert.equal(result.details.error.code, 'E_PROTOCOL');

    const history = await tools.get('browser_get_task_history').execute('call-2', { taskId: result.details.taskId });
    assert.equal(history.details.summary.status, 'error');
    assert.equal(history.details.summary.error.code, 'E_PROTOCOL');
  } finally {
    socket.close();
    await broker.stop();
  }
});

test('browser_get_task_history reports corrupted history distinctly from "not found"', async () => {
  const { broker, taskStore } = await createBroker();
  const tools = createToolHarness(broker);

  try {
    // Write a valid line followed by a malformed line.
    await taskStore.append('corrupt-task-id', {
      kind: 'task_started', taskId: 'corrupt-task-id', task: 'Corrupt me', status: 'running', startedAt: Date.now(),
    });
    // Now append raw garbage that can't be JSON-parsed.
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await writeFile(join(taskStore.dir, 'corrupt-task-id.jsonl'), '\n{this is not json}\n', { encoding: 'utf8', flag: 'a' });

    const result = await tools.get('browser_get_task_history').execute('call-1', { taskId: 'corrupt-task-id' });
    assert.equal(result.details.ok, false);
    assert.equal((result.details as any).corrupted, true);
    assert.equal((result.details.error as any).code, 'E_HISTORY_CORRUPTED');
    assert.match(textOf(result), /corrupted/i);

    // And a separate not-found check still reports E_NOT_FOUND.
    const notFound = await tools.get('browser_get_task_history').execute('call-2', { taskId: 'missing' });
    assert.equal(notFound.details.ok, false);
    assert.equal((notFound.details.error as any).code, 'E_NOT_FOUND');
  } finally {
    await broker.stop();
  }
});

test('browser_list_tasks isolates a corrupted task file instead of failing the whole list', async () => {
  const { broker, taskStore } = await createBroker();
  const tools = createToolHarness(broker);

  try {
    await taskStore.append('good-task-id', {
      kind: 'task_started', taskId: 'good-task-id', task: 'Good one', status: 'running', startedAt: Date.now(),
    });
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await writeFile(join(taskStore.dir, 'bad-task-id.jsonl'), 'not json at all\n', 'utf8');

    const result = await tools.get('browser_list_tasks').execute('call-1', { limit: 20 });
    assert.equal(result.details.ok, true);
    const tasks = result.details.tasks as any[];
    const bad = tasks.find((t) => t.taskId === 'bad-task-id');
    const good = tasks.find((t) => t.taskId === 'good-task-id');
    assert.ok(bad);
    assert.equal(bad.corrupted, true);
    assert.equal(bad.status, 'corrupted');
    assert.ok(good);
    assert.equal(good.task, 'Good one');
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

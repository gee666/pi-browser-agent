import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskStore } from '../src/broker/task-store.ts';

test('task store appends, reads, lists, filters, exposes summaries, and garbage-collects tasks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-browser-agent-tasks-'));
  let now = 1_000;
  const store = new TaskStore({ dir: root, ttlMs: 50, now: () => now });

  await store.append('task-a', { kind: 'task_started', taskId: 'task-a', task: 'First task', status: 'running', startedAt: now });
  await store.append('task-a', { kind: 'task_done', taskId: 'task-a', status: 'done', endedAt: now + 1, result: { ok: true } });
  await store.append('task-b', { kind: 'task_started', taskId: 'task-b', task: 'Second task', status: 'running', startedAt: now + 2 });

  const taskA = await store.read('task-a');
  assert.equal(taskA.length, 2);
  assert.equal(taskA[1]?.status, 'done');

  const listed = await store.list({ limit: 10 });
  assert.equal(listed.length, 2);
  assert.equal(listed.some((entry) => entry.taskId === 'task-a' && entry.status === 'done' && entry.task === 'First task'), true);
  assert.deepEqual(listed.find((entry) => entry.taskId === 'task-a')?.result, { ok: true });
  assert.equal(listed.find((entry) => entry.taskId === 'task-a')?.events, 2);

  const runningOnly = await store.list({ limit: 10, status: 'running' });
  assert.deepEqual(runningOnly.map((entry) => entry.taskId), ['task-b']);

  now += 1_000;
  const removed = await store.gc();
  assert.equal(removed.length, 2);
  assert.deepEqual(await store.list(), []);
});

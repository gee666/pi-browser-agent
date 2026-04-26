import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listInstances, removeInstanceFile, writeInstanceFile } from '../src/util/instances.ts';

function setStateRoot(): { restore: () => void } {
  const original = process.env.XDG_STATE_HOME;
  return {
    restore: () => {
      if (original === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = original;
    },
  };
}

test('writeInstanceFile + listInstances round-trip and survive a process-alive check', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-ba-state-'));
  const guard = setStateRoot();
  process.env.XDG_STATE_HOME = root;

  try {
    const record = {
      pid: process.pid,
      port: 7878,
      host: '127.0.0.1',
      url: 'ws://127.0.0.1:7878',
      cwd: process.cwd(),
      startedAt: new Date().toISOString(),
    };

    const path = await writeInstanceFile(record);
    const onDisk = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(onDisk.pid, process.pid);
    assert.equal(onDisk.port, 7878);

    const records = await listInstances();
    assert.equal(records.length, 1);
    assert.equal(records[0].pid, process.pid);
    assert.equal(records[0].port, 7878);

    await removeInstanceFile(process.pid);
    assert.equal((await listInstances()).length, 0);
  } finally {
    guard.restore();
  }
});

test('listInstances GCs files belonging to dead processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-ba-state-'));
  const guard = setStateRoot();
  process.env.XDG_STATE_HOME = root;

  try {
    // Spawn a short-lived child so we know the PID is dead by the time we
    // probe it. We avoid race conditions by waiting for the close event.
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    const deadPid = child.pid!;
    await new Promise<void>((resolve) => child.once('close', () => resolve()));

    await writeInstanceFile({
      pid: deadPid,
      port: 7900,
      host: '127.0.0.1',
      url: `ws://127.0.0.1:7900`,
      cwd: process.cwd(),
      startedAt: new Date().toISOString(),
    });

    const records = await listInstances({ gcStale: true });
    assert.equal(records.find((r) => r.pid === deadPid), undefined, 'stale record should have been GCd');
  } finally {
    guard.restore();
  }
});

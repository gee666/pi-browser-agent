import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ensureStateDir, getStateDir } from './paths.ts';

export interface InstanceRecord {
  pid: number;
  port: number;
  host: string;
  url: string;
  cwd: string;
  startedAt: string;
}

function instancesDir(): string {
  return join(getStateDir(), 'instances');
}

function instanceFilePath(pid: number): string {
  return join(instancesDir(), `${pid}.json`);
}

export async function ensureInstancesDir(): Promise<string> {
  return await ensureStateDir('instances');
}

export async function writeInstanceFile(record: InstanceRecord): Promise<string> {
  const dir = await ensureInstancesDir();
  await mkdir(dir, { recursive: true });
  const path = instanceFilePath(record.pid);
  await writeFile(path, JSON.stringify(record, null, 2), 'utf8');
  return path;
}

export async function removeInstanceFile(pid: number): Promise<void> {
  try {
    await unlink(instanceFilePath(pid));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      throw error;
    }
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    // Signal 0 throws ESRCH if no such process; EPERM means it exists but we
    // lack permission — also "alive" for our purposes.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === 'EPERM';
  }
}

export async function listInstances({ gcStale = true }: { gcStale?: boolean } = {}): Promise<InstanceRecord[]> {
  const dir = instancesDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const records: InstanceRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const path = join(dir, entry);
    let record: InstanceRecord | null = null;
    try {
      const raw = await readFile(path, 'utf8');
      record = JSON.parse(raw) as InstanceRecord;
    } catch {
      record = null;
    }

    if (!record || typeof record.pid !== 'number' || typeof record.port !== 'number') {
      if (gcStale) {
        try { await unlink(path); } catch { /* ignore */ }
      }
      continue;
    }

    if (gcStale && !isProcessAlive(record.pid)) {
      try { await unlink(path); } catch { /* ignore */ }
      continue;
    }

    records.push(record);
  }

  return records;
}

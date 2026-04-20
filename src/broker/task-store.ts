import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface TaskStoreEntry {
  kind: string;
  taskId?: string;
  status?: string;
  startedAt?: number;
  endedAt?: number;
  [key: string]: unknown;
}

export interface TaskSummary {
  taskId: string;
  status: string;
  startedAt?: number;
  endedAt?: number;
  task?: string;
  result?: unknown;
  error?: unknown;
  events?: number;
  path: string;
}

export function assertValidTaskId(taskId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) {
    throw new Error(`Invalid task id: ${taskId}`);
  }
}

function normalizeTaskStatus(status?: string): string {
  switch (String(status || '').toLowerCase()) {
    case 'done':
    case 'completed':
      return 'completed';
    case 'stopped':
    case 'cancelled':
    case 'canceled':
      return 'stopped';
    case 'error':
    case 'failed':
      return 'error';
    default:
      return status || 'unknown';
  }
}

export class TaskStore {
  readonly dir: string;
  readonly ttlMs: number;
  readonly now: () => number;

  constructor({ dir, ttlMs = 7 * 24 * 60 * 60 * 1000, now = () => Date.now() }: { dir: string; ttlMs?: number; now?: () => number }) {
    this.dir = dir;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private getTaskPath(taskId: string): string {
    assertValidTaskId(taskId);
    return join(this.dir, `${taskId}.jsonl`);
  }

  async append(taskId: string, entry: TaskStoreEntry): Promise<string> {
    await this.init();
    const path = this.getTaskPath(taskId);
    const line = `${JSON.stringify(entry)}\n`;
    await writeFile(path, line, { encoding: 'utf8', flag: 'a' });
    return path;
  }

  async read(taskId: string): Promise<TaskStoreEntry[]> {
    const path = this.getTaskPath(taskId);
    const contents = await readFile(path, 'utf8');
    return contents
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TaskStoreEntry);
  }

  async list(options: { limit?: number; status?: string } = {}): Promise<TaskSummary[]> {
    await this.init();
    const limit = options.limit ?? 50;
    const names = (await readdir(this.dir)).filter((name) => name.endsWith('.jsonl'));
    const items = await Promise.all(
      names.map(async (name) => {
        const path = join(this.dir, name);
        const entries = await this.read(name.slice(0, -'.jsonl'.length));
        const stats = await stat(path);
        const first = entries[0] ?? {};
        const last = entries[entries.length - 1] ?? {};
        const summary: TaskSummary = {
          taskId: String(first.taskId ?? name.slice(0, -'.jsonl'.length)),
          status: String(last.status ?? first.status ?? 'unknown'),
          startedAt: typeof first.startedAt === 'number' ? first.startedAt : undefined,
          endedAt: typeof last.endedAt === 'number' ? last.endedAt : undefined,
          task: typeof first.task === 'string' ? first.task : undefined,
          result: last.result,
          error: last.error,
          events: entries.length,
          path,
        };
        return { summary, mtimeMs: stats.mtimeMs };
      }),
    );

    return items
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((item) => item.summary)
      .filter((summary) => {
        if (!options.status) return true;
        const wanted = normalizeTaskStatus(options.status);
        return normalizeTaskStatus(summary.status) === wanted;
      })
      .slice(0, limit);
  }

  async gc(): Promise<string[]> {
    await this.init();
    const cutoff = this.now() - this.ttlMs;
    const names = (await readdir(this.dir)).filter((name) => name.endsWith('.jsonl'));
    const removed: string[] = [];

    await Promise.all(
      names.map(async (name) => {
        const taskId = name.slice(0, -'.jsonl'.length);
        const path = join(this.dir, name);
        const entries = await this.read(taskId).catch(() => [] as TaskStoreEntry[]);
        const first = entries[0] ?? {};
        const last = entries[entries.length - 1] ?? {};
        const candidateTime =
          typeof last.endedAt === 'number'
            ? last.endedAt
            : typeof first.startedAt === 'number'
              ? first.startedAt
              : (await stat(path)).mtimeMs;

        if (candidateTime >= cutoff) {
          return;
        }
        await rm(path, { force: true });
        removed.push(path);
      }),
    );

    return removed;
  }
}

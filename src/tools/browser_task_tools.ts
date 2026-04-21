import { randomUUID } from 'node:crypto';

import { Type } from '@sinclair/typebox';

import type { BrowserAgentBroker } from '../broker/server.ts';
import type { ResponseFrame } from '../broker/protocol.ts';
import { assertValidTaskId, TaskCorruptionError, type TaskStoreEntry } from '../broker/task-store.ts';

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
}

const TERMINAL_TASK_STATUSES = new Set(['done', 'error', 'stopped', 'rejected']);

function terminalStatusOf(data: any): string | null {
  if (typeof data?.status === 'string' && TERMINAL_TASK_STATUSES.has(data.status)) {
    return data.status;
  }
  if (data?.cancelled === true) {
    return 'stopped';
  }
  return null;
}

function runtimeErrorFromData(data: any, status: string): { code: string; message: string; details?: unknown } | null {
  if (status !== 'error') {
    return null;
  }

  if (data?.error && typeof data.error.code === 'string' && typeof data.error.message === 'string') {
    return data.error;
  }

  return {
    code: 'E_RUNTIME',
    message: typeof data?.message === 'string' && data.message ? data.message : 'Browser task failed',
    details: data,
  };
}

function errorInfoFromUnknown(error: unknown): { code: string; message: string; details?: unknown } {
  if (error && typeof error === 'object') {
    const maybe = error as { code?: unknown; message?: unknown; details?: unknown };
    if (typeof maybe.code === 'string' && typeof maybe.message === 'string') {
      return { code: maybe.code, message: maybe.message, details: maybe.details };
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  return {
    code: message === 'E_BRIDGE_DISCONNECTED' ? 'E_BRIDGE_DISCONNECTED' : 'E_INTERNAL',
    message,
  };
}

function textResult(text: string, details: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text }],
    details,
  };
}

function statusText(status: string): string {
  switch (status) {
    case 'done':
      return 'completed';
    case 'stopped':
      return 'stopped';
    case 'error':
      return 'failed';
    case 'running':
      return 'running';
    case 'rejected':
      return 'rejected';
    default:
      return status;
  }
}

async function appendSafe(broker: BrowserAgentBroker, taskId: string, entry: TaskStoreEntry): Promise<void> {
  try {
    await broker.taskStore.append(taskId, entry);
  } catch {
    // Never let history persistence break parent tool execution.
  }
}

async function safeReadHistory(broker: BrowserAgentBroker, taskId: string): Promise<TaskStoreEntry[]> {
  try {
    return await broker.taskStore.read(taskId);
  } catch {
    return [];
  }
}

async function readHistoryStrict(
  broker: BrowserAgentBroker,
  taskId: string,
): Promise<{ ok: true; history: TaskStoreEntry[] } | { ok: false; corrupted: boolean; error: { code: string; message: string } }> {
  try {
    return { ok: true, history: await broker.taskStore.read(taskId) };
  } catch (error) {
    if (error instanceof TaskCorruptionError) {
      return {
        ok: false,
        corrupted: true,
        error: { code: 'E_HISTORY_CORRUPTED', message: error.message },
      };
    }
    // Any other error (e.g. ENOENT) means there's no readable history.
    return {
      ok: false,
      corrupted: false,
      error: { code: 'E_NOT_FOUND', message: `Task ${taskId} was not found` },
    };
  }
}

function summarizeHistory(taskId: string, history: TaskStoreEntry[]) {
  const first = history[0] ?? {};
  const last = history[history.length - 1] ?? {};
  return {
    taskId,
    status: typeof last.status === 'string' ? last.status : typeof first.status === 'string' ? first.status : 'unknown',
    startedAt: typeof first.startedAt === 'number' ? first.startedAt : undefined,
    endedAt: typeof last.endedAt === 'number' ? last.endedAt : undefined,
    task: typeof first.task === 'string' ? first.task : undefined,
    result: last.result,
    error: last.error,
    events: history.length,
  };
}

async function finishRecordedTask(
  broker: BrowserAgentBroker,
  taskId: string,
  status: string,
  extras: Record<string, unknown>,
): Promise<TaskStoreEntry[]> {
  await appendSafe(broker, taskId, {
    kind: 'task_finished',
    taskId,
    status,
    endedAt: Date.now(),
    ...extras,
  });
  return await safeReadHistory(broker, taskId);
}


function formatHistorySummaryText(historySummary: any): string | null {
  if (!historySummary || typeof historySummary !== 'object') {
    return null;
  }
  if (typeof historySummary.text === 'string' && historySummary.text.trim()) {
    return historySummary.text.trim();
  }
  const recentSteps = Array.isArray(historySummary.recentSteps) ? historySummary.recentSteps : [];
  if (recentSteps.length === 0) {
    return null;
  }
  return recentSteps
    .map((step: any, index: number) => {
      const parts = [];
      const num = typeof step?.stepNumber === 'number' ? step.stepNumber + 1 : index + 1;
      if (typeof step?.evaluation === 'string' && step.evaluation) parts.push(`evaluation: ${step.evaluation}`);
      if (typeof step?.nextGoal === 'string' && step.nextGoal) parts.push(`next: ${step.nextGoal}`);
      if (typeof step?.actionResult === 'string' && step.actionResult) parts.push(`result: ${step.actionResult}`);
      return `${num}. ${parts.join(' | ') || 'step recorded'}`;
    })
    .join('\n');
}

function formatResponseText(taskId: string, status: string, message?: string, historySummary?: any): string {
  const lines = [
    `Browser task ${taskId}`,
    `Status: ${statusText(status)}`,
    `Success: ${status === 'done' ? 'yes' : 'no'}`,
    message ? `Message: ${message}` : null,
  ].filter(Boolean) as string[];

  const historyText = formatHistorySummaryText(historySummary);
  if (historyText) {
    lines.push('History summary:');
    lines.push(historyText);
  }

  return lines.join('\n');
}

export function createBrowserRunTaskTool(broker: BrowserAgentBroker) {
  return {
    name: 'browser_run_task',
    label: 'browser_run_task',
    description: 'Run a browser task end-to-end. The task might be secribed with natural English',
    promptSnippet: 'Run a browser task.',
    parameters: Type.Object({
      task: Type.String({ minLength: 1 }),
      debugMode: Type.Optional(Type.Boolean()),
      timeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
    }),
    async execute(_toolCallId: string, params: { task: string; debugMode?: boolean; timeoutMs?: number }): Promise<ToolResult> {
      const probe = broker.probeConnectivity();
      const taskId = randomUUID();
      const startedAt = Date.now();

      await appendSafe(broker, taskId, {
        kind: 'task_started',
        taskId,
        task: params.task,
        status: 'running',
        startedAt,
        request: { debugMode: params.debugMode ?? false, timeoutMs: params.timeoutMs },
      });

      let response: ResponseFrame;
      try {
        response = await broker.request(
          'browser_run_task',
          { taskId, task: params.task, debugMode: params.debugMode ?? false },
          { timeoutMs: params.timeoutMs ?? 5 * 60 * 1000 },
        );
      } catch (error) {
        const errorInfo = errorInfoFromUnknown(error);
        const history = await finishRecordedTask(broker, taskId, 'error', {
          error: errorInfo,
          bridge: { connected: broker.probeConnectivity().bridgeConnected },
        });
        return textResult(formatResponseText(taskId, 'error', errorInfo.message), {
          ok: false,
          success: false,
          taskId,
          status: 'error',
          error: errorInfo,
          probe,
          history,
          summary: summarizeHistory(taskId, history),
          historySummary: null,
        });
      }

      if (!response.ok) {
        const errorInfo = {
          code: response.error?.code || 'E_INTERNAL',
          message: response.error?.message || 'Browser task failed',
          details: response.error?.details,
        };
        const history = await finishRecordedTask(broker, taskId, errorInfo.code === 'E_BUSY' ? 'rejected' : 'error', {
          error: errorInfo,
        });
        return textResult(formatResponseText(taskId, errorInfo.code === 'E_BUSY' ? 'rejected' : 'error', errorInfo.message), {
          ok: false,
          success: false,
          taskId,
          status: errorInfo.code === 'E_BUSY' ? 'rejected' : 'error',
          error: errorInfo,
          response,
          probe,
          history,
          summary: summarizeHistory(taskId, history),
          historySummary: null,
        });
      }

      const resolvedStatus = terminalStatusOf(response.data);
      if (!resolvedStatus) {
        const errorInfo = {
          code: 'E_PROTOCOL',
          message: 'Bridge returned a success response for browser_run_task without a recognized terminal status',
          details: { data: response.data },
        };
        const history = await finishRecordedTask(broker, taskId, 'error', { error: errorInfo });
        return textResult(formatResponseText(taskId, 'error', errorInfo.message), {
          ok: false,
          success: false,
          taskId,
          status: 'error',
          error: errorInfo,
          response,
          probe,
          history,
          summary: summarizeHistory(taskId, history),
          historySummary: null,
        });
      }
      const status = resolvedStatus;
      const runtimeError = runtimeErrorFromData(response.data, status);
      const history = await finishRecordedTask(broker, taskId, status, runtimeError ? { error: runtimeError } : { result: response.data });
      const message = typeof (response.data as any)?.message === 'string' ? (response.data as any).message : undefined;

      const historySummary = (response.data as any)?.historySummary;

      return textResult(formatResponseText(taskId, status, message, historySummary), {
        ok: !runtimeError,
        success: status === 'done' && !runtimeError,
        taskId,
        status,
        result: runtimeError ? undefined : response.data,
        error: runtimeError || undefined,
        probe,
        history,
        summary: summarizeHistory(taskId, history),
        historySummary,
      });
    },
  };
}

export function createBrowserGetTaskHistoryTool(broker: BrowserAgentBroker) {
  return {
    name: 'browser_get_task_history',
    label: 'browser_get_task_history',
    description: 'Read stored browser task history.',
    promptSnippet: 'Read task history.',
    parameters: Type.Object({
      taskId: Type.String({ minLength: 1 }),
    }),
    async execute(_toolCallId: string, params: { taskId: string }): Promise<ToolResult> {
      try {
        assertValidTaskId(params.taskId);
      } catch (error) {
        const errorInfo = errorInfoFromUnknown(error);
        return textResult(`Invalid browser task id ${params.taskId}.`, {
          ok: false,
          taskId: params.taskId,
          error: errorInfo,
        });
      }

      const readResult = await readHistoryStrict(broker, params.taskId);
      if (!readResult.ok) {
        // Distinguish corrupted history from "not found" so operators aren't
        // misled into thinking no data ever existed.
        const prefix = readResult.corrupted
          ? `Browser task history for ${params.taskId} is corrupted.`
          : `No browser task history found for ${params.taskId}.`;
        return textResult(prefix, {
          ok: false,
          taskId: params.taskId,
          corrupted: readResult.corrupted,
          error: readResult.error,
        });
      }
      const history = readResult.history;
      if (history.length === 0) {
        return textResult(`No browser task history found for ${params.taskId}.`, {
          ok: false,
          taskId: params.taskId,
          error: { code: 'E_NOT_FOUND', message: `Task ${params.taskId} was not found` },
        });
      }

      return textResult(`Loaded ${history.length} history event(s) for browser task ${params.taskId}.`, {
        ok: true,
        taskId: params.taskId,
        history,
        summary: summarizeHistory(params.taskId, history),
      });
    },
  };
}

export function createBrowserListTasksTool(broker: BrowserAgentBroker) {
  return {
    name: 'browser_list_tasks',
    label: 'browser_list_tasks',
    description: 'List recent browser tasks.',
    promptSnippet: 'List recent browser tasks.',
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
      status: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId: string, params: { limit?: number; status?: string }): Promise<ToolResult> {
      const tasks = await broker.taskStore.list({ limit: params.limit, status: params.status });
      return textResult(`Loaded ${tasks.length} browser task(s).`, {
        ok: true,
        tasks,
      });
    },
  };
}


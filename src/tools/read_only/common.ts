import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TSchema } from '@sinclair/typebox';

import type { BrowserAgentBroker } from '../../broker/server.ts';
import type { ResponseFrame } from '../../broker/protocol.ts';
import { truncateAndSpill } from '../../util/truncate.ts';

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
}

export interface ReadOnlyToolDefinition<TParams = Record<string, unknown>> {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  parameters: TSchema;
  execute: (toolCallId: string, params: TParams) => Promise<ToolResult>;
}

export class BrowserReadOnlyToolError extends Error {
  code: string;
  details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'BrowserReadOnlyToolError';
    this.code = code;
    this.details = details;
  }
}

export function textResult(text: string, details: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text }],
    details,
  };
}

export function coerceError(error: unknown, fallbackCode = 'E_INTERNAL'): BrowserReadOnlyToolError {
  if (error instanceof BrowserReadOnlyToolError) {
    return error;
  }

  if (error && typeof error === 'object') {
    const maybe = error as { code?: unknown; message?: unknown; details?: unknown };
    if (typeof maybe.code === 'string' && typeof maybe.message === 'string') {
      return new BrowserReadOnlyToolError(maybe.code, maybe.message, maybe.details);
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  const normalizedCode =
    message === 'E_BRIDGE_DISCONNECTED'
      ? 'E_BRIDGE_DISCONNECTED'
      : /timed out/i.test(message)
        ? 'E_TIMEOUT'
        : fallbackCode;

  return new BrowserReadOnlyToolError(normalizedCode, message);
}

export function ensureBridgeConnected(broker: BrowserAgentBroker): void {
  const probe = broker.probeConnectivity();
  if (!probe.brokerListening) {
    throw new BrowserReadOnlyToolError('E_BRIDGE_DISCONNECTED', `Browser agent broker is not listening at ${probe.url}.`, probe);
  }
  if (!probe.bridgeConnected) {
    throw new BrowserReadOnlyToolError('E_BRIDGE_DISCONNECTED', 'Browser agent bridge is not connected.', probe);
  }
}

export async function requestBridge<TData>(
  broker: BrowserAgentBroker,
  type: string,
  params: unknown,
  options: { timeoutMs?: number } = {},
): Promise<{ response: ResponseFrame; data: TData }> {
  ensureBridgeConnected(broker);

  let response: ResponseFrame;
  try {
    response = await broker.request(type, params, options);
  } catch (error) {
    throw coerceError(error, 'E_INTERNAL');
  }

  if (!response.ok) {
    throw new BrowserReadOnlyToolError(
      response.error?.code || 'E_INTERNAL',
      response.error?.message || `Bridge request ${type} failed`,
      response.error?.details,
    );
  }

  return { response, data: response.data as TData };
}

export async function formatJsonResult(title: string, value: unknown, ext = 'json') {
  const serialized = JSON.stringify(value, null, 2);
  const truncated = await truncateAndSpill(serialized, ext);
  const prefix = `${title}\n\n`;
  return {
    text: prefix + truncated.text,
    truncated: truncated.truncated,
    fullOutputPath: truncated.fullOutputPath,
    serialized,
  };
}

export async function formatTextResult(title: string, value: string, ext = 'txt') {
  const truncated = await truncateAndSpill(value, ext);
  const prefix = `${title}\n\n`;
  return {
    text: prefix + truncated.text,
    truncated: truncated.truncated,
    fullOutputPath: truncated.fullOutputPath,
    raw: value,
  };
}

export async function spillBase64Payload(base64: string, ext: string): Promise<string> {
  const path = join(tmpdir(), `pi-browser-agent-${randomBytes(6).toString('hex')}.${ext}`);
  await writeFile(path, Buffer.from(base64, 'base64'));
  return path;
}

export function normalizeScreenshotPayload(data: any): any {
  if (!data || typeof data !== 'object') {
    throw new BrowserReadOnlyToolError('E_INTERNAL', 'Screenshot payload was missing');
  }

  const normalized = {
    mime: typeof data.mime === 'string' ? data.mime : 'image/jpeg',
    data_base64: typeof data.data_base64 === 'string' ? data.data_base64 : typeof data.dataBase64 === 'string' ? data.dataBase64 : undefined,
    width: typeof data.width === 'number' ? data.width : undefined,
    height: typeof data.height === 'number' ? data.height : undefined,
    url: typeof data.url === 'string' ? data.url : undefined,
    title: typeof data.title === 'string' ? data.title : undefined,
    path: typeof data.path === 'string' ? data.path : undefined,
  };

  if (!normalized.data_base64 && !normalized.path) {
    throw new BrowserReadOnlyToolError('E_INTERNAL', 'Screenshot payload did not include image data');
  }

  return normalized;
}

export function inferFileExtensionFromMime(mime: string): string {
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  return 'jpg';
}

export function defaultTimeoutMs(toolName: string): number {
  switch (toolName) {
    case 'browser_wait_for':
      return 35_000;
    case 'browser_get_screenshot':
    case 'browser_get_accessibility_tree':
    case 'browser_get_performance_metrics':
      return 20_000;
    default:
      return 15_000;
  }
}

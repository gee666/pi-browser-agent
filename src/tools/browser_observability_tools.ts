import { Type } from '@sinclair/typebox';

import type { BrowserAgentBroker } from '../broker/server.ts';
import {
  defaultTimeoutMs,
  formatJsonResult,
  requestBridge,
  textResult,
} from './read_only/common.ts';

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
}

function withDefaultActiveTabTarget(params: Record<string, unknown>) {
  if (typeof params.tab_id === 'number' || typeof params.url === 'string' || params.use_active_tab === true) {
    return params;
  }
  return {
    ...params,
    use_active_tab: true,
  };
}

function consoleLogText(details: any) {
  return [
    `Console log query returned ${details.returned} entry(s) from tab ${details.tabId}.`,
    details.disconnectReason ? `Disconnect: ${details.disconnectReason}` : null,
    details.preview ? `\n${details.preview}` : null,
  ].filter(Boolean).join('\n');
}

function networkText(details: any) {
  return [
    `Network query returned ${details.returned} entry(s) from tab ${details.tabId}.`,
    details.disconnectReason ? `Disconnect: ${details.disconnectReason}` : null,
    details.preview ? `\n${details.preview}` : null,
  ].filter(Boolean).join('\n');
}

export function createBrowserGetConsoleLogsTool(broker: BrowserAgentBroker) {
  return {
    name: 'browser_get_console_logs',
    label: 'browser_get_console_logs',
    description:
      'Read buffered browser console logs. If you do not pass tab_id or url, this tool defaults to the active tab. Prefer passing filters such as levels, substring, regex, since, or last to narrow the result. If the output is large, it is truncated and the full result is written to a temp file whose path is included in the response.',
    promptSnippet: 'Read filtered browser console logs.',
    parameters: Type.Object({
      tab_id: Type.Optional(Type.Number()),
      url: Type.Optional(Type.String()),
      use_active_tab: Type.Optional(Type.Boolean()),
      levels: Type.Optional(Type.Array(Type.Union([
        Type.Literal('log'), Type.Literal('info'), Type.Literal('warn'), Type.Literal('error'), Type.Literal('debug'),
      ]))),
      substring: Type.Optional(Type.String()),
      regex: Type.Optional(Type.String()),
      since: Type.Optional(Type.Number()),
      last: Type.Optional(Type.Number({ minimum: 1 })),
      include_exceptions: Type.Optional(Type.Boolean()),
      include_stack: Type.Optional(Type.Boolean()),
      timeout_ms: Type.Optional(Type.Number({ minimum: 1, maximum: 60_000 })),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> {
      const requestParams = withDefaultActiveTabTarget(params);
      const { data } = await requestBridge<Record<string, unknown>>(broker, 'browser_get_console_logs', requestParams, {
        timeoutMs: Number(requestParams.timeout_ms || defaultTimeoutMs('browser_get_console_logs')),
      });

      const rendered = await formatJsonResult('Browser console logs', data, 'json');
      const details = {
        ok: true,
        tabId: data.tabId,
        total: data.total,
        returned: data.returned,
        disconnectedAt: data.disconnectedAt,
        disconnectReason: data.disconnectReason,
        truncation: rendered.truncated,
        fullOutputPath: rendered.fullOutputPath,
        preview: rendered.text,
      };
      return textResult(consoleLogText(details), details);
    },
  };
}

export function createBrowserGetNetworkTool(broker: BrowserAgentBroker) {
  return {
    name: 'browser_get_network',
    label: 'browser_get_network',
    description:
      'Read buffered browser network activity. If you do not pass tab_id or url, this tool defaults to the active tab. Always pass filters such as status, type, url_contains, failed_only, since, or last, because unfiltered results may be large. Use include_request_body or include_response_body only when needed; bodies are size-capped. Large output is truncated and the full result is written to a temp file whose path is included in the response.',
    promptSnippet: 'Read filtered browser network activity.',
    parameters: Type.Object({
      tab_id: Type.Optional(Type.Number()),
      url: Type.Optional(Type.String()),
      use_active_tab: Type.Optional(Type.Boolean()),
      filter: Type.Optional(Type.Object({
        method: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
        status: Type.Optional(Type.Union([Type.Number(), Type.Array(Type.Number())])),
        status_gte: Type.Optional(Type.Number()),
        status_lt: Type.Optional(Type.Number()),
        type: Type.Optional(Type.Array(Type.String())),
        url_contains: Type.Optional(Type.String()),
        url_matches: Type.Optional(Type.String()),
        mime_contains: Type.Optional(Type.String()),
        failed_only: Type.Optional(Type.Boolean()),
        since: Type.Optional(Type.Number()),
        until: Type.Optional(Type.Number()),
        duration_gte_ms: Type.Optional(Type.Number()),
        last: Type.Optional(Type.Number({ minimum: 1 })),
        initiator_contains: Type.Optional(Type.String()),
      })),
      include_request_headers: Type.Optional(Type.Boolean()),
      include_response_headers: Type.Optional(Type.Boolean()),
      include_request_body: Type.Optional(Type.Boolean()),
      include_response_body: Type.Optional(Type.Boolean()),
      body_max_bytes: Type.Optional(Type.Number({ minimum: 1, maximum: 1024 * 1024 })),
      include_timing: Type.Optional(Type.Boolean()),
      timeout_ms: Type.Optional(Type.Number({ minimum: 1, maximum: 60_000 })),
    }),
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> {
      const requestParams = withDefaultActiveTabTarget(params);
      const { data } = await requestBridge<Record<string, unknown>>(broker, 'browser_get_network', requestParams, {
        timeoutMs: Number(requestParams.timeout_ms || defaultTimeoutMs('browser_get_network')),
      });

      const rendered = await formatJsonResult('Browser network activity', data, 'json');
      const details = {
        ok: true,
        tabId: data.tabId,
        total: data.total,
        returned: data.returned,
        disconnectedAt: data.disconnectedAt,
        disconnectReason: data.disconnectReason,
        truncation: rendered.truncated,
        fullOutputPath: rendered.fullOutputPath,
        preview: rendered.text,
      };
      return textResult(networkText(details), details);
    },
  };
}

export function createBufferedObservabilityToolDefinitions(broker: BrowserAgentBroker) {
  return {
    browser_get_console_logs: createBrowserGetConsoleLogsTool(broker),
    browser_get_network: createBrowserGetNetworkTool(broker),
  };
}

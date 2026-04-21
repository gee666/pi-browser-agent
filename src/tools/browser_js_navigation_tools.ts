import { Type } from '@sinclair/typebox';

import type { ProbeResult } from '../broker/protocol.ts';
import type { BrowserAgentBroker } from '../broker/server.ts';
import { truncateAndSpill } from '../util/truncate.ts';

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
}

function textResult(text: string, details: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text }],
    details,
  };
}

function errorInfoFromUnknown(error: unknown): { code: string; message: string; details?: unknown } {
  if (error && typeof error === 'object') {
    const maybe = error as { code?: unknown; message?: unknown; details?: unknown };
    if (typeof maybe.code === 'string' && typeof maybe.message === 'string') {
      return { code: maybe.code, message: maybe.message, details: maybe.details };
    }
  }

  return {
    code: 'E_INTERNAL',
    message: error instanceof Error ? error.message : String(error),
  };
}

async function brokerToolRequest(
  broker: BrowserAgentBroker,
  type: string,
  params: unknown,
  timeoutMs: number,
): Promise<{ ok: true; data: unknown } | { ok: false; error: { code: string; message: string; details?: unknown } }> {
  try {
    const response = await broker.request(type, params, { timeoutMs });
    if (!response.ok) {
      return {
        ok: false,
        error: {
          code: response.error?.code || 'E_INTERNAL',
          message: response.error?.message || `${type} failed`,
          details: response.error?.details,
        },
      };
    }
    return { ok: true, data: response.data };
  } catch (error) {
    return { ok: false, error: errorInfoFromUnknown(error) };
  }
}

async function formatPayload(payload: unknown, ext: 'txt' | 'json' = 'json') {
  const serialized = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return await truncateAndSpill(serialized, ext);
}

function createToolDescription(summary: string): string {
  return `${summary} If the returned payload is large, it is truncated and the full result is written to a temp file whose path is included in the response.`;
}

function withDefaultActiveTabTarget(params: Record<string, unknown>) {
  if (typeof params.tab_id === 'number' || params.use_active_tab === true) {
    return params;
  }
  return {
    ...params,
    use_active_tab: true,
  };
}

// browser_clear_site_data accepts explicit origin/url targets. If either is
// supplied, do not inject use_active_tab — that would send conflicting
// selectors to the bridge and risk clearing the wrong site's data.
function withClearSiteDataTarget(params: Record<string, unknown>) {
  if (
    typeof params.tab_id === 'number'
    || params.use_active_tab === true
    || typeof params.origin === 'string'
    || typeof params.url === 'string'
  ) {
    return params;
  }
  return {
    ...params,
    use_active_tab: true,
  };
}

function createSuccessText(name: string, data: any, spill?: { text: string; truncated: boolean; fullOutputPath?: string }) {
  const headline =
    name === 'browser_navigate'
      ? `Navigated tab ${data?.tabId ?? 'unknown'} to ${data?.url ?? data?.requestedUrl ?? 'unknown URL'}.`
      : name === 'browser_switch_tab'
        ? `Switched to tab ${data?.tabId ?? 'unknown'}.`
        : name === 'browser_close_tab'
          ? `Closed tab ${data?.tabId ?? 'unknown'}.`
          : name === 'browser_reload'
            ? `Reloaded tab ${data?.tabId ?? 'unknown'}.`
            : name === 'browser_clear_site_data'
              ? `Cleared site data for ${data?.origin ?? 'unknown origin'}.`
              : name === 'browser_reload_extension'
                ? `Reloaded browser extension ${data?.extensionId ?? 'unknown'}.`
                : name === 'browser_evaluate_js'
                  ? `Evaluated JavaScript in tab ${data?.tabId ?? 'unknown'}.`
                  : `Ran JavaScript in tab ${data?.tabId ?? 'unknown'}.`;

  if (!spill) {
    return headline;
  }

  return `${headline}\n\n${spill.text}`;
}

// Minimal response shape validation: reject success payloads that drop fields
// the downstream success text depends on. This catches bridge regressions
// before they masquerade as completed operations.
function validateSuccessPayload(name: string, data: any): { code: string; message: string; details?: unknown } | null {
  if (!data || typeof data !== 'object') {
    return { code: 'E_PROTOCOL', message: `${name} response payload was missing`, details: { data } };
  }
  const needsTabId = new Set([
    'browser_navigate',
    'browser_switch_tab',
    'browser_close_tab',
    'browser_reload',
    'browser_evaluate_js',
    'browser_run_js',
  ]);
  if (needsTabId.has(name) && typeof (data as any).tabId !== 'number') {
    return { code: 'E_PROTOCOL', message: `${name} response did not include tabId`, details: { data } };
  }
  if (name === 'browser_navigate' && typeof (data as any).url !== 'string' && typeof (data as any).requestedUrl !== 'string') {
    return { code: 'E_PROTOCOL', message: 'browser_navigate response did not include url', details: { data } };
  }
  if (name === 'browser_clear_site_data' && typeof (data as any).origin !== 'string') {
    return { code: 'E_PROTOCOL', message: 'browser_clear_site_data response did not include origin', details: { data } };
  }
  if (name === 'browser_reload_extension' && typeof (data as any).extensionId !== 'string') {
    return { code: 'E_PROTOCOL', message: 'browser_reload_extension response did not include extensionId', details: { data } };
  }
  return null;
}

async function waitForBridgeSessionChange(broker: BrowserAgentBroker, beforeProbe: ProbeResult, timeoutMs: number): Promise<ProbeResult> {
  const deadline = Date.now() + timeoutMs;
  let lastProbe = broker.probeConnectivity();

  while (Date.now() < deadline) {
    lastProbe = broker.probeConnectivity();
    if (
      lastProbe.bridgeConnected
      && typeof lastProbe.bridgeSessionSerial === 'number'
      && typeof beforeProbe.bridgeSessionSerial === 'number'
      && lastProbe.bridgeSessionSerial > beforeProbe.bridgeSessionSerial
    ) {
      return lastProbe;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw {
    code: 'E_TIMEOUT',
    message: 'Timed out waiting for the browser extension bridge to reconnect after reload',
    details: {
      beforeProbe,
      lastProbe,
      timeoutMs,
    },
  };
}

function createRequestTool(options: {
  name: string;
  description: string;
  promptSnippet: string;
  parameters: any;
  timeoutFromParams: (params: any) => number;
}) {
  return (broker: BrowserAgentBroker) => ({
    name: options.name,
    label: options.name,
    description: createToolDescription(options.description),
    promptSnippet: options.promptSnippet,
    parameters: options.parameters,
    async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> {
      const requestParams = options.name === 'browser_clear_site_data'
        ? withClearSiteDataTarget(params)
        : [
          'browser_evaluate_js',
          'browser_run_js',
          'browser_navigate',
          'browser_reload',
        ].includes(options.name)
          ? withDefaultActiveTabTarget(params)
          : params;

      const outcome = await brokerToolRequest(broker, options.name, requestParams, options.timeoutFromParams(requestParams));
      if (!outcome.ok) {
        return textResult(`${options.name} failed: ${outcome.error.message}`, {
          ok: false,
          error: outcome.error,
          request: requestParams,
        });
      }

      const data = outcome.data as any;
      const protocolError = validateSuccessPayload(options.name, data);
      if (protocolError) {
        return textResult(`${options.name} failed: ${protocolError.message}`, {
          ok: false,
          error: protocolError,
          request: requestParams,
          result: data,
        });
      }
      const spill = await formatPayload(data, 'json');
      return textResult(createSuccessText(options.name, data, spill), {
        ok: true,
        request: requestParams,
        result: data,
        truncated: spill.truncated,
        fullOutputPath: spill.fullOutputPath,
      });
    },
  });
}

export const browserEvaluateJsDefinition = {
  name: 'browser_evaluate_js',
  description: 'Evaluate a JavaScript expression in the page and return the value.',
  promptSnippet: 'Evaluate JavaScript in the current browser page.',
  parameters: Type.Object({
    tab_id: Type.Optional(Type.Number()),
    use_active_tab: Type.Optional(Type.Boolean()),
    expression: Type.String({ minLength: 1 }),
    await_promise: Type.Optional(Type.Boolean({ default: true })),
    return_by_value: Type.Optional(Type.Boolean({ default: true })),
    world: Type.Optional(Type.Literal('main', { default: 'main' })),
    timeout_ms: Type.Optional(Type.Number({ minimum: 1, default: 15_000 })),
  }),
} as const;

export const browserRunJsDefinition = {
  name: 'browser_run_js',
  description: 'Run a longer JavaScript program in the page context and optionally capture console output.',
  promptSnippet: 'Run longer JavaScript in the browser page.',
  parameters: Type.Object({
    tab_id: Type.Optional(Type.Number()),
    use_active_tab: Type.Optional(Type.Boolean()),
    code: Type.String({ minLength: 1 }),
    args: Type.Optional(Type.Array(Type.Unknown())),
    return_by_value: Type.Optional(Type.Boolean({ default: true })),
    world: Type.Optional(Type.Literal('main', { default: 'main' })),
    timeout_ms: Type.Optional(Type.Number({ minimum: 1, default: 30_000 })),
    capture_console: Type.Optional(Type.Boolean({ default: true })),
  }),
} as const;

export const browserNavigateDefinition = {
  name: 'browser_navigate',
  description: 'Navigate a browser tab to a URL and wait for it to settle.',
  promptSnippet: 'Navigate a browser tab to a URL.',
  parameters: Type.Object({
    url: Type.String({ format: 'uri', minLength: 1 }),
    tab_id: Type.Optional(Type.Number()),
    use_active_tab: Type.Optional(Type.Boolean()),
    wait_until: Type.Optional(Type.Union([
      Type.Literal('load'),
      Type.Literal('networkidle'),
      Type.Literal('settle'),
      Type.Literal('none'),
    ], { default: 'load' })),
    timeout_ms: Type.Optional(Type.Number({ minimum: 1, default: 30_000 })),
  }),
} as const;

export const browserSwitchTabDefinition = {
  name: 'browser_switch_tab',
  description: 'Activate a browser tab and optionally wait for it to settle.',
  promptSnippet: 'Switch to a browser tab.',
  parameters: Type.Object({
    tab_id: Type.Number(),
    wait_until: Type.Optional(Type.Union([
      Type.Literal('load'),
      Type.Literal('networkidle'),
      Type.Literal('settle'),
      Type.Literal('none'),
    ], { default: 'load' })),
    timeout_ms: Type.Optional(Type.Number({ minimum: 1, default: 30_000 })),
  }),
} as const;

export const browserCloseTabDefinition = {
  name: 'browser_close_tab',
  description: 'Close a browser tab.',
  promptSnippet: 'Close a browser tab.',
  parameters: Type.Object({
    tab_id: Type.Number(),
  }),
} as const;

export const browserReloadDefinition = {
  name: 'browser_reload',
  description: 'Reload a browser tab.',
  promptSnippet: 'Reload a browser tab.',
  parameters: Type.Object({
    tab_id: Type.Optional(Type.Number()),
    use_active_tab: Type.Optional(Type.Boolean()),
    bypass_cache: Type.Optional(Type.Boolean({ default: false })),
    wait_until: Type.Optional(Type.Union([
      Type.Literal('load'),
      Type.Literal('networkidle'),
      Type.Literal('settle'),
      Type.Literal('none'),
    ], { default: 'load' })),
    timeout_ms: Type.Optional(Type.Number({ minimum: 1, default: 30_000 })),
  }),
} as const;

export const browserReloadExtensionDefinition = {
  name: 'browser_reload_extension',
  description: 'Reload the browser-agent-ext extension itself and wait for the bridge to reconnect.',
  promptSnippet: 'Reload the browser-agent-ext extension and wait for it to reconnect.',
  parameters: Type.Object({
    timeout_ms: Type.Optional(Type.Number({ minimum: 1, default: 15_000 })),
  }),
} as const;

export const browserClearSiteDataDefinition = {
  name: 'browser_clear_site_data',
  description: 'Clear cookies and storage for a site origin. Supported types are: cookies, local_storage, indexed_db, service_workers, cache.',
  promptSnippet: 'Clear site data for a browser origin.',
  parameters: Type.Object({
    url: Type.Optional(Type.String({ format: 'uri' })),
    origin: Type.Optional(Type.String({ format: 'uri' })),
    tab_id: Type.Optional(Type.Number()),
    use_active_tab: Type.Optional(Type.Boolean()),
    types: Type.Optional(Type.Array(Type.Union([
      Type.Literal('cookies'),
      Type.Literal('local_storage'),
      Type.Literal('indexed_db'),
      Type.Literal('service_workers'),
      Type.Literal('cache'),
    ]), { minItems: 1 })),
  }),
} as const;

export const createBrowserEvaluateJsTool = createRequestTool({
  ...browserEvaluateJsDefinition,
  timeoutFromParams: (params) => Number(params.timeout_ms ?? 15_000) + 1_000,
});

export const createBrowserRunJsTool = createRequestTool({
  ...browserRunJsDefinition,
  timeoutFromParams: (params) => Number(params.timeout_ms ?? 30_000) + 1_000,
});

export const createBrowserNavigateTool = createRequestTool({
  ...browserNavigateDefinition,
  timeoutFromParams: (params) => Number(params.timeout_ms ?? 30_000) + 1_000,
});

export const createBrowserSwitchTabTool = createRequestTool({
  ...browserSwitchTabDefinition,
  timeoutFromParams: (params) => Number(params.timeout_ms ?? 30_000) + 1_000,
});

export const createBrowserCloseTabTool = createRequestTool({
  ...browserCloseTabDefinition,
  timeoutFromParams: () => 30_000,
});

export const createBrowserReloadTool = createRequestTool({
  ...browserReloadDefinition,
  timeoutFromParams: (params) => Number(params.timeout_ms ?? 30_000) + 1_000,
});

export const createBrowserClearSiteDataTool = createRequestTool({
  ...browserClearSiteDataDefinition,
  timeoutFromParams: () => 30_000,
});

export function createBrowserReloadExtensionTool(broker: BrowserAgentBroker) {
  return {
    name: browserReloadExtensionDefinition.name,
    label: browserReloadExtensionDefinition.name,
    description: createToolDescription(browserReloadExtensionDefinition.description),
    promptSnippet: browserReloadExtensionDefinition.promptSnippet,
    parameters: browserReloadExtensionDefinition.parameters,
    async execute(_toolCallId: string, params: { timeout_ms?: number }): Promise<ToolResult> {
      const timeoutMs = Number(params.timeout_ms ?? 15_000);
      const beforeProbe = broker.probeConnectivity();
      const outcome = await brokerToolRequest(broker, 'browser_reload_extension', params, timeoutMs);
      if (!outcome.ok) {
        return textResult('browser_reload_extension failed: ' + outcome.error.message, {
          ok: false,
          error: outcome.error,
          request: params,
          probeBefore: beforeProbe,
        });
      }

      try {
        const afterProbe = await waitForBridgeSessionChange(broker, beforeProbe, timeoutMs);
        const data = { ...(outcome.data as Record<string, unknown>), reconnected: true };
        const protocolError = validateSuccessPayload('browser_reload_extension', data);
        if (protocolError) {
          return textResult(`browser_reload_extension failed: ${protocolError.message}`, {
            ok: false,
            error: protocolError,
            request: params,
            result: data,
            probeBefore: beforeProbe,
            probeAfter: broker.probeConnectivity(),
          });
        }
        const spill = await formatPayload(data, 'json');
        return textResult(createSuccessText('browser_reload_extension', data, spill), {
          ok: true,
          request: params,
          result: data,
          probeBefore: beforeProbe,
          probeAfter: afterProbe,
          truncated: spill.truncated,
          fullOutputPath: spill.fullOutputPath,
        });
      } catch (error) {
        const errorInfo = errorInfoFromUnknown(error);
        return textResult('browser_reload_extension failed: ' + errorInfo.message, {
          ok: false,
          error: errorInfo,
          request: params,
          result: outcome.data,
          probeBefore: beforeProbe,
          probeAfter: broker.probeConnectivity(),
        });
      }
    },
  };
}

export function createBrowserJsNavigationToolFamily(broker: BrowserAgentBroker) {
  return [
    createBrowserEvaluateJsTool(broker),
    createBrowserRunJsTool(broker),
    createBrowserNavigateTool(broker),
    createBrowserSwitchTabTool(broker),
    createBrowserCloseTabTool(broker),
    createBrowserReloadTool(broker),
    createBrowserReloadExtensionTool(broker),
    createBrowserClearSiteDataTool(broker),
  ];
}

import { Type } from '@sinclair/typebox';

import type { BrowserAgentBroker } from '../../broker/server.ts';
import {
  BrowserReadOnlyToolError,
  type ReadOnlyToolDefinition,
  coerceError,
  defaultTimeoutMs,
  formatJsonResult,
  formatTextResult,
  inferFileExtensionFromMime,
  normalizeScreenshotPayload,
  requestBridge,
  spillBase64Payload,
  textResult,
} from './common.ts';

const SCREENSHOT_INLINE_LIMIT_BYTES = 256 * 1024;

function levelsType() {
  return Type.Array(Type.Union([
    Type.Literal('log'),
    Type.Literal('info'),
    Type.Literal('warn'),
    Type.Literal('error'),
    Type.Literal('debug'),
  ]));
}

function waitUntilType() {
  return Type.Union([Type.Literal('load'), Type.Literal('networkidle'), Type.Literal('settle')]);
}

function includeType(values: string[]) {
  return Type.Array(Type.Union(values.map((value) => Type.Literal(value))));
}

function createJsonReadOnlyTool<TParams>(
  broker: BrowserAgentBroker,
  config: {
    name: string;
    label: string;
    description: string;
    promptSnippet: string;
    parameters: any;
    title: (data: any, params: TParams) => string;
    normalizeData?: (data: any) => unknown;
    timeoutMs?: (params: TParams) => number;
  },
): ReadOnlyToolDefinition<TParams> {
  return {
    name: config.name,
    label: config.label,
    description: config.description,
    promptSnippet: config.promptSnippet,
    parameters: config.parameters,
    async execute(_toolCallId: string, params: TParams) {
      try {
        const { data, response } = await requestBridge<any>(broker, config.name, params, {
          timeoutMs: config.timeoutMs ? config.timeoutMs(params) : defaultTimeoutMs(config.name),
        });
        const normalized = config.normalizeData ? config.normalizeData(data) : data;
        const formatted = await formatJsonResult(config.title(normalized, params), normalized);
        return textResult(formatted.text, {
          ok: true,
          requestType: config.name,
          response,
          result: normalized,
          truncated: formatted.truncated,
          fullOutputPath: formatted.fullOutputPath,
        });
      } catch (error) {
        const info = coerceError(error);
        return textResult(`${config.label} failed: ${info.message}`, {
          ok: false,
          requestType: config.name,
          error: { code: info.code, message: info.message, details: info.details },
        });
      }
    },
  };
}

function createScreenshotTool(broker: BrowserAgentBroker): ReadOnlyToolDefinition<any> {
  return {
    name: 'browser_get_screenshot',
    label: 'browser_get_screenshot',
    description:
      'Capture a compressed browser screenshot. Prefer selector/full_page options only when you need them. Large screenshots are spilled to a temp file and the file path is returned.',
    promptSnippet: 'Capture a browser screenshot.',
    parameters: Type.Object({
      url: Type.Optional(Type.String({ minLength: 1 })),
      tab_id: Type.Optional(Type.Number()),
      use_active_tab: Type.Optional(Type.Boolean()),
      full_page: Type.Optional(Type.Boolean()),
      selector: Type.Optional(Type.String({ minLength: 1 })),
      wait_until: Type.Optional(waitUntilType()),
      format: Type.Optional(Type.Union([Type.Literal('jpeg'), Type.Literal('png')])),
      quality: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      max_width: Type.Optional(Type.Number({ minimum: 1 })),
    }),
    async execute(_toolCallId: string, params: any) {
      try {
        const { data, response } = await requestBridge<any>(broker, 'browser_get_screenshot', params, {
          timeoutMs: defaultTimeoutMs('browser_get_screenshot'),
        });
        const normalized = normalizeScreenshotPayload(data);
        let path = normalized.path;
        let dataBase64 = normalized.data_base64;
        const inlineBytes = dataBase64 ? Buffer.byteLength(dataBase64, 'base64') : 0;

        if (!path && dataBase64 && inlineBytes > SCREENSHOT_INLINE_LIMIT_BYTES) {
          path = await spillBase64Payload(dataBase64, inferFileExtensionFromMime(normalized.mime));
          dataBase64 = undefined;
        }

        const location = path ? `saved to ${path}` : `returned inline (${inlineBytes} bytes)`;
        return textResult(
          `Captured screenshot for ${normalized.title || normalized.url || 'tab'}; ${location}.`,
          {
            ok: true,
            requestType: 'browser_get_screenshot',
            response,
            result: {
              ...normalized,
              data_base64: dataBase64,
              path,
            },
            inlined: !!dataBase64,
            spilledToFile: !!path,
            inlineBytes,
          },
        );
      } catch (error) {
        const info = coerceError(error);
        return textResult(`browser_get_screenshot failed: ${info.message}`, {
          ok: false,
          requestType: 'browser_get_screenshot',
          error: { code: info.code, message: info.message, details: info.details },
        });
      }
    },
  };
}

function createHtmlTool(broker: BrowserAgentBroker): ReadOnlyToolDefinition<any> {
  return {
    name: 'browser_get_html',
    label: 'browser_get_html',
    description:
      'Extract HTML from a page. Prefer a CSS selector to return only the subtree you need. If the output is large, it is truncated and the full HTML is written to a temp file.',
    promptSnippet: 'Get rendered HTML from the browser.',
    parameters: Type.Object({
      url: Type.Optional(Type.String({ minLength: 1 })),
      tab_id: Type.Optional(Type.Number()),
      use_active_tab: Type.Optional(Type.Boolean()),
      selector: Type.Optional(Type.String({ minLength: 1 })),
      selector_all: Type.Optional(Type.Boolean()),
      rendered: Type.Optional(Type.Boolean()),
      wait_until: Type.Optional(waitUntilType()),
      strip: Type.Optional(includeType(['script', 'style', 'comments'])),
      max_bytes: Type.Optional(Type.Number({ minimum: 1 })),
    }),
    async execute(_toolCallId: string, params: any) {
      try {
        const { data, response } = await requestBridge<any>(broker, 'browser_get_html', params, {
          timeoutMs: defaultTimeoutMs('browser_get_html'),
        });
        const html = typeof data?.html === 'string' ? data.html : typeof data?.content === 'string' ? data.content : '';
        const formatted = await formatTextResult(`HTML for ${data?.url || params.url || 'current page'}`, html, 'html');
        return textResult(formatted.text, {
          ok: true,
          requestType: 'browser_get_html',
          response,
          result: { ...data, html },
          truncated: formatted.truncated,
          fullOutputPath: formatted.fullOutputPath,
        });
      } catch (error) {
        const info = coerceError(error);
        return textResult(`browser_get_html failed: ${info.message}`, {
          ok: false,
          requestType: 'browser_get_html',
          error: { code: info.code, message: info.message, details: info.details },
        });
      }
    },
  };
}

export function createReadOnlyBrowserTools(broker: BrowserAgentBroker): ReadOnlyToolDefinition[] {
  return [
    createScreenshotTool(broker),
    createHtmlTool(broker),
    createJsonReadOnlyTool(broker, {
      name: 'browser_get_dom_info',
      label: 'browser_get_dom_info',
      description:
        'Inspect DOM details for matching elements. Prefer a specific selector and narrow include fields. Supported include values: attributes, rect, textContent, innerHTML, accessibility, visibility, event_listeners, outer_html. Aliases also accepted: text -> textContent, html -> innerHTML, boundingBox -> rect. Large results are truncated and spilled to a temp file.',
      promptSnippet: 'Inspect DOM details for selected elements.',
      parameters: Type.Object({
        url: Type.Optional(Type.String({ minLength: 1 })),
        selector: Type.String({ minLength: 1 }),
        selector_all: Type.Optional(Type.Boolean()),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
        include: Type.Optional(includeType(['attributes', 'rect', 'textContent', 'innerHTML', 'accessibility', 'visibility', 'event_listeners', 'outer_html', 'text', 'html', 'boundingBox'])),},{
      }),
      title: (_data, params) => `DOM info for selector ${String((params as any).selector)}`,
    }),
    createJsonReadOnlyTool(broker, {
      name: 'browser_get_computed_styles',
      label: 'browser_get_computed_styles',
      description:
        'Read computed CSS styles. Prefer listing only the properties you need. Large results are truncated and spilled to a temp file.',
      promptSnippet: 'Read computed CSS styles for a selector.',
      parameters: Type.Object({
        url: Type.Optional(Type.String({ minLength: 1 })),
        selector: Type.String({ minLength: 1 }),
        properties: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
        pseudo: Type.Optional(Type.String({ minLength: 1 })),
        include_matched_rules: Type.Optional(Type.Boolean()),
        include_inherited: Type.Optional(Type.Boolean()),
        include_box_model: Type.Optional(Type.Boolean()),
      }),
      title: (_data, params) => `Computed styles for selector ${String((params as any).selector)}`,
    }),
    createJsonReadOnlyTool(broker, {
      name: 'browser_list_tabs',
      label: 'browser_list_tabs',
      description: 'List browser tabs and identify the dedicated agent tab.',
      promptSnippet: 'List browser tabs.',
      parameters: Type.Object({}),
      title: (data) => `Open browser tabs (${Array.isArray(data) ? data.length : 0})`,
      normalizeData: (data) => (Array.isArray(data) ? data : data?.tabs ?? []),
    }),
    createJsonReadOnlyTool(broker, {
      name: 'browser_wait_for',
      label: 'browser_wait_for',
      description: 'Wait for a selector, text, or URL condition. Returns the matched condition and timing details.',
      promptSnippet: 'Wait for a page condition.',
      parameters: Type.Object({
        url: Type.Optional(Type.String({ minLength: 1 })),
        tab_id: Type.Optional(Type.Number()),
        selector: Type.Optional(Type.String({ minLength: 1 })),
        text: Type.Optional(Type.String({ minLength: 1 })),
        url_matches: Type.Optional(Type.String({ minLength: 1 })),
        state: Type.Optional(Type.Union([Type.Literal('visible'), Type.Literal('hidden'), Type.Literal('detached'), Type.Literal('attached')])),
        timeout_ms: Type.Optional(Type.Number({ minimum: 1 })),
      }),
      title: (data) => `Wait result: ${String(data?.status || 'unknown')}`,
      timeoutMs: (params: any) => {
        const requested = Number(params?.timeout_ms || 30_000);
        return Math.max(requested, 1) + 1_500;
      },
    }),
    createJsonReadOnlyTool(broker, {
      name: 'browser_get_accessibility_tree',
      label: 'browser_get_accessibility_tree',
      description:
        'Read the accessibility tree. Prefer a root selector or include filters when possible. Large trees are truncated and spilled to a temp file.',
      promptSnippet: 'Read the accessibility tree.',
      parameters: Type.Object({
        url: Type.Optional(Type.String({ minLength: 1 })),
        root_selector: Type.Optional(Type.String({ minLength: 1 })),
        interesting_only: Type.Optional(Type.Boolean()),
        max_depth: Type.Optional(Type.Number({ minimum: 1 })),
        include: Type.Optional(includeType(['role', 'name', 'value', 'description', 'properties', 'children'])),
      }),
      title: () => 'Accessibility tree',
    }),
    createJsonReadOnlyTool(broker, {
      name: 'browser_get_performance_metrics',
      label: 'browser_get_performance_metrics',
      description: 'Read performance metrics, timing, layout, memory, paint, and optional web-vitals data.',
      promptSnippet: 'Read browser performance metrics.',
      parameters: Type.Object({
        url: Type.Optional(Type.String({ minLength: 1 })),
        include: Type.Optional(includeType(['metrics', 'timing', 'web_vitals', 'layout', 'memory', 'paint'])),
      }),
      title: () => 'Performance metrics',
      timeoutMs: (params: any) => ((params?.include as string[] | undefined)?.includes('web_vitals') ? 27_500 : defaultTimeoutMs('browser_get_performance_metrics')),
    }),
  ];
}

export function createReadOnlyBrowserToolMap(broker: BrowserAgentBroker): Map<string, ReadOnlyToolDefinition> {
  return new Map(createReadOnlyBrowserTools(broker).map((tool) => [tool.name, tool]));
}

export const READ_ONLY_BROWSER_TOOL_NAMES = [
  'browser_get_screenshot',
  'browser_get_html',
  'browser_get_dom_info',
  'browser_get_computed_styles',
  'browser_list_tabs',
  'browser_wait_for',
  'browser_get_accessibility_tree',
  'browser_get_performance_metrics',
] as const;

export function createReadOnlyBrowserToolDefinitionsSummary() {
  return READ_ONLY_BROWSER_TOOL_NAMES.map((name) => ({ name }));
}

export { BrowserReadOnlyToolError };

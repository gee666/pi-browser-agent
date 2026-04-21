import test from 'node:test';
import assert from 'node:assert/strict';

import type { ResponseFrame } from '../../src/broker/protocol.ts';
import {
  browserClearSiteDataDefinition,
  browserEvaluateJsDefinition,
  browserRunJsDefinition,
  createBrowserClearSiteDataTool,
  createBrowserCloseTabTool,
  createBrowserEvaluateJsTool,
  createBrowserJsNavigationToolFamily,
  createBrowserNavigateTool,
  createBrowserReloadExtensionTool,
  createBrowserReloadTool,
  createBrowserRunJsTool,
  createBrowserSwitchTabTool,
} from '../../src/tools/browser_js_navigation_tools.ts';

function textOf(result: any): string {
  return result.content[0]?.text || '';
}

function createBrokerStub(handler: (type: string, params: unknown, options: { timeoutMs?: number }) => Promise<ResponseFrame>) {
  return {
    async request(type: string, params: unknown, options: { timeoutMs?: number }) {
      return await handler(type, params, options);
    },
  } as any;
}

test('tool family builders expose all expected JS/navigation/destructive tools', () => {
  const broker = createBrokerStub(async () => ({ v: 1, kind: 'response', id: 'unused', ok: true, data: {} }));
  const family = createBrowserJsNavigationToolFamily(broker).map((tool) => tool.name);
  assert.deepEqual(family, [
    'browser_evaluate_js',
    'browser_run_js',
    'browser_navigate',
    'browser_switch_tab',
    'browser_close_tab',
    'browser_reload',
    'browser_reload_extension',
    'browser_clear_site_data',
  ]);
  assert.equal('url' in (browserEvaluateJsDefinition.parameters as any).properties, false);
  assert.equal('url' in (browserRunJsDefinition.parameters as any).properties, false);
  assert.equal((browserClearSiteDataDefinition.parameters as any).properties.types.minItems, 1);
});

test('browser_evaluate_js forwards timeout-aware requests, defaults to the active tab, and truncates large payloads', async () => {
  let captured: { type: string; params: any; timeoutMs?: number } | null = null;
  const broker = createBrokerStub(async (type, params, options) => {
    captured = { type, params, timeoutMs: options.timeoutMs };
    return {
      v: 1,
      kind: 'response',
      id: '1',
      ok: true,
      data: { tabId: 7, value: 'x'.repeat(60_000) },
    };
  });

  const tool = createBrowserEvaluateJsTool(broker);
  const result = await tool.execute('call-1', { expression: 'document.title', timeout_ms: 1234 });

  const recorded = captured as any;
  assert.ok(recorded);
  assert.equal(recorded.type, 'browser_evaluate_js');
  assert.equal(recorded.params.expression, 'document.title');
  assert.equal(recorded.params.use_active_tab, true);
  assert.equal(recorded.timeoutMs, 2234);
  assert.equal(result.details.ok, true);
  assert.equal(result.details.truncated, true);
  assert.match(textOf(result), /Full output:/);
});

test('browser_run_js returns structured bridge failures instead of throwing', async () => {
  const broker = createBrokerStub(async () => ({
    v: 1,
    kind: 'response',
    id: '2',
    ok: false,
    error: { code: 'E_TIMEOUT', message: 'Timed out while evaluating JavaScript' },
  }));

  const tool = createBrowserRunJsTool(broker);
  const result = await tool.execute('call-2', { code: 'return 1;' });

  assert.equal(result.details.ok, false);
  assert.equal((result.details as any).error.code, 'E_TIMEOUT');
  assert.match(textOf(result), /browser_run_js failed/);
});

test('navigation/destructive tool builders pass through successful bridge responses and default relevant tools to the active tab', async () => {
  const calls: Array<{ type: string; params: any }> = [];
  const broker = createBrokerStub(async (type, params) => {
    calls.push({ type, params });
    return {
      v: 1,
      kind: 'response',
      id: type,
      ok: true,
      data: { tabId: 9, url: 'https://example.com', origin: 'https://example.com', closed: true, active: true, cleared: true },
    };
  });

  const navigate = await createBrowserNavigateTool(broker).execute('call-3', { url: 'https://example.com' });
  assert.equal(navigate.details.ok, true);
  assert.match(textOf(navigate), /Navigated tab 9/);
  assert.equal(calls[0]?.params?.use_active_tab, true);

  const switchTab = await createBrowserSwitchTabTool(broker).execute('call-4', { tab_id: 9 });
  assert.match(textOf(switchTab), /Switched to tab 9/);

  const closeTab = await createBrowserCloseTabTool(broker).execute('call-5', { tab_id: 9 });
  assert.match(textOf(closeTab), /Closed tab 9/);

  const reload = await createBrowserReloadTool(broker).execute('call-6', { tab_id: 9 });
  assert.match(textOf(reload), /Reloaded tab 9/);

  const clear = await createBrowserClearSiteDataTool(broker).execute('call-7', { origin: 'https://example.com' });
  assert.match(textOf(clear), /Cleared site data/);
  // Explicit origin/url must NOT be combined with use_active_tab: that would
  // send conflicting selectors to the bridge.
  assert.equal(calls.at(-1)?.params?.use_active_tab, undefined);
  assert.equal(calls.at(-1)?.params?.origin, 'https://example.com');
});

test('browser_clear_site_data defaults to the active tab only when no explicit target is given', async () => {
  const calls: Array<{ type: string; params: any }> = [];
  const broker = createBrokerStub(async (type, params) => {
    calls.push({ type, params });
    return {
      v: 1,
      kind: 'response',
      id: type,
      ok: true,
      data: { origin: 'https://example.com', cleared: true },
    };
  });

  await createBrowserClearSiteDataTool(broker).execute('call-c1', {});
  assert.equal(calls.at(-1)?.params?.use_active_tab, true);

  await createBrowserClearSiteDataTool(broker).execute('call-c2', { url: 'https://example.com/path' });
  assert.equal(calls.at(-1)?.params?.use_active_tab, undefined);
  assert.equal(calls.at(-1)?.params?.url, 'https://example.com/path');
});

test('browser_reload_extension waits for a new bridge session after requesting reload', async () => {
  let calls = 0;
  const broker = {
    async request(type: string) {
      assert.equal(type, 'browser_reload_extension');
      return {
        v: 1,
        kind: 'response',
        id: 'ext-reload',
        ok: true,
        data: { extensionId: 'abc123', reloading: true },
      } as ResponseFrame;
    },
    probeConnectivity() {
      calls += 1;
      return calls < 3
        ? { brokerReachable: true, brokerListening: true, bridgeConnected: true, bridgeSessionSerial: 1, url: 'ws://127.0.0.1:7878' }
        : { brokerReachable: true, brokerListening: true, bridgeConnected: true, bridgeSessionSerial: 2, url: 'ws://127.0.0.1:7878' };
    },
  } as any;

  const result = await createBrowserReloadExtensionTool(broker).execute('call-ext', { timeout_ms: 1_000 });
  assert.equal(result.details.ok, true);
  assert.match(textOf(result), /Reloaded browser extension abc123/);
});

test('navigation tools reject malformed success payloads without required fields', async () => {
  // Navigate response missing tabId should be surfaced as E_PROTOCOL.
  const navBroker = createBrokerStub(async () => ({
    v: 1, kind: 'response', id: 'n', ok: true, data: { url: 'https://example.com' },
  }));
  const navResult = await createBrowserNavigateTool(navBroker).execute('call-n', { url: 'https://example.com' });
  assert.equal(navResult.details.ok, false);
  assert.equal((navResult.details as any).error.code, 'E_PROTOCOL');
  assert.match(textOf(navResult), /browser_navigate failed/);

  // clear_site_data without origin in response should be E_PROTOCOL too.
  const clearBroker = createBrokerStub(async () => ({
    v: 1, kind: 'response', id: 'c', ok: true, data: { cleared: true },
  }));
  const clearResult = await createBrowserClearSiteDataTool(clearBroker).execute('call-c', { origin: 'https://example.com' });
  assert.equal(clearResult.details.ok, false);
  assert.equal((clearResult.details as any).error.code, 'E_PROTOCOL');
});

test('browser_reload_extension surfaces reconnect timeout as a structured error result', async () => {
  const broker = {
    async request() {
      return {
        v: 1, kind: 'response', id: 'ext', ok: true, data: { extensionId: 'abc', reloading: true },
      } as ResponseFrame;
    },
    // Always report the same bridge session serial — the tool should time out waiting for a new one.
    probeConnectivity() {
      return { brokerReachable: true, brokerListening: true, bridgeConnected: true, bridgeSessionSerial: 42, url: 'ws://127.0.0.1:7878' };
    },
  } as any;

  const result = await createBrowserReloadExtensionTool(broker).execute('call-ext-t', { timeout_ms: 150 });
  assert.equal(result.details.ok, false);
  assert.equal((result.details as any).error.code, 'E_TIMEOUT');
  assert.match(textOf(result), /browser_reload_extension failed/);
});

test('tool builders convert transport exceptions into safe error payloads', async () => {
  const broker = createBrokerStub(async () => {
    throw { code: 'E_BRIDGE_DISCONNECTED', message: 'socket dropped' };
  });

  const result = await createBrowserReloadTool(broker).execute('call-8', { tab_id: 9 });
  assert.equal(result.details.ok, false);
  assert.equal((result.details as any).error.code, 'E_BRIDGE_DISCONNECTED');
  assert.match(textOf(result), /socket dropped/);
});

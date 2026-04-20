import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createBrowserGetConsoleLogsTool, createBrowserGetNetworkTool, createBufferedObservabilityToolDefinitions } from '../../src/tools/browser_observability_tools.ts';

function createBroker(overrides: Partial<any> = {}) {
  return {
    async request(_type: string, _params: unknown) {
      return { ok: true, data: {} };
    },
    probeConnectivity() {
      return { brokerListening: true, bridgeConnected: true, url: 'ws://127.0.0.1:7878' };
    },
    ...overrides,
  } as any;
}

function textOf(result: any): string {
  return result.content[0]?.text || '';
}

test('browser_get_console_logs tool forwards params and returns truncated previews with temp file spill', async () => {
  let call: any = null;
  const broker = createBroker({
    async request(type: string, params: unknown) {
      call = { type, params };
      return {
        ok: true,
        data: {
          tabId: 2,
          total: 1,
          returned: 1,
          entries: Array.from({ length: 2500 }, (_, index) => ({ level: 'info', text: `line-${index}` })),
        },
      };
    },
  });

  const tool = createBrowserGetConsoleLogsTool(broker);
  const result = await tool.execute('call-1', { tab_id: 2, levels: ['info'], timeout_ms: 1234 });

  assert.equal(call.type, 'browser_get_console_logs');
  assert.deepEqual(call.params, { tab_id: 2, levels: ['info'], timeout_ms: 1234 });
  assert.equal(result.details.ok, true);
  assert.ok(result.details.fullOutputPath);
  assert.equal((result.details as any).entries, undefined);
  const spilled = await readFile(String(result.details.fullOutputPath), 'utf8');
  assert.match(spilled, /line-2499/);
  assert.match(textOf(result), /Console log query returned 1 entry/);
});

test('browser_get_console_logs defaults to the active tab when no target is provided', async () => {
  let call: any = null;
  const tool = createBrowserGetConsoleLogsTool(createBroker({
    async request(type: string, params: unknown) {
      call = { type, params };
      return { ok: true, data: { tabId: 7, total: 0, returned: 0, entries: [] } };
    },
  }));

  await tool.execute('call-1', { last: 5 });
  assert.deepEqual(call.params, { last: 5, use_active_tab: true });
});

test('browser_get_network tool throws structured failures instead of returning soft-error payloads', async () => {
  const tool = createBrowserGetNetworkTool(createBroker({
    async request() {
      throw { code: 'E_BRIDGE_DISCONNECTED', message: 'socket dropped' };
    },
  }));

  await assert.rejects(
    () => tool.execute('call-1', { filter: { failed_only: true } }),
    (error: any) => {
      assert.equal(error.code, 'E_BRIDGE_DISCONNECTED');
      assert.equal(error.message, 'socket dropped');
      return true;
    },
  );
});

test('buffered observability tool-definition builders expose both tools', () => {
  const definitions = createBufferedObservabilityToolDefinitions(createBroker());
  assert.deepEqual(Object.keys(definitions).sort(), ['browser_get_console_logs', 'browser_get_network']);
  assert.match(definitions.browser_get_network.description, /defaults to the active tab/i);
  assert.match(definitions.browser_get_network.description, /Always pass filters/i);
  assert.match(definitions.browser_get_console_logs.description, /defaults to the active tab/i);
  assert.match(definitions.browser_get_console_logs.description, /Prefer passing filters/i);
});

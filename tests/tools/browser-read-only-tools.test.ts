import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';

import { createReadOnlyBrowserToolMap, READ_ONLY_BROWSER_TOOL_NAMES } from '../../src/tools/read_only/index.ts';

function createBrokerHarness(handler: (type: string, params: unknown, options?: { timeoutMs?: number }) => any) {
  return {
    probeConnectivity() {
      return {
        brokerListening: true,
        bridgeConnected: true,
        url: 'ws://127.0.0.1:7777',
      };
    },
    async request(type: string, params: unknown, options?: { timeoutMs?: number }) {
      return await handler(type, params, options);
    },
  } as any;
}

function textOf(result: any) {
  return String(result.content?.[0]?.text || '');
}

test('read-only tool family exports exactly the planned tool names', () => {
  assert.deepEqual(READ_ONLY_BROWSER_TOOL_NAMES, [
    'browser_get_screenshot',
    'browser_get_html',
    'browser_get_dom_info',
    'browser_get_computed_styles',
    'browser_list_tabs',
    'browser_wait_for',
    'browser_get_accessibility_tree',
    'browser_get_performance_metrics',
  ]);
});

test('browser_get_html truncates oversized HTML and spills the full output to a temp file', async () => {
  const tools = createReadOnlyBrowserToolMap(createBrokerHarness(async (type) => {
    assert.equal(type, 'browser_get_html');
    return {
      ok: true,
      id: 'req-1',
      kind: 'response',
      v: 1,
      data: {
        url: 'https://example.com',
        html: '<div>' + 'x'.repeat(60_000) + '</div>',
      },
    };
  }));

  const result = await tools.get('browser_get_html')!.execute('call-1', { selector: '#app' });
  assert.equal(result.details.ok, true);
  assert.equal(result.details.truncated, true);
  assert.match(textOf(result), /Full output:/);

  const spillPath = String(result.details.fullOutputPath);
  const spilled = await readFile(spillPath, 'utf8');
  assert.match(spilled, /^<div>x+/);
  await rm(spillPath, { force: true });
});

test('browser_get_screenshot spills large inline payloads to a temp file', async () => {
  const largeBase64 = Buffer.alloc(300 * 1024, 7).toString('base64');
  const tools = createReadOnlyBrowserToolMap(createBrokerHarness(async (type) => {
    assert.equal(type, 'browser_get_screenshot');
    return {
      ok: true,
      id: 'req-2',
      kind: 'response',
      v: 1,
      data: {
        mime: 'image/jpeg',
        data_base64: largeBase64,
        width: 1280,
        height: 720,
        url: 'https://example.com',
        title: 'Example',
      },
    };
  }));

  const result = await tools.get('browser_get_screenshot')!.execute('call-1', {});
  assert.equal(result.details.ok, true);
  assert.equal(result.details.inlined, false);
  assert.equal(result.details.spilledToFile, true);
  assert.equal((result.details.result as any).data_base64, undefined);

  const spillPath = String((result.details.result as any).path);
  const spilled = await readFile(spillPath);
  assert.equal(spilled.length, 300 * 1024);
  await rm(spillPath, { force: true });
});

test('browser_wait_for gives the bridge enough time to finish the requested wait window', async () => {
  let seenTimeout: number | undefined;
  const tools = createReadOnlyBrowserToolMap(createBrokerHarness(async (type, params, options) => {
    assert.equal(type, 'browser_wait_for');
    seenTimeout = options?.timeoutMs;
    assert.deepEqual(params, { selector: '#ready', timeout_ms: 40_000 });
    return {
      ok: true,
      id: 'req-3',
      kind: 'response',
      v: 1,
      data: {
        status: 'matched',
        matched: { selector: '#ready' },
      },
    };
  }));

  const result = await tools.get('browser_wait_for')!.execute('call-1', { selector: '#ready', timeout_ms: 40_000 });
  assert.equal(result.details.ok, true);
  assert.equal(seenTimeout, 41_500);
  assert.match(textOf(result), /matched/);
});

test('bridge transport failures become structured tool results', async () => {
  const tools = createReadOnlyBrowserToolMap({
    probeConnectivity() {
      return { brokerListening: true, bridgeConnected: true, url: 'ws://127.0.0.1:7777' };
    },
    async request() {
      throw Object.assign(new Error('boom'), { code: 'E_TIMEOUT', details: { timeoutMs: 1000 } });
    },
  } as any);

  const result = await tools.get('browser_get_performance_metrics')!.execute('call-1', {});
  assert.equal(result.details.ok, false);
  assert.equal((result.details.error as any).code, 'E_TIMEOUT');
  assert.match(textOf(result), /failed: boom/);
});

test('plain broker timeout errors are surfaced as E_TIMEOUT instead of bridge disconnects', async () => {
  const tools = createReadOnlyBrowserToolMap({
    probeConnectivity() {
      return { brokerListening: true, bridgeConnected: true, url: 'ws://127.0.0.1:7777' };
    },
    async request() {
      throw new Error('Request timed out: browser_get_html');
    },
  } as any);

  const result = await tools.get('browser_get_html')!.execute('call-1', {});
  assert.equal(result.details.ok, false);
  assert.equal((result.details.error as any).code, 'E_TIMEOUT');
});


test('browser_get_html rejects malformed success payloads without html/content', async () => {
  const tools = createReadOnlyBrowserToolMap(createBrokerHarness(async () => ({
    ok: true,
    id: 'req-h',
    kind: 'response',
    v: 1,
    data: { url: 'https://example.com' },
  })));

  const result = await tools.get('browser_get_html')!.execute('call-1', {});
  assert.equal(result.details.ok, false);
  assert.equal((result.details.error as any).code, 'E_PROTOCOL');
  assert.match(textOf(result), /did not include html/i);
});

test('browser_get_screenshot rejects malformed success payloads without image data', async () => {
  const tools = createReadOnlyBrowserToolMap(createBrokerHarness(async () => ({
    ok: true,
    id: 'req-4',
    kind: 'response',
    v: 1,
    data: {
      mime: 'image/jpeg',
      title: 'Broken screenshot',
    },
  })));

  const result = await tools.get('browser_get_screenshot')!.execute('call-1', {});
  assert.equal(result.details.ok, false);
  assert.equal((result.details.error as any).code, 'E_INTERNAL');
  assert.match(textOf(result), /did not include image data/);
});


test('browser_get_performance_metrics uses a longer timeout when web vitals are requested', async () => {
  let seenTimeout: number | undefined;
  const tools = createReadOnlyBrowserToolMap(createBrokerHarness(async (_type, _params, options) => {
    seenTimeout = options?.timeoutMs;
    return {
      ok: true,
      id: 'req-5',
      kind: 'response',
      v: 1,
      data: { web_vitals: { lcp: 1000 } },
    };
  }));

  const result = await tools.get('browser_get_performance_metrics')!.execute('call-1', { include: ['web_vitals'] });
  assert.equal(result.details.ok, true);
  assert.equal(seenTimeout, 27_500);
});


test('browser_list_tabs normalizes wrapped bridge payloads', async () => {
  const tools = createReadOnlyBrowserToolMap(createBrokerHarness(async () => ({
    ok: true,
    id: 'req-6',
    kind: 'response',
    v: 1,
    data: {
      tabs: [
        { tabId: 11, title: 'One', url: 'https://one.test', active: false, pinned: false, is_agent_tab: false },
        { tabId: 12, title: 'Agent', url: 'chrome://newtab/', active: true, pinned: true, is_agent_tab: true },
      ],
    },
  })));

  const result = await tools.get('browser_list_tabs')!.execute('call-1', {});
  assert.equal(result.details.ok, true);
  assert.equal((result.details.result as any[]).length, 2);
  assert.equal((result.details.result as any[])[1].is_agent_tab, true);
  assert.match(textOf(result), /Open browser tabs/);
});

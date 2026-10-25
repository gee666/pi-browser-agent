import assert from 'node:assert/strict';
import test from 'node:test';
import { Type, type TSchema } from 'typebox';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/broker/task-store.ts';
import { Value } from 'typebox/value';
import { withNativeResult } from '../src/tools/native-result.ts';
import { registerAllTools, resetRegisteredBrowserTools } from '../src/tools/_register.ts';
import { BrowserAgentBroker } from '../src/broker/server.ts';

for (const details of [
  { ok: true, tabs: [{ id: 17 }], optional: undefined },
  { ok: false, error: { code: 'E_BRIDGE_DISCONNECTED', message: 'offline' } },
  { ok: true, success: false, status: 'rejected' },
  { success: true, status: 'done', history: [{ type: 'started' }, { type: 'finished' }] },
]) {
  test(`native result preserves content/details and reports ${JSON.stringify(details)}`, async () => {
    const content = [{ type: 'text' as const, text: 'legacy output' },
      { type: 'image' as const, data: 'c2VudGluZWw=', mimeType: 'image/png' }];
    const tool = withNativeResult({ name: 'sentinel', label: 'sentinel', description: 'sentinel',
      parameters: Type.Object({}), async execute() { return { content, details }; } });
    // execute's context is unused by this fixture, just like existing browser builders.
    const result = await Reflect.apply(tool.execute, undefined, ['call', {}, undefined]);
    assert.equal(result.content, content);
    assert.equal(result.details, details);
    assert.deepEqual(result.structuredContent, JSON.parse(JSON.stringify(details)));
    assert.equal(result.isError, details.ok === false || details.success === false);
    assert.ok(tool.outputSchema && Value.Check(tool.outputSchema, result.structuredContent));
    assert.equal(Object.hasOwn(details, 'optional'), Object.hasOwn(result.details, 'optional'));
  });
}

test('native result forwards cancellation, updates and context and preserves explicit errors', async () => {
  let received: unknown[] = [];
  const tool = withNativeResult({ name: 'forward', label: 'forward', description: 'forward',
    parameters: Type.Object({}), async execute(...args) {
      received = args;
      return { content: [{ type: 'text', text: 'error' }], details: {}, isError: true };
    } });
  const controller = new AbortController();
  const update = () => {};
  const context = { sentinel: 'context' };
  const args = ['call', {}, controller.signal, update, context];
  const result = await Reflect.apply(tool.execute, undefined, args);
  assert.deepEqual(received, args);
  assert.equal(result.isError, true);
});

test('every registered browser implementation declares native output and preserves offline diagnostics', async () => {
  resetRegisteredBrowserTools();
  const tools: { name: string; outputSchema?: TSchema; execute: unknown }[] = [];
  const dir = await mkdtemp(join(tmpdir(), 'ba-native-result-'));
  const broker = new BrowserAgentBroker({ port: 0, taskStore: new TaskStore({ dir }) });
  try {
    registerAllTools({ registerTool(tool) { tools.push(tool); } }, { broker });
    assert.equal(tools.length, 22);
    assert.ok(tools.every((tool) => tool.outputSchema), 'no family may miss the registration adapter');
    for (const name of ['browser_list_tabs', 'browser_get_html', 'browser_get_console_logs', 'browser_run_task']) {
      const tool = tools.find((item) => item.name === name);
      assert.ok(tool && typeof tool.execute === 'function');
      const result = await Reflect.apply(tool.execute, undefined, ['call', { task: 'sentinel' }, undefined]);
      assert.equal(result.isError, true, name);
      assert.deepEqual(result.structuredContent, JSON.parse(JSON.stringify(result.details)), name);
      assert.match(JSON.stringify(result.content), /bridge|broker/i);
    }
  } finally {
    await broker.stop();
    resetRegisteredBrowserTools();
    await rm(dir, { recursive: true, force: true });
  }
});

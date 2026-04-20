import test from 'node:test';
import assert from 'node:assert/strict';

import { resetRegisteredBrowserTools } from '../../src/tools/_register.ts';
import { createBrowserAgentToolsTool, resetBrowserAgentToolState } from '../../src/tools/browser_agent_tools.ts';

function createFakePi() {
  const tools = new Map<string, any>();
  return {
    tools,
    registerTool(tool: any) {
      if (!tools.has(tool.name)) {
        tools.set(tool.name, tool);
      }
    },
  };
}

function textOf(result: any): string {
  return result.content[0].text;
}

test('meta-tool does not register browser tools when broker is offline', async () => {
  resetBrowserAgentToolState();
  resetRegisteredBrowserTools();
  const pi = createFakePi();
  const tool = createBrowserAgentToolsTool(pi, {
    probeConnectivity() {
      return {
        brokerReachable: false,
        brokerListening: false,
        bridgeConnected: false,
        startupError: 'port busy',
        url: 'ws://127.0.0.1:7878',
      };
    },
  } as any);

  const result = await tool.execute('call-1', {});
  assert.match(textOf(result), /not available/i);
  assert.equal(tool.name, 'activate_browser_agent_tools');
  assert.doesNotMatch(tool.description, /browser_run_task|browser_get_html|browser_get_network/i);
  assert.equal(pi.tools.size, 0);
});

test('meta-tool does not register browser tools when broker is online but bridge is absent', async () => {
  resetBrowserAgentToolState();
  resetRegisteredBrowserTools();
  const pi = createFakePi();
  const tool = createBrowserAgentToolsTool(pi, {
    probeConnectivity() {
      return {
        brokerReachable: true,
        brokerListening: true,
        bridgeConnected: false,
        url: 'ws://127.0.0.1:7878',
      };
    },
  } as any);

  const result = await tool.execute('call-1', {});
  assert.match(textOf(result), /bridge is not connected/i);
  assert.equal(pi.tools.size, 0);
});

test('meta-tool lazily registers placeholder browser tools once and is idempotent', async () => {
  resetBrowserAgentToolState();
  resetRegisteredBrowserTools();
  const pi = createFakePi();
  let probes = 0;
  const tool = createBrowserAgentToolsTool(pi, {
    probeConnectivity() {
      probes += 1;
      return {
        brokerReachable: true,
        brokerListening: true,
        bridgeConnected: true,
        bridgeVersion: '0.1.0',
        capabilities: ['probe'],
        url: 'ws://127.0.0.1:7878',
      };
    },
  } as any);

  const first = await tool.execute('call-1', {});
  assert.match(textOf(first), /tools are now registered/i);
  assert.match(textOf(first), /Available browser_\* tools:/i);
  assert.match(textOf(first), /direct pi tools, not mcp tool, invoke them directly/i);
  assert.equal(pi.tools.has('browser_run_task'), true);
  const countAfterFirst = pi.tools.size;
  assert.ok(countAfterFirst >= 20);

  const second = await tool.execute('call-2', {});
  assert.match(textOf(second), /already registered/i);
  assert.equal(pi.tools.size, countAfterFirst);

  const third = await tool.execute('call-3', { force_refresh: true });
  assert.match(textOf(third), /already registered/i);
  assert.equal(pi.tools.size, countAfterFirst);
  assert.equal(probes, 3);
  assert.ok(Array.isArray(first.details.registeredTools));
  assert.ok(first.details.registeredTools.includes('browser_run_task'));
});

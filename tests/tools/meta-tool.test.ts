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

test('meta-tool reports broker-offline status accurately and does not register any tools itself', async () => {
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
  const text = textOf(result);
  assert.match(text, /E_BRIDGE_DISCONNECTED/);
  assert.match(text, /could not be reached/i);
  assert.match(text, /port busy/);
  // The failure report must be self-service actionable, not a dead end.
  assert.match(text, /Self-service recovery/i);
  assert.match(text, /activate_browser_agent_tools/);
  assert.match(text, /TELL THE USER/i);
  assert.equal((result.details as any).diagnostics.kind, 'broker_unreachable');
  assert.ok(Array.isArray((result.details as any).diagnostics.remediation));
  assert.equal(tool.name, 'activate_browser_agent_tools');
  assert.doesNotMatch(tool.description, /browser_run_task|browser_get_html|browser_get_network/i);
  // The meta-tool never registers tools; registration happens at session_start.
  assert.equal(pi.tools.size, 0);
});

test('meta-tool reports bridge-absent status accurately; registration is the session_start handler’s job, not the meta-tool’s', async () => {
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
  const text = textOf(result);
  assert.match(text, /Chrome extension bridge has never connected/i);
  assert.match(text, /Self-service recovery/i);
  assert.equal((result.details as any).diagnostics.kind, 'bridge_never_connected');
  // Broker listening alone is now enough for session_start to register the
  // suite, because tools return structured errors when the bridge is absent.
  // The meta-tool itself never registers tools.
  assert.equal(pi.tools.size, 0);
});

test('meta-tool reports ready status when broker + bridge are healthy and remains idempotent across calls', async () => {
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
        bridgeEverConnected: true,
        role: 'primary' as const,
      };
    },
  } as any);

  const first = await tool.execute('call-1', {});
  assert.match(textOf(first), /tools are registered/i);
  assert.match(textOf(first), /Available browser_\* tools:/i);
  assert.match(textOf(first), /direct pi tools, not mcp tool, invoke them directly/i);
  // The meta-tool itself no longer registers tools; that happens at session_start.
  assert.equal(pi.tools.size, 0);

  const second = await tool.execute('call-2', {});
  assert.match(textOf(second), /tools are registered/i);
  assert.equal(pi.tools.size, 0);

  // The meta-tool exposes no refresh parameter: repeated calls remain idempotent.
  const thirdParamProps = (tool.parameters as any).properties || {};
  assert.equal('force_refresh' in thirdParamProps, false);
  const third = await tool.execute('call-3', {});
  assert.match(textOf(third), /tools are registered/i);
  assert.equal(pi.tools.size, 0);
  assert.equal(probes, 3);
  assert.ok(Array.isArray(first.details.registeredTools));
  assert.ok(first.details.registeredTools.includes('browser_run_task'));
  assert.ok(third.details.registeredTools.includes('browser_run_task'));
});

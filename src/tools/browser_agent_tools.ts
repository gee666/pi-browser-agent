import { Type } from '@sinclair/typebox';

import type { BrowserAgentBroker } from '../broker/server.ts';
import { formatBridgeFailure } from '../broker/diagnostics.ts';
import { getPlaceholderBrowserToolSpecs } from './_register.ts';

export function resetBrowserAgentToolState(): void {
  // No-op retained for API compatibility. Browser tool registration is now
  // performed eagerly at session_start in src/index.ts, so the meta-tool no
  // longer owns any first-call registration state.
}

function buildSuccessMessage(probe: ReturnType<BrowserAgentBroker['probeConnectivity']>): string {
  const lines = [
    'Browser agent is available. Browser tools are registered for this session.',
    'These are direct pi tools, not MCP tool, invoke them directly in this session.',
    '',
    'Available browser_* tools:',
    ...getPlaceholderBrowserToolSpecs().map((tool) => `- ${tool.name} — ${tool.description}`),
  ];

  const health: string[] = [];
  if (probe.bridgeVersion) health.push(`bridge version ${probe.bridgeVersion}`);
  if (probe.role) health.push(`broker role ${probe.role}`);
  if (probe.url) health.push(`broker ${probe.url}`);
  if (probe.lastBridgeDisconnectedAt) {
    health.push(`last bridge drop ${probe.lastBridgeDisconnectedAt}${probe.lastBridgeDisconnectReason ? ` (${probe.lastBridgeDisconnectReason})` : ''}`);
  }
  if (health.length > 0) {
    lines.push('', `Health: ${health.join('; ')}.`);
  }

  return lines.join('\n');
}

export function createBrowserAgentToolsTool(
  _pi: { registerTool: (tool: any) => void },
  broker: BrowserAgentBroker,
  { managed = true }: { managed?: boolean } = {},
) {
  return {
    name: 'activate_browser_agent_tools',
    label: 'Activate Browser Agent Tools',
    description:
      'Diagnose and repair the browser integration. Forces a lazy re-acquire of the broker port (promoting this pi process to primary if the previous owner died) and waits for the Chrome extension bridge to reconnect. Call this whenever a browser_* tool reports E_BRIDGE_DISCONNECTED; it returns the full connectivity state plus recovery steps.',
    promptSnippet: 'Diagnose and repair the browser integration for this session.',
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: Record<string, unknown>) {
      // Lazily (re)acquire the broker so a killed primary is replaced on demand
      // when someone actually asks for the browser tools. Only do this for the
      // lifecycle-managed singleton — never for the throwaway fallback broker,
      // which is not tracked for shutdown and must not leak a listener.
      if (managed) {
        await broker.ensureReady?.();
      }
      const probe = broker.probeConnectivity();
      if (!probe.brokerReachable || !probe.brokerListening || !probe.bridgeConnected) {
        const { text, diagnostics } = formatBridgeFailure(probe, 'activate_browser_agent_tools');
        return {
          content: [{ type: 'text', text }],
          details: { ok: false, probe, diagnostics },
        };
      }

      // Idempotent status report. Browser tools are registered at session_start
      // in src/index.ts; this tool no longer performs any registration.
      return {
        content: [{ type: 'text', text: buildSuccessMessage(probe) }],
        details: { probe, registeredTools: getPlaceholderBrowserToolSpecs().map((tool) => tool.name) },
      };
    },
  };
}

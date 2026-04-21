import { Type } from '@sinclair/typebox';

import type { BrowserAgentBroker } from '../broker/server.ts';
import { getPlaceholderBrowserToolSpecs } from './_register.ts';

export function resetBrowserAgentToolState(): void {
  // No-op retained for API compatibility. Browser tool registration is now
  // performed eagerly at session_start in src/index.ts, so the meta-tool no
  // longer owns any first-call registration state.
}

function buildFailureMessage(reason: string, probe: ReturnType<BrowserAgentBroker['probeConnectivity']>): string {
  return [
    `Browser integration is not available. Reason: ${reason}.`,
    '',
    'To fix:',
    `  1. Make sure the pi-browser-agent broker is running on ${probe.url || 'ws://127.0.0.1:7878'}.`,
    '  2. Load or reload the browser-agent-ext Chrome extension.',
    '  3. In the extension options, enable the pi bridge and point it at the broker URL.',
    '  4. Retry activate_browser_agent_tools after the broker and bridge are healthy.',
  ].join('\n');
}

function buildSuccessMessage(probe: ReturnType<BrowserAgentBroker['probeConnectivity']>): string {
  const lines = [
    'Browser agent is available. Browser tools are registered for this session.',
    'These are direct pi tools, not MCP tool, invoke them directly in this session.',
    '',
    'Available browser_* tools:',
    ...getPlaceholderBrowserToolSpecs().map((tool) => `- ${tool.name} — ${tool.description}`),
  ];

  if (probe.bridgeVersion) {
    lines.push('', `Bridge version: ${probe.bridgeVersion}`);
  }

  return lines.join('\n');
}

export function createBrowserAgentToolsTool(_pi: { registerTool: (tool: any) => void }, broker: BrowserAgentBroker) {
  return {
    name: 'activate_browser_agent_tools',
    label: 'Activate Browser Agent Tools',
    description:
      'Self-check for the browser integration. The browser_* tool suite is registered at session start; this tool reports current broker/bridge status.',
    promptSnippet: 'Check the browser integration status for this session.',
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: Record<string, unknown>) {
      const probe = broker.probeConnectivity();
      if (!probe.brokerReachable || !probe.brokerListening) {
        return {
          content: [{ type: 'text', text: buildFailureMessage(probe.startupError || 'broker is not listening', probe) }],
          details: { probe },
        };
      }

      if (!probe.bridgeConnected) {
        return {
          content: [{ type: 'text', text: buildFailureMessage('Chrome extension bridge is not connected', probe) }],
          details: { probe },
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

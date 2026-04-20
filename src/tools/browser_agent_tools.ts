import { Type } from '@sinclair/typebox';

import type { BrowserAgentBroker } from '../broker/server.ts';
import { getPlaceholderBrowserToolSpecs, registerAllTools } from './_register.ts';

let browserToolsRegistered = false;

export function resetBrowserAgentToolState(): void {
  browserToolsRegistered = false;
}

export function setBrowserAgentToolState(value: boolean): void {
  browserToolsRegistered = value;
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

function buildSuccessMessage(newlyRegistered: string[], probe: ReturnType<BrowserAgentBroker['probeConnectivity']>): string {
  const lines = [
    browserToolsRegistered && newlyRegistered.length === 0
      ? 'Browser agent is available. Browser tools were already registered for this session.'
      : 'Browser agent is available and browser tools are now registered.',
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

export function createBrowserAgentToolsTool(pi: { registerTool: (tool: any) => void }, broker: BrowserAgentBroker) {
  return {
    name: 'activate_browser_agent_tools',
    label: 'Activate Browser Agent Tools',
    description:
      'A browser integration is available for this session. Call this tool to activate it and register the browser tools dynamically.',
    promptSnippet: 'Activate the browser integration for this session.',
    parameters: Type.Object({
      force_refresh: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_toolCallId: string, params: { force_refresh?: boolean }) {
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

      const shouldRegister = !browserToolsRegistered || params.force_refresh;
      const newlyRegistered = shouldRegister ? registerAllTools(pi, { broker }) : [];
      browserToolsRegistered = true;

      return {
        content: [{ type: 'text', text: buildSuccessMessage(newlyRegistered, probe) }],
        details: { probe, registeredTools: getPlaceholderBrowserToolSpecs().map((tool) => tool.name) },
      };
    },
  };
}

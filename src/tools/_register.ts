import { Type } from '@sinclair/typebox';

import type { BrowserAgentBroker } from '../broker/server.ts';
import {
  createBrowserGetTaskHistoryTool,
  createBrowserListTasksTool,
  createBrowserRunTaskTool,
} from './browser_task_tools.ts';
import { createBufferedObservabilityToolDefinitions } from './browser_observability_tools.ts';
import { createBrowserJsNavigationToolFamily } from './browser_js_navigation_tools.ts';
import { createReadOnlyBrowserTools } from './read_only/index.ts';

const PLACEHOLDER_TOOL_SPECS = [
  ['browser_run_task', 'Run a browser task end-to-end.'],
  ['browser_get_task_history', 'Read stored browser task history.'],
  ['browser_list_tasks', 'List recent browser tasks.'],
  ['browser_get_screenshot', 'Capture a browser screenshot.'],
  ['browser_get_html', 'Read browser HTML.'],
  ['browser_get_dom_info', 'Inspect DOM details for matching elements.'],
  ['browser_get_computed_styles', 'Read computed CSS styles.'],
  ['browser_get_console_logs', 'Read console logs from the browser.'],
  ['browser_get_network', 'Inspect network requests from the browser.'],
  ['browser_get_accessibility_tree', 'Read the accessibility tree.'],
  ['browser_get_performance_metrics', 'Read performance metrics.'],
  ['browser_evaluate_js', 'Evaluate a JavaScript expression in the page.'],
  ['browser_run_js', 'Run longer JavaScript in the page.'],
  ['browser_list_tabs', 'List browser tabs.'],
  ['browser_switch_tab', 'Switch to a browser tab.'],
  ['browser_close_tab', 'Close a browser tab.'],
  ['browser_navigate', 'Navigate a browser tab to a URL.'],
  ['browser_reload', 'Reload a browser tab.'],
  ['browser_reload_extension', 'Reload the browser-agent-ext extension itself.'],
  ['browser_wait_for', 'Wait for a page condition.'],
  ['browser_clear_site_data', 'Clear site data for an origin.'],
] as const;

let registeredToolNames = new Set<string>();

export function resetRegisteredBrowserTools(): void {
  registeredToolNames = new Set();
}

export function getRegisteredBrowserToolNames(): string[] {
  return [...registeredToolNames];
}

export function getPlaceholderBrowserToolSpecs(): Array<{ name: string; description: string }> {
  return PLACEHOLDER_TOOL_SPECS.map(([name, description]) => ({ name, description }));
}

export function registerAllTools(pi: { registerTool: (tool: any) => void }, { broker }: { broker: BrowserAgentBroker }) {
  const newlyRegistered: string[] = [];
  const realTools = new Map<string, any>([
    ['browser_run_task', createBrowserRunTaskTool(broker)],
    ['browser_get_task_history', createBrowserGetTaskHistoryTool(broker)],
    ['browser_list_tasks', createBrowserListTasksTool(broker)],
    ...createReadOnlyBrowserTools(broker).map((tool) => [tool.name, tool] as const),
    ...Object.entries(createBufferedObservabilityToolDefinitions(broker)),
    ...createBrowserJsNavigationToolFamily(broker).map((tool) => [tool.name, tool] as const),
  ]);

  for (const [name, description] of PLACEHOLDER_TOOL_SPECS) {
    if (registeredToolNames.has(name)) {
      continue;
    }

    pi.registerTool(
      realTools.get(name) ?? {
        name,
        label: name,
        description: `${description} This tool was expected to be registered but no implementation was found.`,
        promptSnippet: description,
        parameters: Type.Object({}, { additionalProperties: true }),
        async execute() {
          const probe = broker.probeConnectivity();
          return {
            content: [{ type: 'text', text: `${name} is unavailable because its implementation was not registered.` }],
            details: { probe, ok: false, error: { code: 'E_INTERNAL', message: `${name} implementation missing` } },
          };
        },
      },
    );

    registeredToolNames.add(name);
    newlyRegistered.push(name);
  }

  return newlyRegistered;
}

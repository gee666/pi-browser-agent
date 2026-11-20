import { Type } from 'typebox';

/**
 * Every tool that acts on a tab needs an explicit tab id. The extension never
 * falls back to the active tab or to a tab matched by URL: that is how an
 * unrelated tab (e.g. a chat app the user is working in) gets navigated.
 */
const TAB_TARGETED_TOOLS = new Set([
  'browser_run_task',
  'browser_get_screenshot',
  'browser_get_html',
  'browser_get_dom_info',
  'browser_get_computed_styles',
  'browser_get_console_logs',
  'browser_get_network',
  'browser_get_accessibility_tree',
  'browser_get_performance_metrics',
  'browser_run_js',
  'browser_navigate',
  'browser_switch_tab',
  'browser_close_tab',
  'browser_reload',
  'browser_wait_for',
  'browser_clear_site_data',
]);

/** Tools whose `url` is a destination or an origin to act on, not a way to pick a tab. */
const URL_ALLOWED_TOOLS = new Set(['browser_navigate', 'browser_clear_site_data']);

export const tabIdSchema = () => Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
  description: 'Id of the tab to act on, from browser_create_tab or browser_list_tabs. Required.',
});

export class TabTargetError extends Error {
  readonly code = 'E_INVALID_ARGS';
}

/** Throws unless a tab-targeting call names its tab explicitly and unambiguously. */
export function assertExplicitTabTarget(tool: string, params: unknown): void {
  if (!TAB_TARGETED_TOOLS.has(tool)) return;
  const input = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  const tabId = input.tab_id;
  if (typeof tabId !== 'number' || !Number.isSafeInteger(tabId) || tabId < 1) {
    throw new TabTargetError(
      `${tool} requires an explicit positive integer tab_id. Create a tab with browser_create_tab or pick one from browser_list_tabs; the active tab is never used implicitly.`,
    );
  }
  if ('use_active_tab' in input) {
    throw new TabTargetError(`${tool} does not support use_active_tab; pass tab_id instead.`);
  }
  if ('url' in input && !URL_ALLOWED_TOOLS.has(tool)) {
    throw new TabTargetError(`${tool} does not select tabs by url; pass tab_id instead.`);
  }
}

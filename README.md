# pi-browser-agent

`pi-browser-agent` is a pi extension that starts a local WebSocket broker and lazily registers a browser-driving tool suite for `browser-agent-ext`.

## What it does

- starts a loopback-only broker on `ws://127.0.0.1:7878` by default
- exposes one lightweight meta-tool first: `activate_browser_agent_tools`
- registers the full `browser_*` tool suite only after the Chrome bridge is reachable
- forwards tool calls to `browser-agent-ext`
- keeps browser-task history on disk for local inspection

## Install

Add the extension to pi from this repo checkout or package it as an npm pi extension.

### Local checkout

```json
{
  "extensions": ["./pi-browser-agent/src/index.ts"]
}
```

### npm package form

When this package is published, the install shape is:

```bash
pi install npm:oira666_pi-browser-agent
```

For the current in-repo state, use the local-checkout form above.

## Runtime requirements

1. A pi session with this extension enabled.
2. Chrome with `browser-agent-ext` loaded unpacked.
3. In the extension options, **Enable pi bridge** must be on.
4. The bridge URL must point at the broker, usually `ws://127.0.0.1:7878`.

## First use in a pi session

Call:

```text
activate_browser_agent_tools
```

That meta-tool checks connectivity and then registers the full toolkit for the session:

- `browser_run_task`
- `browser_get_task_history`
- `browser_list_tasks`
- `browser_get_screenshot`
- `browser_get_html`
- `browser_get_dom_info`
- `browser_get_computed_styles`
- `browser_get_console_logs`
- `browser_get_network`
- `browser_get_accessibility_tree`
- `browser_get_performance_metrics`
- `browser_evaluate_js`
- `browser_run_js`
- `browser_list_tabs`
- `browser_switch_tab`
- `browser_close_tab`
- `browser_navigate`
- `browser_reload`
- `browser_wait_for`
- `browser_clear_site_data`

## Configuration

Environment variables:

- `PI_BA_HOST` — broker bind host, default `127.0.0.1`
- `PI_BA_PORT` — broker port, default `7878`
- `PI_BA_TASK_TTL_DAYS` — task-history retention

If port `7878` is busy, the broker fails fast and asks you to set `PI_BA_PORT`.

## WSL → Windows Chrome

Loopback usually works with modern WSL setups. If your Windows Chrome cannot reach the broker on `127.0.0.1`:

1. start pi with `PI_BA_HOST=0.0.0.0`
2. find the WSL IP
3. set the extension bridge URL to `ws://<wsl-ip>:7878`

Example:

```bash
PI_BA_HOST=0.0.0.0 pi
```

## Notes

- The broker never synthesizes browser input. Browser actions still go through the extension runtime and its configured input backend.
- Large text results are truncated and the full payload is spilled to a temp file.
- Large screenshots are spilled to a temp file instead of being inlined.

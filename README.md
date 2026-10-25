# pi-browser-agent

Tested against Pi 1.4.0

`pi-browser-agent` is a pi extension that starts a local WebSocket broker and registers a browser-driving tool suite for `browser-agent-ext`.

## What it does

- starts a loopback-only broker on `ws://127.0.0.1:7878` by default
- registers the full `browser_*` tool suite at session start, even while the broker or bridge is unavailable
- exposes `activate_browser_agent_tools` as a self-check / status tool
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

All `browser_*` tools are registered at session start independently of broker availability. `activate_browser_agent_tools` remains available as a self-check / status tool:

```text
activate_browser_agent_tools
```

The full toolkit registered for the session is:

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
- `browser_create_tab`
- `browser_list_tabs`
- `browser_switch_tab`
- `browser_close_tab`
- `browser_navigate`
- `browser_reload`
- `browser_reload_extension`
- `browser_wait_for`
- `browser_clear_site_data`

## Configuration

Environment variables:

- `PI_BA_HOST` — broker bind host, default `127.0.0.1`
- `PI_BA_PORT` — broker port, default `7878`
- `PI_BA_TASK_TTL_DAYS` — task-history retention

If another pi instance owns port `7878`, this session connects through it. If acquisition fails, the extension retries in the background.

## Connection status

The status line shows `browser: connected`, `browser: recovering`, or `browser: disconnected`. Transient disconnects and successful recovery do not produce notifications. After 60 seconds without a connection, the extension shows one short warning for that outage and continues retrying quietly. Broker logs and stack traces are not forwarded to the TUI. Use `activate_browser_agent_tools` for on-demand diagnostics.

## WSL → Windows Chrome

Loopback usually works with modern WSL setups. If your Windows Chrome cannot reach the broker on `127.0.0.1`:

1. start pi with `PI_BA_HOST=0.0.0.0`
2. find the WSL IP
3. set the extension bridge URL to `ws://<wsl-ip>:7878`

Example:

```bash
PI_BA_HOST=0.0.0.0 pi
```

## Development and release checks

Run `npm ci --ignore-scripts` to install the locked development dependencies, then `npm test` to typecheck and run the suite. The Pi SDK development dependency is pinned to the tested release; tests do not update the manifest or lockfile.

The tests include SDK extension loading, local broker lifecycle checks, and browser-tool protocol tests. `npm run typecheck` checks the currently installed dependencies. Registered tools retain their text/image output and persisted details, and additionally expose JSON-normalized details through Pi's `outputSchema`/`structuredContent` APIs. Failed browser operations set `isError: true` so Pi and programmatic callers can distinguish failures without parsing text.

Also run `PI_EVERGREEN_PI_BIN=/absolute/path/to/global/pi npm run test:e2e`. This explicitly loads the local extension into that real Pi CLI, using an isolated agent directory, a deterministic local OpenAI-compatible SSE endpoint and a WebSocket bridge fixture (no credentials or model charges). It checks actual outbound requests, tool execution, retry/abort recovery, compaction, reload with a connected bridge, persistent task history, session replacement and cleanup. Linux also exercises real suspend/resume. `PI_EVERGREEN_E2E_PROVIDER`, `PI_EVERGREEN_E2E_MODEL` and `PI_EVERGREEN_E2E_REASONING` select the test model identity (defaults: `openai`, `gpt-6-luna`, `medium`). These tests do not replace a live Chrome end-to-end check.

Before every release, update the tested-against line above to the actual Pi version that passed the checks, and keep the supported Pi peer range in `package.json` accurate. See `AGENTS.md` for the release and code quality rules.

## Notes

- The broker never synthesizes browser input. Browser actions still go through the extension runtime and its configured input backend.
- Large text results are truncated and the full payload is spilled to a temp file.
- Large screenshots are spilled to a temp file instead of being inlined.

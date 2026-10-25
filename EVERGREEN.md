## Summary
- Bridge Pi browser tools to Chrome's `browser-agent-ext`; do not synthesize input locally.
- Register the whole toolkit even when Chrome or broker startup is unavailable.
- Share one primary broker across Pi processes, recover quietly, and retain task history.
- Pi touchpoints: extension entry point, session lifecycle, tools/results and UI status.
- No internal or undocumented Pi APIs are used by runtime code.
- Main risks: bridge protocol drift, lifecycle races, model/tool schema changes and payload size.

## Intent
Provide browser automation and inspection from Pi without making every Pi process
own a Chrome connection. The primary forwards operations to the external browser
extension; secondaries proxy through it and can promote after it exits. Lazy tool
handles recover without requiring a session restart. Task history lives outside
Pi sessions so it remains inspectable after session or process replacement.
Disconnected startup must not hide tools or flood the TUI with logs.

## Pi integration (public APIs)
`package.json` loads `src/index.ts` through `pi.extensions`. Runtime imports the
public `ExtensionAPI` and `ToolDefinition` types from the package root.
`pi.on('session_start')` registers tools and acquires the broker;
`session_shutdown` releases sockets, timers, handles and signal listeners.
`pi.registerTool` uses TypeBox parameters, execute's AbortSignal, text/image
content, persisted details, outputSchema, structuredContent and isError.
`ctx.ui.setStatus` and `notify` report connectivity with delayed outage warnings.
The host TypeBox peer dependency must remain compatible with Pi's validator.
## Internal Pi APIs
None in runtime code: no deep imports, private fields or undocumented Pi hooks.
The compatibility test uses the exported `discoverAndLoadExtensions` loader.
POSIX suspend/resume handlers and the WebSocket protocol are extension-owned,
not Pi APIs. Historical commits mentioning internal image shapes now correspond
to Pi's public image content contract.

## Weak points
Chrome/MV3 connection lifetime, hello/probe/proxy compatibility and primary
promotion are external boundaries. Shutdown, suspend and reload can race startup.
Image/text limits, spilled files and JSON normalization must preserve usable output.
Real Chrome/input-backend behavior is not covered by the automated bridge fixture.
CLI E2E uses stdin-ignored JSON runs, not interactive reload/compaction or RPC abort;
unit/lifecycle tests cover those underlying broker cancellation and teardown paths.
Live E2E needs credentials for EVERGREEN_E2E_MODEL and may fail on provider outages.

## Tests
`npm run test:evergreen` runs typechecking, unit, integration and E2E checks.
Existing unit suites cover readiness/recovery, cancellation, health warnings,
promotion, shutdown races, schemas, screenshot output and truncation.
`tests/integration/intent.test.ts` protects task execution through the real proxy,
primary and bridge chain, failure classification and history after store restart.
`tests/pi-cli.e2e.ts` runs EVERGREEN_PI_BIN (fallback: pi on PATH), stdin ignored.
A local SSE fixture checks all declarations in provider-bound requests, actual
bridge task execution, result/error persistence, cross-process history and cleanup.
A live EVERGREEN_E2E_MODEL call must discover and execute browser_list_tasks even
without Chrome. Settings/state are isolated; provider credentials are reused.
These tests protect available tools, working forwarding and durable inspection,
not merely individual helper outputs. Tested against latest Pi 1.4.0.

## Relevant changelog topics
Watch extension lifecycle/reload, tool registration and execution signatures,
AbortSignal propagation, TypeBox validation, text/image result formats,
outputSchema/structuredContent/isError, session serialization, UI status APIs,
CLI JSON events, provider transport and SDK extension loading.

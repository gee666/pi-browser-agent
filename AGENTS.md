# Project instructions

## Pi compatibility and releases

- Test only against the latest stable Pi release from npm. Do not add a minimum-version test matrix or rely on stale installed dependencies.
- Run `npm test` before every release. Its `pretest` refreshes `@earendil-works/pi-coding-agent` from npm `latest` and runs strict TypeScript checks. The suite includes loading this extension through the installed Pi host, broker tests, and tool tests.
- After successful checks, add or update the standalone README line `Tested against Pi <version>` using the actual installed coding-agent version. Update this line on every release and commit it with the release. Never claim a version that was not tested.
- Declare host-provided Pi libraries in `peerDependencies`, not `dependencies`. Keep supported Pi version ranges in `package.json` accurate and development dependencies and the lockfile aligned with the tested version.
- Keep this root `AGENTS.md` tracked and committed. Do not bump versions, publish, or push releases unless requested.

## Browser input boundary

- Follow the parent project's native-input policy. All actual browser input must go through `python-input-control`. This Pi extension forwards requests to the Chrome extension; it must not bypass that executor with synthetic DOM events or direct DOM mutations.
- Surface executor errors. Do not fall back to `element.click()`, `dispatchEvent()`, assignment to input values, or JavaScript scrolling.

## Code quality bar

- Remove dead code, unused imports, and unused dependencies. Wire intended functionality into the extension instead of leaving disconnected code.
- Keep Pi registration, WebSocket transport, broker lifecycle, protocol validation, task storage, and tool implementations separate. Follow existing Node.js, strict TypeScript, `ws`, and Pi API conventions.
- Avoid duplicated logic and unnecessary abstractions. Prefer simple, consistent solutions over one-off patterns.
- Fix root causes, not symptoms. Avoid brittle workarounds. Make deployment-specific ports, paths, timeouts, and operational settings configurable. Never hardcode secrets or leak sensitive browser data in logs. Keep loopback binding as the default.
- Use strict TypeScript and types that model valid application states. Validate bridge messages, tool arguments, and other external data at runtime. Do not introduce `any`, unsafe assertions, or suppressed type errors to bypass type safety.
- Keep functions and classes focused. Split files by responsibility before they exceed 350 lines. Exceed this limit only when splitting would clearly hurt readability or cohesion, and explain why. Avoid unrelated restructuring during maintenance changes.
- Remove stale or irrelevant comments and docs. Keep useful ones accurate, short, clear, and human-friendly. Explain non-obvious decisions rather than restating code. Apply the unslop and write-prompts skills when available.
- Add or update tests for changed behavior. Cover cancellation, broker acquisition, reconnection, shutdown, protocol errors, and input-executor boundaries when affected. Run the available type checks, lint checks, and relevant tests before considering work complete. This project currently has no lint script; do not claim a lint check was run.
- Give every shell command a timeout. Keep temporary files and logs in the project's `tmp/` directory, and do not modify unrelated repositories or user changes.

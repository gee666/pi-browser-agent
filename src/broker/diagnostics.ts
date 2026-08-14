import type { ProbeResult } from './protocol.ts';

/**
 * Human + agent readable diagnostics for a down browser bridge.
 *
 * Design goal: when a browser_* tool has to fail with E_BRIDGE_DISCONNECTED,
 * the agent must receive (a) exactly WHICH link of the chain is broken,
 * (b) an ordered list of recovery actions it can perform ITSELF with tools it
 * already has, and (c) an explicit instruction to tell the user what happened.
 * Never return a bare "connection is down".
 */

export type BridgeFailureKind =
  | 'ok'
  | 'broker_not_listening'
  | 'broker_unreachable'
  | 'bridge_never_connected'
  | 'bridge_lost';

export interface BridgeDiagnostics {
  kind: BridgeFailureKind;
  /** One-line summary of the broken link. */
  reason: string;
  /** Ordered, agent-executable recovery steps. */
  remediation: Array<{ step: number; action: string; how: string; automatic?: boolean }>;
  /** What the agent must relay to the human. */
  userMessage: string;
  probe: ProbeResult;
}

const DEFAULT_URL = 'ws://127.0.0.1:7878';

function listenerCheckCommand(url: string): string {
  const port = /:(\d+)/.exec(url || DEFAULT_URL)?.[1] ?? '7878';
  if (process.platform === 'win32') {
    return `netstat -ano | findstr :${port}`;
  }
  if (process.platform === 'darwin') {
    return `lsof -nP -iTCP:${port} -sTCP:LISTEN`;
  }
  return `ss -ltnp | grep :${port} || lsof -nP -iTCP:${port} -sTCP:LISTEN`;
}

function chromeCheckCommand(): string {
  if (process.platform === 'win32') {
    return 'powershell -Command "Get-Process chrome -ErrorAction SilentlyContinue | Select-Object -First 1 Id,StartTime"';
  }
  return 'pgrep -a -f "Google Chrome|chrome" | head -5';
}

export function classifyBridgeFailure(probe: ProbeResult): BridgeFailureKind {
  if (!probe.brokerReachable) return 'broker_unreachable';
  if (!probe.brokerListening) return 'broker_not_listening';
  if (probe.bridgeConnected) return 'ok';
  return probe.bridgeEverConnected ? 'bridge_lost' : 'bridge_never_connected';
}

function describeState(probe: ProbeResult): string {
  const bits: string[] = [];
  bits.push(`broker=${probe.brokerListening ? `listening ${probe.url || DEFAULT_URL}` : 'not listening'}`);
  bits.push(`role=${probe.role || 'unknown'}`);
  bits.push(`bridge=${probe.bridgeConnected ? 'connected' : 'disconnected'}`);
  if (probe.bridgeVersion) bits.push(`bridgeVersion=${probe.bridgeVersion}`);
  if (probe.lastBridgeConnectedAt) bits.push(`lastConnected=${probe.lastBridgeConnectedAt}`);
  if (probe.lastBridgeDisconnectedAt) bits.push(`lastDisconnected=${probe.lastBridgeDisconnectedAt}`);
  if (probe.lastBridgeDisconnectReason) bits.push(`lastReason=${probe.lastBridgeDisconnectReason}`);
  if (probe.startupError) bits.push(`startupError=${probe.startupError}`);
  return bits.join(', ');
}

export function buildBridgeDiagnostics(probe: ProbeResult, options: { toolName?: string } = {}): BridgeDiagnostics {
  const kind = classifyBridgeFailure(probe);
  const url = probe.url || DEFAULT_URL;
  const tool = options.toolName || 'the browser tool';

  const reason = kind === 'broker_unreachable'
    ? `The pi-browser-agent broker in this process could not be reached (${probe.startupError || 'unknown startup error'}).`
    : kind === 'broker_not_listening'
      ? `No pi-browser-agent broker is listening on ${url}${probe.startupError ? ` (${probe.startupError})` : ''}.`
      : kind === 'bridge_never_connected'
        ? `The broker is listening on ${url}, but the Chrome extension bridge has never connected in this session — Chrome is closed, the extension is disabled/unloaded, or its bridge URL list does not include ${url}.`
        : `The broker is listening on ${url}, but the Chrome extension bridge dropped and has not come back${probe.lastBridgeDisconnectReason ? ` (last reason: ${probe.lastBridgeDisconnectReason})` : ''}.`;

  const remediation: BridgeDiagnostics['remediation'] = [];
  let step = 1;
  const add = (action: string, how: string, automatic = false) => {
    remediation.push({ step: step++, action, how, automatic });
  };

  add(
    'Already attempted automatically: lazy re-acquire + reconnect wait',
    'Every browser_* call re-binds/re-dials the broker and then waits for the extension to reconnect before failing. This error means that window elapsed.',
    true,
  );
  add(
    'Re-probe and force another lazy re-establish',
    'Call activate_browser_agent_tools. It re-acquires the broker port (promoting this process to primary if the old primary died) and re-reads live bridge state.',
  );
  add(
    `Retry ${tool} once after ~5 seconds`,
    'The Chrome extension reconnect backoff is capped at 5s, with a 30s chrome.alarms backstop. A single retry recovers most transient drops.',
  );
  if (kind === 'broker_not_listening' || kind === 'broker_unreachable') {
    add(
      'Verify which process owns the broker port',
      `Run: ${listenerCheckCommand(url)} — expect a LISTENING pi/node process. If a foreign process squats the port, set PI_BA_PORT to a free port in both pi and the extension options.`,
    );
  } else {
    add(
      'Verify Chrome is actually running',
      `Run: ${chromeCheckCommand()} — if there is no Chrome process, the bridge cannot exist. Ask the user to start Chrome.`,
    );
    add(
      'Confirm the socket at the OS level',
      `Run: ${listenerCheckCommand(url)} — a healthy bridge shows the LISTENING socket plus one ESTABLISHED connection owned by chrome.exe/Chrome.`,
    );
  }
  add(
    'Reload the extension service worker (only once the bridge is briefly back)',
    'browser_reload_extension restarts the extension worker and re-handshakes. It travels over the bridge itself, so it only helps after step 2/3 restored a connection.',
  );
  add(
    'Escalate to the user (do this — do not fail silently)',
    'Report the state summary below and ask them to open chrome://extensions, reload "Browser Agent", and check the extension options page: pi bridge enabled and the broker URL list includes ' + url + '.',
  );

  const userMessage = [
    `Browser automation is unavailable: ${reason}`,
    '',
    `State: ${describeState(probe)}`,
    '',
    'What you can do:',
    '  1. Open chrome://extensions and click the reload icon on "Browser Agent".',
    `  2. Open the extension options page and confirm the pi bridge is enabled and its broker URL list contains ${url}.`,
    '  3. If Chrome is not running, start it — the bridge lives inside the extension.',
  ].join('\n');

  return { kind, reason, remediation, userMessage, probe };
}

export function formatBridgeDiagnosticsText(diagnostics: BridgeDiagnostics): string {
  const lines: string[] = [
    `E_BRIDGE_DISCONNECTED — ${diagnostics.reason}`,
    '',
    `State: ${describeState(diagnostics.probe)}`,
    '',
    'Self-service recovery (do these yourself, in order):',
  ];
  for (const item of diagnostics.remediation) {
    lines.push(`  ${item.step}. ${item.action}${item.automatic ? ' [already done]' : ''}`);
    lines.push(`     ${item.how}`);
  }
  lines.push('', 'Then TELL THE USER what happened, in your own words:', ...diagnostics.userMessage.split('\n').map((line) => `  ${line}`));
  return lines.join('\n');
}

/** Convenience: build the full agent-facing text straight from a probe. */
export function formatBridgeFailure(probe: ProbeResult, toolName?: string): { text: string; diagnostics: BridgeDiagnostics } {
  const diagnostics = buildBridgeDiagnostics(probe, { toolName });
  return { text: formatBridgeDiagnosticsText(diagnostics), diagnostics };
}

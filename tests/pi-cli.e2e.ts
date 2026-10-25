import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = fileURLToPath(new URL('../', import.meta.url));
const names = ['activate_browser_agent_tools', 'browser_run_task', 'browser_get_task_history',
  'browser_list_tasks', 'browser_get_screenshot', 'browser_get_html', 'browser_get_dom_info',
  'browser_get_computed_styles', 'browser_get_console_logs', 'browser_get_network',
  'browser_get_accessibility_tree', 'browser_get_performance_metrics', 'browser_evaluate_js',
  'browser_run_js', 'browser_create_tab', 'browser_list_tabs', 'browser_switch_tab',
  'browser_close_tab', 'browser_navigate', 'browser_reload', 'browser_reload_extension',
  'browser_wait_for', 'browser_clear_site_data'].sort();

type WireRequest = { model: string; tools?: { function: { name: string } }[];
  messages: { role: string; content?: unknown }[] };
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as RecordValue;
}
async function freePort() {
  const server = createTcpServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test('real Pi CLI preserves browser declarations, execution, history and cleanup across turns, compaction and reload',
  { timeout: 90_000 }, async () => {
  const piBin = process.env.PI_EVERGREEN_PI_BIN;
  assert.ok(piBin, 'PI_EVERGREEN_PI_BIN must identify the installed global Pi executable');
  await mkdir(path.join(root, 'tmp'), { recursive: true });
  const dir = await mkdtemp(path.join(root, 'tmp/cli-audit-'));
  const agent = path.join(dir, 'agent');
  await mkdir(agent);
  const provider = process.env.PI_EVERGREEN_E2E_PROVIDER ?? 'openai';
  const model = process.env.PI_EVERGREEN_E2E_MODEL ?? 'gpt-6-luna';
  const reasoning = process.env.PI_EVERGREEN_E2E_REASONING ?? 'medium';
  // No live intelligence is needed: use Pi's real OpenAI transport against a
  // local SSE endpoint. The captured bytes are actual provider-bound requests.
  const requests: WireRequest[] = [];
  let selectedTool = 'browser_list_tasks';
  let selectedParams: RecordValue = {};
  let failNextRequest = false;
  let holdBridgeResponse = false;
  let rejectBridgeResponse = false;
  let bridgeCalls = 0;
  const endpoint = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body: WireRequest = JSON.parse(raw);
    requests.push(body);
    if (failNextRequest) {
      failNextRequest = false;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'AUDIT_RETRY_SENTINEL', type: 'server_error' } }));
      return;
    }
    const tool = body.tools?.some((item) => item.function.name === selectedTool)
      && body.messages.at(-1)?.role !== 'tool';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = tool ? { tool_calls: [{ index: 0, id: `audit_${requests.length}`,
      type: 'function', function: { name: selectedTool, arguments: JSON.stringify(selectedParams) } }] }
      : { content: 'AUDIT_SUMMARY: browser tools remain available.' };
    const chunk = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    chunk({ id: 'audit', object: 'chat.completion.chunk', model, created: 1,
      choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] });
    chunk({ id: 'audit', object: 'chat.completion.chunk', model, created: 1,
      choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
    res.end('data: [DONE]\n\n');
  }).listen(0, '127.0.0.1');
  await once(endpoint, 'listening');
  const address = endpoint.address();
  assert.ok(address && typeof address !== 'string');
  await writeFile(path.join(agent, 'models.json'), JSON.stringify({ providers: {
    [provider]: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions',
      apiKey: 'harmless-local-sentinel', models: [{ id: model, reasoning: true,
        contextWindow: 128000, maxTokens: 128 }] },
  } }));
  await writeFile(path.join(agent, 'settings.json'), JSON.stringify({
    compaction: { keepRecentTokens: 1 }, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
  }));
  const port = await freePort();
  const auditLog = path.join(dir, 'lifecycle.jsonl');
  const child = spawn(piBin, ['--mode', 'rpc', '--offline', '--no-extensions', '--no-mcp',
    '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-builtin-tools',
    '--provider', provider, '--model', model, '--thinking', reasoning,
    '--session-dir', path.join(dir, 'sessions'), '-e', path.join(root, 'src/index.ts'),
    '-e', path.join(root, 'tests/fixtures/lifecycle-observer.ts')], {
    cwd: root, env: { PATH: process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: '1', PI_TELEMETRY: '0', XDG_STATE_HOME: dir,
      PI_BA_PORT: String(port), BA_AUDIT_LOG: auditLog },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const events: RecordValue[] = [];
  let stderr = '', buffer = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line.trim()) events.push(object(JSON.parse(line)));
    }
  });
  let bridge: WebSocket | undefined;
  async function waitFor(predicate: () => boolean) {
    const deadline = Date.now() + 20_000;
    while (!predicate()) {
      assert.equal(child.exitCode, null, stderr);
      assert.ok(Date.now() < deadline, `CLI timeout: ${stderr}\n${JSON.stringify(events.slice(-4))}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  let sequence = 0;
  async function command(type: string, fields: RecordValue = {}) {
    const id = String(++sequence);
    child.stdin.write(JSON.stringify({ type, id, ...fields }) + '\n');
    await waitFor(() => events.some((event) => event.id === id));
    const response = events.find((event) => event.id === id)!;
    assert.equal(response.success, true, JSON.stringify(response));
    return object(response.data ?? {});
  }
  async function prompt(message: string) {
    const start = events.length;
    const firstRequest = requests.length;
    await command('prompt', { message });
    await waitFor(() => events.slice(start).some((event) => event.type === 'agent_settled'));
    const outbound = requests.slice(firstRequest);
    assert.ok(outbound.length >= 2, 'each prompt must execute a browser tool and send its result');
    outbound.forEach(declarations);
  }
  const declarations = (body: WireRequest) => {
    assert.deepEqual(body.tools?.map((item) => item.function.name).sort(), names);
    assert.equal(body.model, model);
  };
  try {
    await command('get_state');
    await prompt('AUDIT_FIRST: list stored browser tasks.');
    assert.ok(requests.length >= 2, 'must observe tool call and follow-up HTTP requests');
    requests.forEach(declarations);
    // Negative control proves the assertion rejects a missing browser tool.
    assert.throws(() => declarations({ ...requests[0], tools: requests[0].tools?.slice(1) }));
    assert.ok(JSON.stringify(requests.at(-1)).includes('AUDIT_FIRST'));
    if (process.platform === 'linux') {
      // Pi and this extension both participate in job control. Verify the real
      // process stops only after releasing the listener, then reacquires it.
      child.kill('SIGTSTP');
      await waitFor(() => /^State:\s+T/m.test(readFileSync(`/proc/${child.pid}/status`, 'utf8')));
      const released = createTcpServer().listen(port, '127.0.0.1');
      await once(released, 'listening');
      await new Promise<void>((resolve) => released.close(() => resolve()));
      child.kill('SIGCONT');
      await command('get_state');
    }
    selectedTool = 'browser_list_tabs';
    bridge = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(bridge, 'open');
    bridge.on('message', (raw) => {
      const frame = object(JSON.parse(raw.toString()));
      if (frame.kind === 'request') {
        assert.ok(frame.type === 'browser_list_tabs' || frame.type === 'browser_run_task');
        bridgeCalls += 1;
        if (holdBridgeResponse) return;
        if (rejectBridgeResponse) {
          bridge!.send(JSON.stringify({ v: 1, kind: 'response', id: frame.id, ok: false,
            error: { code: 'E_RUNTIME', message: 'BRIDGE_FAILURE_SENTINEL' } }));
          return;
        }
        bridge!.send(JSON.stringify({ v: 1, kind: 'response', id: frame.id, ok: true,
          data: frame.type === 'browser_run_task'
            ? { status: 'done', message: 'TASK_SENTINEL' }
            : { tabs: [{ id: 17, title: 'BRIDGE_SENTINEL', url: 'https://example.invalid' }] } }));
      }
    });
    bridge.send(JSON.stringify({ v: 1, kind: 'hello', extensionId: 'audit', version: '1', capabilities: [] }));
    failNextRequest = true;
    const retryStart = requests.length;
    await prompt('AUDIT_SECOND: list browser tabs.');
    assert.ok(requests.length >= retryStart + 3, '503 must cause a real provider retry before tool execution');
    assert.ok(events.some((event) => event.type === 'auto_retry_start'), 'Pi must report the retry');
    assert.ok(JSON.stringify(requests.at(-1)).includes('BRIDGE_SENTINEL'), 'bridge result must reach real next request');
    const beforeFailure = events.length;
    rejectBridgeResponse = true;
    await prompt('AUDIT_BRIDGE_FAILURE');
    const failed = events.slice(beforeFailure).find((event) => event.type === 'tool_execution_end');
    assert.ok(failed);
    assert.equal(failed.isError, true, 'Pi must classify returned bridge failures as errors');
    const failedResult = object(failed.result);
    assert.deepEqual(failedResult.structuredContent, failedResult.details);
    assert.match(JSON.stringify(requests.at(-1)), /BRIDGE_FAILURE_SENTINEL/);
    rejectBridgeResponse = false;
    // Cancellation must reach execute's third argument, unwind the pending
    // bridge request, persist a cancelled tool result and permit another turn.
    holdBridgeResponse = true;
    const beforeAbort = events.length;
    const beforeBridge = bridgeCalls;
    await command('prompt', { message: 'AUDIT_ABORT: list browser tabs.' });
    await waitFor(() => bridgeCalls > beforeBridge);
    await command('abort');
    await waitFor(() => events.slice(beforeAbort).some((event) => event.type === 'agent_settled'));
    const abortedResult = events.slice(beforeAbort).find((event) => event.type === 'tool_execution_end');
    assert.ok(abortedResult, 'real Pi execution must finish on cancellation');
    assert.match(JSON.stringify(abortedResult), /cancel|abort/i);
    holdBridgeResponse = false;
    await prompt('AUDIT_RECOVER_AFTER_ABORT');
    assert.ok(JSON.stringify(requests.at(-1)).includes('BRIDGE_SENTINEL'));
    selectedTool = 'browser_run_task';
    selectedParams = { task: 'TASK_INTENT_SENTINEL' };
    const beforeTask = events.length;
    await prompt('AUDIT_RUN_TASK');
    const taskEnd = events.slice(beforeTask).find((event) => event.type === 'tool_execution_end');
    const taskDetails = object(object(taskEnd?.result).details);
    assert.equal(taskDetails.success, true);
    assert.equal(taskDetails.status, 'done');
    assert.equal(taskEnd?.isError, false);
    assert.deepEqual(object(taskEnd?.result).structuredContent, taskDetails,
      'native structured results must retain task history without replacing legacy details');
    const taskId = taskDetails.taskId;
    assert.equal(typeof taskId, 'string');
    selectedTool = 'browser_list_tabs';
    selectedParams = {};
    const state = await command('get_state');
    const session = await readFile(String(state.sessionFile), 'utf8');
    assert.match(session, /BRIDGE_SENTINEL/);
    assert.match(session, /browser_list_tasks/);
    const persisted = session.trim().split('\n').map((line) => object(JSON.parse(line)));
    const failedMessage = persisted.map((entry) => entry.message).find((message) =>
      message && typeof message === 'object' && 'role' in message && message.role === 'toolResult'
      && JSON.stringify(message).includes('BRIDGE_FAILURE_SENTINEL'));
    assert.ok(failedMessage, 'error content and legacy details must survive session serialization');
    assert.equal(object(failedMessage).isError, true);
    assert.deepEqual(object(failedMessage).details, failedResult.details);
    await command('compact', { customInstructions: 'Keep audit sentinels.' });
    await prompt('AUDIT_AFTER_COMPACTION');
    // Reload must work on its own: a subsequent new_session could otherwise
    // conceal a broken replacement tool closure or missing declarations.
    await command('prompt', { message: '/audit-reload' });
    selectedTool = 'browser_list_tasks';
    await prompt('AUDIT_AFTER_RELOAD');
    await command('get_state');
    await command('new_session');
    selectedTool = 'browser_get_task_history';
    selectedParams = { taskId };
    await prompt('AUDIT_NEW_SESSION');
    assert.match(JSON.stringify(requests.at(-1)), /Loaded 2 history event/,
      'browser task history must survive compaction, reload and new_session');
    requests.filter((body) => body.tools?.length).forEach(declarations);
    const lifecycle = (await readFile(auditLog, 'utf8')).trim().split('\n').map((line) => object(JSON.parse(line)));
    const starts = lifecycle.filter((row) => row.event === 'start');
    assert.ok(starts.length >= 3, 'initial, reload and new-session startup must run');
    for (const row of starts) {
      assert.equal(row.suspend, starts[0].suspend, 'reload must not accumulate SIGTSTP handlers');
      assert.equal(row.resume, starts[0].resume, 'reload must not accumulate SIGCONT handlers');
      assert.deepEqual(row.tools, names);
    }
    for (const row of lifecycle.filter((row) => row.event === 'shutdown')) {
      assert.equal(row.suspend, Number(starts[0].suspend) - 1);
      assert.equal(row.resume, Number(starts[0].resume) - 1);
    }
    bridge.close();
    const exit = once(child, 'exit');
    child.stdin.end();
    await exit;
    assert.equal(child.exitCode, 0, stderr);
    const probe = createTcpServer().listen(port, '127.0.0.1');
    await once(probe, 'listening');
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  } finally {
    bridge?.terminate();
    if (child.exitCode === null) child.kill('SIGKILL');
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

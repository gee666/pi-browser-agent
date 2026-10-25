import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = fileURLToPath(new URL('../', import.meta.url));
const piBin = process.env.EVERGREEN_PI_BIN || 'pi';
const names = ['activate_browser_agent_tools', 'browser_run_task', 'browser_get_task_history',
  'browser_list_tasks', 'browser_get_screenshot', 'browser_get_html', 'browser_get_dom_info',
  'browser_get_computed_styles', 'browser_get_console_logs', 'browser_get_network',
  'browser_get_accessibility_tree', 'browser_get_performance_metrics', 'browser_evaluate_js',
  'browser_run_js', 'browser_create_tab', 'browser_list_tabs', 'browser_switch_tab',
  'browser_close_tab', 'browser_navigate', 'browser_reload', 'browser_reload_extension',
  'browser_wait_for', 'browser_clear_site_data'].sort();
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
async function workspace() {
  await mkdir(path.join(root, 'tmp'), { recursive: true });
  const dir = await mkdtemp(path.join(root, 'tmp/evergreen-'));
  await mkdir(path.join(dir, 'agent'));
  return dir;
}
async function runPi(dir: string, port: number, model: string, prompt: string, extra: string[] = []) {
  const child = spawn(piBin, ['--mode', 'json', '--offline', '--no-extensions', '--no-mcp',
    '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-builtin-tools',
    '--model', model, '--session-dir', path.join(dir, 'sessions'),
    '-e', path.join(root, 'src/index.ts'), ...extra, prompt], {
    cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: path.join(dir, 'agent'),
      PI_TELEMETRY: '0', XDG_STATE_HOME: dir, PI_BA_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, `${stderr}\n${stdout}`);
    return stdout.trim().split('\n').map((line) => object(JSON.parse(line)));
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}
function toolEnd(events: RecordValue[], name: string) {
  const event = events.find((item) => item.type === 'tool_execution_end' && item.toolName === name);
  assert.ok(event, `Pi must actually execute ${name}: ${JSON.stringify(events)}`);
  return event;
}

test('global Pi declares all tools offline, forwards tasks, persists history across processes and classifies bridge failures',
  { timeout: 180_000 }, async () => {
  const dir = await workspace();
  const port = await freePort();
  const requests: RecordValue[] = [];
  let selectedTool = 'browser_run_task';
  let selectedParams: RecordValue = { task: 'EVERGREEN_TASK_INTENT' };
  let bridgeFailure = false;
  const bridges = new Set<WebSocket>();
  // A local transport fixture makes declaration/result assertions deterministic;
  // the second test below uses EVERGREEN_E2E_MODEL with real credentials.
  const endpoint = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = object(JSON.parse(raw));
    requests.push(body);
    assert.ok(Array.isArray(body.messages));
    const call = object(body.messages.at(-1)).role !== 'tool';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = call ? { tool_calls: [{ index: 0, id: `eg_${requests.length}`,
      type: 'function', function: { name: selectedTool, arguments: JSON.stringify(selectedParams) } }] }
      : { content: 'EVERGREEN_COMPLETE' };
    for (const [change, finish] of [[{ role: 'assistant', ...delta }, null],
      [{}, call ? 'tool_calls' : 'stop']]) {
      res.write(`data: ${JSON.stringify({ id: 'eg', object: 'chat.completion.chunk',
        model: 'evergreen-fixture', created: 1,
        choices: [{ index: 0, delta: change, finish_reason: finish }],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  }).listen(0, '127.0.0.1');
  await once(endpoint, 'listening');
  const address = endpoint.address();
  assert.ok(address && typeof address !== 'string');
  await writeFile(path.join(dir, 'agent/models.json'), JSON.stringify({ providers: {
    evergreen: { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions',
      apiKey: 'local-fixture', models: [{ id: 'evergreen-fixture', contextWindow: 128000, maxTokens: 128 }] },
  } }));
  let connecting = false;
  const connect = setInterval(() => {
    if (connecting) return;
    connecting = true;
    const bridge = new WebSocket(`ws://127.0.0.1:${port}`);
    bridges.add(bridge);
    bridge.on('error', () => {});
    bridge.on('close', () => { bridges.delete(bridge); connecting = false; });
    bridge.on('open', () => bridge.send(JSON.stringify({ v: 1, kind: 'hello',
      extensionId: 'evergreen', version: '1', capabilities: [] })));
    bridge.on('message', (raw) => {
      const frame = object(JSON.parse(raw.toString()));
      if (frame.kind !== 'request') return;
      assert.equal(frame.type, 'browser_run_task');
      assert.equal(object(frame.params).task, 'EVERGREEN_TASK_INTENT');
      bridge.send(JSON.stringify({ v: 1, kind: 'response', id: frame.id, ok: !bridgeFailure,
        ...(bridgeFailure ? { error: { code: 'E_RUNTIME', message: 'EVERGREEN_BRIDGE_FAILURE' } }
          : { data: { status: 'done', message: 'EVERGREEN_BRIDGE_RESULT' } }) }));
    });
  }, 40);
  try {
    const events = await runPi(dir, port, 'evergreen/evergreen-fixture', 'Run the browser task.');
    const completed = toolEnd(events, 'browser_run_task');
    assert.equal(completed.isError, false);
    const result = object(completed.result);
    const details = object(result.details);
    assert.equal(details.success, true);
    assert.deepEqual(result.structuredContent, details);
    assert.ok(JSON.stringify(requests.at(-1)).includes('EVERGREEN_BRIDGE_RESULT'));
    selectedTool = 'browser_get_task_history';
    selectedParams = { taskId: details.taskId };
    const history = await runPi(dir, port, 'evergreen/evergreen-fixture', 'Read the stored task.');
    assert.match(JSON.stringify(toolEnd(history, selectedTool)), /EVERGREEN_TASK_INTENT/);
    assert.match(JSON.stringify(toolEnd(history, selectedTool)), /EVERGREEN_BRIDGE_RESULT/);
    assert.match(JSON.stringify(requests.at(-1)), /Loaded 2 history event/);
    selectedTool = 'browser_run_task';
    selectedParams = { task: 'EVERGREEN_TASK_INTENT' };
    bridgeFailure = true;
    const failed = toolEnd(await runPi(dir, port, 'evergreen/evergreen-fixture', 'Run the task.'), selectedTool);
    assert.equal(failed.isError, true);
    assert.match(JSON.stringify(failed), /EVERGREEN_BRIDGE_FAILURE/);
    for (const request of requests) {
      assert.ok(Array.isArray(request.tools));
      assert.deepEqual(request.tools.map((tool) => object(object(tool).function).name).sort(), names);
    }
    const sessions = await readdir(path.join(dir, 'sessions'));
    const persisted = await Promise.all(sessions.map((file) => readFile(path.join(dir, 'sessions', file), 'utf8')));
    assert.ok(persisted.some((text) => text.includes('EVERGREEN_BRIDGE_FAILURE') && text.includes('"isError":true')));
    const probe = createTcpServer().listen(port, '127.0.0.1');
    await once(probe, 'listening');
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  } finally {
    clearInterval(connect);
    for (const bridge of bridges) bridge.terminate();
    endpoint.closeAllConnections();
    await new Promise<void>((resolve) => endpoint.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('live Evergreen model discovers and uses browser history without Chrome', { timeout: 150_000 }, async () => {
  const model = process.env.EVERGREEN_E2E_MODEL;
  assert.ok(model, 'Set EVERGREEN_E2E_MODEL to the provider/model used for live E2E');
  const dir = await workspace();
  try {
    // Isolate settings/extensions/state, but retain the user's provider credentials.
    const agent = process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || '', '.pi/agent');
    try { await copyFile(path.join(agent, 'auth.json'), path.join(dir, 'agent/auth.json')); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    const events = await runPi(dir, await freePort(), model,
      'Call browser_list_tasks exactly once to inspect local browser task history. Do not call any other tools. Then briefly report whether the list is empty.');
    assert.equal(toolEnd(events, 'browser_list_tasks').isError, false);
    assert.ok(events.some((event) => event.type === 'agent_end'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

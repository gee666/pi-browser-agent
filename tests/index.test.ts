import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import extension, { getBroker, resetForTests } from '../src/index.ts';
import { BrowserAgentBroker } from '../src/broker/server.ts';
import { TaskStore } from '../src/broker/task-store.ts';

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Unable to allocate a free port'));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function createPiHarness() {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  return {
    tools,
    handlers,
    on(event: string, handler: any) {
      handlers.set(event, handler);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
  };
}

test('extension eagerly registers the full browser_* suite at session start when the broker is listening, and restarts broker after shutdown', async () => {
  await resetForTests();
  const originalPort = process.env.PI_BA_PORT;

  try {
    process.env.PI_BA_PORT = String(await getFreePort());

    const pi = createPiHarness();
    await extension(pi as any);

    const sessionStart = pi.handlers.get('session_start');
    const sessionShutdown = pi.handlers.get('session_shutdown');
    assert.equal(typeof sessionStart, 'function');
    assert.equal(typeof sessionShutdown, 'function');

    await sessionStart({}, {});
    assert.equal(pi.tools.has('activate_browser_agent_tools'), true);
    // pi reads the tool registry at session_start, so the full browser_*
    // suite is registered eagerly whenever the broker is listening. Tools
    // themselves probe the bridge at call time.
    assert.equal(pi.tools.has('browser_run_task'), true);
    const firstBroker = getBroker();
    assert.ok(firstBroker);
    assert.equal(firstBroker?.probeConnectivity().brokerListening, true);

    await sessionShutdown({}, {});
    assert.equal(getBroker(), null);

    pi.tools.clear();
    process.env.PI_BA_PORT = String(await getFreePort());
    await sessionStart({}, {});
    assert.equal(pi.tools.has('activate_browser_agent_tools'), true);
    assert.equal(pi.tools.has('browser_run_task'), true);
    const secondBroker = getBroker();
    assert.ok(secondBroker);
    assert.notEqual(secondBroker, firstBroker);
    assert.equal(secondBroker?.probeConnectivity().brokerListening, true);

    await sessionShutdown({}, {});
  } finally {
    await resetForTests();
    if (originalPort === undefined) {
      delete process.env.PI_BA_PORT;
    } else {
      process.env.PI_BA_PORT = originalPort;
    }
  }
});


test('extension retries broker startup on a later session after a transient bind failure', async () => {
  await resetForTests();
  const originalPort = process.env.PI_BA_PORT;
  const originalRange = process.env.PI_BA_PORT_RANGE;
  const originalNoEph = process.env.PI_BA_NO_EPHEMERAL;
  const blockedPort = await getFreePort();
  const blocker = net.createServer();

  try {
    await new Promise<void>((resolve, reject) => blocker.listen(blockedPort, '127.0.0.1', () => resolve()).once('error', reject));
    process.env.PI_BA_PORT = String(blockedPort);
    // Force the legacy single-port-no-fallback behaviour so this test still
    // exercises the "transient bind failure" path. With the default range +
    // ephemeral fallback the broker would always succeed.
    process.env.PI_BA_PORT_RANGE = '1';
    process.env.PI_BA_NO_EPHEMERAL = '1';

    const pi = createPiHarness();
    await extension(pi as any);
    const sessionStart = pi.handlers.get('session_start');
    const sessionShutdown = pi.handlers.get('session_shutdown');

    await sessionStart({}, {});
    // Startup failed; no broker is published as the singleton.
    assert.equal(getBroker(), null);
    // Meta-tool should still be registered so the session has a diagnostic surface.
    assert.equal(pi.tools.has('activate_browser_agent_tools'), true);

    await new Promise<void>((resolve, reject) => blocker.close((error) => (error ? reject(error) : resolve())));
    pi.tools.clear();
    await sessionShutdown({}, {});
    await sessionStart({}, {});

    assert.equal(pi.tools.has('activate_browser_agent_tools'), true);
    assert.equal(getBroker()?.probeConnectivity().brokerListening, true);
    await sessionShutdown({}, {});
  } finally {
    await resetForTests();
    if (originalPort === undefined) {
      delete process.env.PI_BA_PORT;
    } else {
      process.env.PI_BA_PORT = originalPort;
    }
    if (originalRange === undefined) {
      delete process.env.PI_BA_PORT_RANGE;
    } else {
      process.env.PI_BA_PORT_RANGE = originalRange;
    }
    if (originalNoEph === undefined) {
      delete process.env.PI_BA_NO_EPHEMERAL;
    } else {
      process.env.PI_BA_NO_EPHEMERAL = originalNoEph;
    }
  }
});

test('broker startup diagnostics are routed through the extension UI context', async () => {
  await resetForTests();
  const originalPort = process.env.PI_BA_PORT;
  const originalRange = process.env.PI_BA_PORT_RANGE;
  const originalNoEph = process.env.PI_BA_NO_EPHEMERAL;
  const blockedPort = await getFreePort();
  const blocker = net.createServer();
  const notifications: Array<{ message: string; type?: string }> = [];

  try {
    await new Promise<void>((resolve, reject) => blocker.listen(blockedPort, '127.0.0.1', () => resolve()).once('error', reject));
    process.env.PI_BA_PORT = String(blockedPort);
    process.env.PI_BA_PORT_RANGE = '1';
    process.env.PI_BA_NO_EPHEMERAL = '1';

    const pi = createPiHarness();
    await extension(pi as any);
    const sessionStart = pi.handlers.get('session_start');

    await sessionStart({}, { ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) } });

    assert.equal(getBroker(), null);
    assert.ok(notifications.some((entry) => entry.type === 'warning' && entry.message.includes('primary broker port is busy')));
    // Startup failure is no longer fatal for the session: the user is warned,
    // and the full browser_* suite is still registered behind a lazy handle so
    // the integration can heal itself on a later tool call without restarting pi.
    assert.ok(notifications.some((entry) => entry.type === 'warning' && entry.message.includes('Browser agent broker not acquired yet')));
    assert.ok(pi.tools.has('activate_browser_agent_tools'));
    assert.ok(pi.tools.has('browser_get_html'));
    assert.ok(pi.tools.has('browser_run_task'));
  } finally {
    await resetForTests();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    if (originalPort === undefined) {
      delete process.env.PI_BA_PORT;
    } else {
      process.env.PI_BA_PORT = originalPort;
    }
    if (originalRange === undefined) {
      delete process.env.PI_BA_PORT_RANGE;
    } else {
      process.env.PI_BA_PORT_RANGE = originalRange;
    }
    if (originalNoEph === undefined) {
      delete process.env.PI_BA_NO_EPHEMERAL;
    } else {
      process.env.PI_BA_NO_EPHEMERAL = originalNoEph;
    }
  }
});

test('suspend during task-store setup still registers browser tools without acquiring a broker', async () => {
  await resetForTests();
  const originalPort = process.env.PI_BA_PORT;
  const originalInit = TaskStore.prototype.init;
  const originalKill = process.kill;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  let releaseInit!: () => void;
  let initEntered!: () => void;
  let stopAttempted!: () => void;
  const entered = new Promise<void>((resolve) => { initEntered = resolve; });
  const release = new Promise<void>((resolve) => { releaseInit = resolve; });
  const attempted = new Promise<void>((resolve) => { stopAttempted = resolve; });
  let delayed = false;

  try {
    process.env.PI_BA_PORT = String(await getFreePort());
    TaskStore.prototype.init = async function (...args: Parameters<typeof originalInit>) {
      if (!delayed) {
        delayed = true;
        initEntered();
        await release;
      }
      return await originalInit.apply(this, args);
    };
    // Install the POSIX suspend handlers even though the test suite runs on
    // Windows, and intercept SIGSTOP so the test process is not suspended.
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' });
    (process as any).kill = (_pid: number, signal?: string | number) => {
      if (signal === 'SIGSTOP') stopAttempted();
      return true;
    };

    const pi = createPiHarness();
    await extension(pi as any);
    Object.defineProperty(process, 'platform', platformDescriptor!);
    const starting = pi.handlers.get('session_start')({}, {});
    await entered;
    (process as any).emit('SIGTSTP');
    await attempted;
    releaseInit();
    await starting;

    assert.equal(getBroker(), null, 'suspend must still block eager broker acquisition');
    assert.equal(pi.tools.has('activate_browser_agent_tools'), true);
    assert.equal(pi.tools.has('browser_run_task'), true);

    (process as any).emit('SIGCONT');
    await pi.handlers.get('session_shutdown')({}, {});
  } finally {
    releaseInit?.();
    (process as any).emit('SIGCONT');
    TaskStore.prototype.init = originalInit;
    (process as any).kill = originalKill;
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    await resetForTests();
    if (originalPort === undefined) delete process.env.PI_BA_PORT;
    else process.env.PI_BA_PORT = originalPort;
  }
});

test('session shutdown invalidates setup that has not reached broker startup yet', async () => {
  await resetForTests();
  const originalPort = process.env.PI_BA_PORT;
  const originalInit = TaskStore.prototype.init;
  let releaseInit!: () => void;
  let initEntered!: () => void;
  const entered = new Promise<void>((resolve) => { initEntered = resolve; });
  const release = new Promise<void>((resolve) => { releaseInit = resolve; });
  let delayed = false;

  try {
    process.env.PI_BA_PORT = String(await getFreePort());
    TaskStore.prototype.init = async function (...args: Parameters<typeof originalInit>) {
      if (!delayed) {
        delayed = true;
        initEntered();
        await release;
      }
      return await originalInit.apply(this, args);
    };

    const pi = createPiHarness();
    await extension(pi as any);
    const starting = pi.handlers.get('session_start')({}, {});
    await entered;
    await pi.handlers.get('session_shutdown')({}, {});
    releaseInit();
    await starting;

    assert.equal(getBroker(), null);
    assert.equal(pi.tools.size, 0, 'a session invalidated before registration must stay torn down');
  } finally {
    releaseInit?.();
    TaskStore.prototype.init = originalInit;
    await resetForTests();
    if (originalPort === undefined) delete process.env.PI_BA_PORT;
    else process.env.PI_BA_PORT = originalPort;
  }
});

test('session shutdown invalidates and awaits an in-flight broker startup', async () => {
  await resetForTests();
  const originalPort = process.env.PI_BA_PORT;
  const originalGc = TaskStore.prototype.gc;
  let releaseGc!: () => void;
  let gcEntered!: () => void;
  const entered = new Promise<void>((resolve) => { gcEntered = resolve; });
  const release = new Promise<void>((resolve) => { releaseGc = resolve; });
  let delayed = false;

  try {
    process.env.PI_BA_PORT = String(await getFreePort());
    TaskStore.prototype.gc = async function (...args: Parameters<typeof originalGc>) {
      if (!delayed) {
        delayed = true;
        gcEntered();
        await release;
      }
      return await originalGc.apply(this, args);
    };

    const pi = createPiHarness();
    await extension(pi as any);
    const starting = pi.handlers.get('session_start')({}, {});
    await entered;
    const shuttingDown = pi.handlers.get('session_shutdown')({}, {});
    releaseGc();
    await Promise.all([starting, shuttingDown]);

    assert.equal(getBroker(), null, 'late startup must not publish after shutdown');
    const successor = new BrowserAgentBroker({
      host: '127.0.0.1',
      port: Number(process.env.PI_BA_PORT),
      portRange: 1,
      fallbackToEphemeral: false,
      logger: { info() {}, warn() {}, error() {} },
      taskStore: new TaskStore({ dir: join(await mkdtemp(join(tmpdir(), 'pi-browser-agent-successor-')), 'tasks') }),
    });
    await successor.start();
    await successor.stop();
  } finally {
    releaseGc?.();
    TaskStore.prototype.gc = originalGc;
    await resetForTests();
    if (originalPort === undefined) delete process.env.PI_BA_PORT;
    else process.env.PI_BA_PORT = originalPort;
  }
});

test('replacement waits for a stale broker to stop before binding', async () => {
  await resetForTests();
  const originalPort = process.env.PI_BA_PORT;
  let releaseStop!: () => void;
  const release = new Promise<void>((resolve) => { releaseStop = resolve; });

  try {
    process.env.PI_BA_PORT = String(await getFreePort());
    const pi = createPiHarness();
    await extension(pi as any);
    const sessionStart = pi.handlers.get('session_start');
    const sessionShutdown = pi.handlers.get('session_shutdown');
    await sessionStart({}, {});

    const stale = getBroker();
    assert.ok(stale);
    await stale.stop();
    const originalStop = stale.stop.bind(stale);
    let stopEntered!: () => void;
    const entered = new Promise<void>((resolve) => { stopEntered = resolve; });
    (stale as any).stop = async () => {
      stopEntered();
      await release;
      await originalStop();
    };

    let replacementSettled = false;
    const replacing = sessionStart({}, {}).finally(() => { replacementSettled = true; });
    await entered;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(replacementSettled, false, 'replacement must await stale stop');
    assert.equal(getBroker(), null);

    releaseStop();
    await replacing;
    assert.equal(getBroker()?.probeConnectivity().brokerListening, true);
    await sessionShutdown({}, {});
  } finally {
    releaseStop?.();
    await resetForTests();
    if (originalPort === undefined) delete process.env.PI_BA_PORT;
    else process.env.PI_BA_PORT = originalPort;
  }
});

test('overlapping session_start calls yield a single shared broker instance', async () => {
  await resetForTests();
  const originalPort = process.env.PI_BA_PORT;
  try {
    process.env.PI_BA_PORT = String(await getFreePort());
    const pi = createPiHarness();
    await extension(pi as any);
    const sessionStart = pi.handlers.get('session_start');
    const sessionShutdown = pi.handlers.get('session_shutdown');

    // Fire two concurrent session_start handlers before either returns.
    await Promise.all([sessionStart({}, {}), sessionStart({}, {})]);

    const broker = getBroker();
    assert.ok(broker);
    assert.equal(broker?.probeConnectivity().brokerListening, true);
    assert.equal(pi.tools.has('activate_browser_agent_tools'), true);

    await sessionShutdown({}, {});
  } finally {
    await resetForTests();
    if (originalPort === undefined) {
      delete process.env.PI_BA_PORT;
    } else {
      process.env.PI_BA_PORT = originalPort;
    }
  }
});

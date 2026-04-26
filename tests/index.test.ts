import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import extension, { getBroker, resetForTests } from '../src/index.ts';

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

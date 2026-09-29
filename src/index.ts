import { join } from 'node:path';

import { BrowserAgentBroker, type BrokerLogger } from './broker/server.ts';
import { RemoteBrowserAgentBroker } from './broker/remote.ts';
import { TaskStore } from './broker/task-store.ts';
import { BrowserHealthReporter, quietBrokerLogger } from './broker/health-reporter.ts';
import { ensureStateDir } from './util/paths.ts';
import { listInstances, removeInstanceFile, writeInstanceFile } from './util/instances.ts';
import { LazyBrokerHandle, type BrokerLike } from './broker/lazy.ts';
import { registerAllTools, resetRegisteredBrowserTools } from './tools/_register.ts';
import { createBrowserAgentToolsTool, resetBrowserAgentToolState } from './tools/browser_agent_tools.ts';

type BrowserAgentBrokerLike = BrowserAgentBroker | RemoteBrowserAgentBroker;
type ExtensionUi = {
  notify?: (message: string, type?: 'info' | 'warning' | 'error') => void;
  setStatus?: (key: string, text: string | undefined) => void;
};
type ExtensionContextLike = { ui?: ExtensionUi };

let brokerSingleton: BrowserAgentBrokerLike | null = null;
let brokerStartup: Promise<BrowserAgentBrokerLike> | null = null;
/** Invalidates an acquisition that was already in flight when shutdown began. */
let brokerLifecycleGeneration = 0;
/** Separately invalidates session setup. Suspend must not do this: tools still
 *  need to finish registering while broker acquisition is paused. */
let sessionLifecycleGeneration = 0;
let brokerShuttingDown = false;
let startupMessage: string | null = null;
/** Handles handed to the browser_* tools. They outlive the broker, so shutdown
 *  has to disarm them explicitly or a late tool call re-binds the port. */
const activeHandles = new Set<LazyBrokerHandle>();
/** Per-session teardown (bridge-state / promotion subscriptions). */
const sessionCleanups = new Set<() => void>();

export function getBroker(): BrowserAgentBrokerLike | null {
  return brokerSingleton;
}

export function getStartupMessage(): string | null {
  return startupMessage;
}

export async function resetForTests(): Promise<void> {
  brokerShuttingDown = true;
  brokerLifecycleGeneration += 1;
  sessionLifecycleGeneration += 1;
  const startup = brokerStartup;
  if (startup) {
    try { await startup; } catch { /* invalidated startup stops itself */ }
  }
  const broker = brokerSingleton;
  brokerSingleton = null;
  if (broker) {
    try {
      await broker.stop();
    } catch {
      // ignore in tests; callers are resetting state intentionally
    }
  }
  for (const cleanup of [...sessionCleanups]) {
    try { cleanup(); } catch { /* ignore */ }
  }
  sessionCleanups.clear();
  for (const handle of [...activeHandles]) {
    handle.dispose();
  }
  activeHandles.clear();
  brokerStartup = null;
  startupMessage = null;
  brokerShuttingDown = false;
}

async function createAndStartBroker(logger: BrokerLogger): Promise<BrowserAgentBrokerLike> {
  const tasksDir = await ensureStateDir('tasks');
  const preferredPort = Number(process.env.PI_BA_PORT || 7878);
  const host = process.env.PI_BA_HOST || '127.0.0.1';

  // Robust multi-instance mode:
  //   - One primary process owns the broker listener on 7878 and receives the
  //     Chrome extension bridge.
  //   - Secondary pi processes that lose the 7878 bind race proxy requests
  //     through the primary broker instead of requiring Chrome to connect to
  //     their fallback ports (fragile under MV3 service-worker sleep/backoff).
  const primaryBroker = new BrowserAgentBroker({
    host,
    port: preferredPort,
    portRange: 1,
    fallbackToEphemeral: false,
    logger,
    taskStore: new TaskStore({ dir: join(tasksDir) }),
  });

  try {
    await primaryBroker.start();
    try {
      await listInstances({ gcStale: true });
      await writeInstanceFile({
        pid: process.pid,
        port: primaryBroker.port,
        host: primaryBroker.host,
        url: primaryBroker.url,
        cwd: process.cwd(),
        startedAt: new Date().toISOString(),
      });
    } catch (error) {
      logger.warn?.('[pi-browser-agent] failed to publish instance discovery file', error);
    }
    return primaryBroker;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'EADDRINUSE' || process.env.PI_BA_NO_EPHEMERAL) {
      throw error;
    }

    const remoteBroker = new RemoteBrowserAgentBroker({
      host,
      port: preferredPort,
      logger,
      taskStore: new TaskStore({ dir: join(tasksDir) }),
    });
    try {
      await remoteBroker.start();
    } catch (remoteError) {
      // A failed handshake can leave an open socket and a background heal loop.
      // Retire this candidate before a later acquisition tries again.
      await remoteBroker.stop();
      const message = remoteError instanceof Error ? remoteError.message : String(remoteError);
      if (message.includes('not a pi-browser-agent broker')) {
        throw new Error(`Port ${preferredPort} is busy, but it is not pi-browser-agent`);
      }
      if (message.includes('old pi-browser-agent broker')) {
        throw new Error(`Old browser broker on ${preferredPort}; restart the first pi instance`);
      }
      throw remoteError;
    }
    return remoteBroker;
  }
}

let signalHandlersInstalled = false;
let suspending = false;
let resumeGeneration = 0;

/**
 * Make Ctrl+Z (SIGTSTP) graceful.
 *
 * By default a suspended process keeps its TCP listener bound while frozen, so
 * the primary broker would hold port 7878 (and the Chrome extension bridge)
 * hostage without ever servicing it. That wedges every other pi process, which
 * proxies through the primary. Instead we intercept SIGTSTP, cleanly stop the
 * broker (freeing the port and closing the bridge so secondaries auto-promote
 * a new primary via RemoteBrowserAgentBroker.promoteOrReconnect), and only then
 * actually suspend via SIGSTOP (which cannot be caught, so it truly stops the
 * process like the default Ctrl+Z). On SIGCONT we re-acquire the broker.
 */
function installSuspendResumeHandlers(): void {
  if (signalHandlersInstalled) return;
  // SIGTSTP/SIGCONT are POSIX-only; nothing to do on Windows.
  if (process.platform === 'win32') return;
  signalHandlersInstalled = true;

  process.on('SIGTSTP', () => {
    if (suspending) return;
    suspending = true;
    brokerShuttingDown = true;
    brokerLifecycleGeneration += 1;
    const startup = brokerStartup;
    const broker = brokerSingleton;
    void (async () => {
      try {
        // Invalidate and await any in-flight startup before releasing the port.
        if (startup) {
          try { await startup; } catch { /* cancelled/failed startup */ }
        }
        if (broker) {
          await broker.stop();
          try { await removeInstanceFile(process.pid); } catch { /* ignore */ }
        }
      } catch {
        // Resume and the session recovery loop will retry quietly.
      } finally {
        // Now actually suspend. SIGSTOP is uncatchable, so this reliably stops
        // the process just like the default Ctrl+Z behaviour would have.
        try { process.kill(process.pid, 'SIGSTOP'); } catch { /* ignore */ }
      }
    })();
  });

  process.on('SIGCONT', () => {
    if (!suspending) return;
    suspending = false;
    resumeGeneration += 1;
    brokerShuttingDown = false;
    const broker = brokerSingleton;
    if (!broker) return;
    void (async () => {
      try {
        // Re-acquire the broker on the SAME instance the session tools captured.
        //   - primary (BrowserAgentBroker): rebinds 7878 if still free;
        //   - remote proxy (RemoteBrowserAgentBroker): reconnects / re-promotes.
        await broker.start();
        if (broker instanceof BrowserAgentBroker) {
          try {
            await writeInstanceFile({
              pid: process.pid,
              port: broker.port,
              host: broker.host,
              url: broker.url,
              cwd: process.cwd(),
              startedAt: new Date().toISOString(),
            });
          } catch { /* ignore */ }
        }
      } catch {
        // Another process may own the port now. The session recovery loop
        // re-resolves the lazy handle; the health reporter owns any warning.
      }
    })();
  });
}

/** Republish instance discovery when a secondary wins the bind race. Without
 *  this, discovery keeps advertising the dead primary's pid/port forever. */
function attachPromotionReporter(broker: BrowserAgentBrokerLike, logger: BrokerLogger): () => void {
  if (!(broker instanceof RemoteBrowserAgentBroker)) return () => {};
  return broker.addPromotionListener((promoted) => {
    void writeInstanceFile({
      pid: process.pid,
      port: promoted.port,
      host: promoted.host,
      url: promoted.url,
      cwd: process.cwd(),
      startedAt: new Date().toISOString(),
    }).catch((error) => {
      logger.warn?.('[pi-browser-agent] failed to publish instance discovery file after promotion', error);
    });
  });
}

async function getOrCreateBroker(logger: BrokerLogger): Promise<BrowserAgentBrokerLike> {
  if (brokerShuttingDown) {
    throw new Error('Browser broker is shutting down');
  }

  // If an existing broker is healthy, reuse it.
  if (brokerSingleton) {
    const probe = brokerSingleton.probeConnectivity();
    if (probe.brokerListening) {
      return brokerSingleton;
    }
    // Non-listening singleton (e.g. after a prior failure). Stop it before
    // dropping the reference: an abandoned broker keeps its heal timers and can
    // still bind the port, giving this process two competing brokers.
  }

  // Serialize startup (including stale teardown): at most one replacement can
  // stop/bind/publish at a time.
  if (brokerStartup) {
    return await brokerStartup;
  }

  const generation = brokerLifecycleGeneration;
  let startup!: Promise<BrowserAgentBrokerLike>;
  startup = (async () => {
    try {
      const stale = brokerSingleton;
      if (stale && !stale.probeConnectivity().brokerListening) {
        brokerSingleton = null;
        try {
          await stale.stop();
        } catch (error) {
          logger.warn?.('[pi-browser-agent] stale broker cleanup failed', error);
          throw error;
        }
      }

      if (brokerShuttingDown || generation !== brokerLifecycleGeneration) {
        throw new Error('Browser broker startup was cancelled by shutdown');
      }

      const broker = await createAndStartBroker(logger);
      // Shutdown may have begun while task-store setup or the socket bind was
      // in flight. Never publish that late broker, and await its teardown so it
      // cannot reclaim the port after shutdown returns.
      if (brokerShuttingDown || generation !== brokerLifecycleGeneration) {
        await broker.stop();
        throw new Error('Browser broker startup was cancelled by shutdown');
      }
      brokerSingleton = broker;
      return broker;
    } finally {
      // Do not let an older attempt clear a newer attempt's promise.
      if (brokerStartup === startup) {
        brokerStartup = null;
      }
    }
  })();
  brokerStartup = startup;

  return await startup;
}

export default async function piBrowserAgentExtension(pi: {
  on: (event: string, handler: (_event: unknown, ctx?: ExtensionContextLike) => Promise<void> | void) => void;
  registerTool: (tool: any) => void;
}) {
  const registerSessionTool = async (ctx?: ExtensionContextLike) => {
    const sessionGeneration = ++sessionLifecycleGeneration;
    for (const cleanup of [...sessionCleanups]) cleanup();
    sessionCleanups.clear();
    for (const handle of activeHandles) handle.dispose();
    activeHandles.clear();
    resetBrowserAgentToolState();
    resetRegisteredBrowserTools();
    const logger = quietBrokerLogger;
    const health = new BrowserHealthReporter(ctx?.ui);

    // One subscription per (session, broker instance). Re-resolving the broker
    // must not stack duplicate reporters, and the previous broker's must go.
    let attachedBroker: BrowserAgentBrokerLike | null = null;
    let detachReporters: (() => void) | null = null;
    const attachReporters = (broker: BrowserAgentBrokerLike) => {
      if (disposed || attachedBroker === broker) return;
      detachReporters?.();
      detachReporters = attachPromotionReporter(broker, logger);
      attachedBroker = broker;
    };

    // pi reads the tool registry once at session_start; any later
    // registerTool() call is dropped. So we ALWAYS register the full browser_*
    // suite, backed by a lazy handle that re-acquires the broker on every tool
    // call. That way a session started while Chrome/the broker was down still
    // gets working tools the moment the browser comes back, with no restart.
    // The handle's task store is used directly by the task tools, so it must be
    // initialised here — it is a different instance from the broker's.
    const taskStore = new TaskStore({ dir: join(await ensureStateDir('tasks')) });
    await taskStore.init();
    // session_shutdown may have completed while the per-session task store was
    // being prepared, before this session had a handle or brokerStartup for it
    // to invalidate. Do not let that delayed setup rebind after shutdown.
    if (sessionGeneration !== sessionLifecycleGeneration) {
      return;
    }
    const handle = new LazyBrokerHandle(async () => {
      const broker = await getOrCreateBroker(logger);
      attachReporters(broker);
      return broker as unknown as BrokerLike;
    }, taskStore);
    activeHandles.add(handle);
    let disposed = false;
    let recovering = false;
    let observedResumeGeneration = resumeGeneration;
    // Polling also covers initial state, lost proxy transports and stop/start
    // cycles, none of which reliably emit bridge-state events.
    const observeHealth = () => {
      if (disposed || suspending) return;
      if (observedResumeGeneration !== resumeGeneration) {
        observedResumeGeneration = resumeGeneration;
        health.resume();
        // stop() clears broker listeners. Resume may reuse that same object.
        const previousBroker = attachedBroker;
        attachedBroker = null;
        if (previousBroker) attachReporters(previousBroker);
      }
      health.observe(handle.probeConnectivity().bridgeConnected);
    };
    const recoveryTimer = setInterval(() => {
      if (disposed || suspending || brokerShuttingDown) return;
      observeHealth();
      if (recovering) return;
      recovering = true;
      void handle.ensureReady({ waitForBridgeMs: 0 }).catch(() => {
        // Tool diagnostics retain the cause; no raw exception reaches the UI.
      }).finally(() => {
        recovering = false;
        observeHealth();
      });
    }, 2_000);
    recoveryTimer.unref();
    sessionCleanups.add(() => {
      disposed = true;
      clearInterval(recoveryTimer);
      health.dispose();
      detachReporters?.();
      detachReporters = null;
      attachedBroker = null;
    });

    pi.registerTool(createBrowserAgentToolsTool(pi, handle as any));
    registerAllTools(pi, { broker: handle as any });

    // Best-effort eager acquisition so the session starts out connected and the
    // user sees the real state immediately. Failure here is not fatal anymore:
    // the lazy handle retries on every subsequent tool call.
    try {
      const broker = await getOrCreateBroker(logger);
      attachReporters(broker);
      handle.adopt(broker as unknown as BrokerLike);
      startupMessage = null;
    } catch (error) {
      startupMessage = error instanceof Error ? error.message : String(error);
    }
    observeHealth();
  };

  // Install once per process so Ctrl+Z releases the broker port instead of
  // freezing it while still bound.
  installSuspendResumeHandlers();

  pi.on('session_start', async (_event, ctx) => {
    await registerSessionTool(ctx);
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    brokerShuttingDown = true;
    brokerLifecycleGeneration += 1;
    sessionLifecycleGeneration += 1;
    const startup = brokerStartup;
    for (const cleanup of [...sessionCleanups]) {
      try { cleanup(); } catch { /* ignore */ }
    }
    sessionCleanups.clear();
    // Disarm the tool-facing handles first: they still point at the broker we
    // are about to stop, and ensureReady() would happily re-bind the port.
    for (const handle of [...activeHandles]) {
      handle.dispose();
    }
    activeHandles.clear();
    // Await an in-flight acquisition. Its generation check tears down any
    // broker that finished binding after shutdown started.
    if (startup) {
      try { await startup; } catch { /* cancelled/failed startup */ }
    }
    const broker = brokerSingleton;
    brokerSingleton = null;
    startupMessage = null;
    try {
      if (broker) await broker.stop();
    } catch {
      ctx?.ui?.notify?.('Browser broker cleanup failed.', 'warning');
    } finally {
      try {
        await removeInstanceFile(process.pid);
      } catch {
        ctx?.ui?.notify?.('Browser discovery cleanup failed.', 'warning');
      }
      brokerShuttingDown = false;
    }
  });
}

import { join } from 'node:path';

import { BrowserAgentBroker, type BrokerLogger } from './broker/server.ts';
import { RemoteBrowserAgentBroker } from './broker/remote.ts';
import { TaskStore } from './broker/task-store.ts';
import { ensureStateDir } from './util/paths.ts';
import { listInstances, removeInstanceFile, writeInstanceFile } from './util/instances.ts';
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
let startupMessage: string | null = null;

export function getBroker(): BrowserAgentBrokerLike | null {
  return brokerSingleton;
}

export function getStartupMessage(): string | null {
  return startupMessage;
}

export async function resetForTests(): Promise<void> {
  if (brokerSingleton) {
    try {
      await brokerSingleton.stop();
    } catch {
      // ignore in tests; callers are resetting state intentionally
    }
  }
  brokerSingleton = null;
  brokerStartup = null;
  startupMessage = null;
}

function formatLogArg(value: unknown): string {
  if (value instanceof Error) {
    return value.stack || value.message;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function createUiLogger(ctx?: ExtensionContextLike): BrokerLogger {
  const notify = ctx?.ui?.notify;
  if (typeof notify !== 'function') {
    return { info() {}, warn() {}, error() {} };
  }

  const emit = (type: 'info' | 'warning' | 'error', args: unknown[]) => {
    const message = args.map(formatLogArg).filter(Boolean).join(' ');
    if (message) {
      notify(message, type);
    }
  };

  return {
    info: (...args: unknown[]) => emit('info', args),
    warn: (...args: unknown[]) => emit('warning', args),
    error: (...args: unknown[]) => emit('error', args),
  };
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
    const broker = brokerSingleton;
    void (async () => {
      try {
        // Abort any in-flight startup and release the port + bridge.
        brokerStartup = null;
        if (broker) {
          await broker.stop();
          try { await removeInstanceFile(process.pid); } catch { /* ignore */ }
        }
      } catch (error) {
        console.warn('[pi-browser-agent] graceful suspend cleanup failed', error);
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
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code === 'EADDRINUSE') {
          // Another pi process became primary while we were suspended. It now
          // owns 7878 and the bridge; this session's captured primary broker
          // can't proxy, so browser tools here stay inactive until restart.
          console.warn('[pi-browser-agent] another pi instance owns the broker port after resume; browser tools in this session are inactive until it is restarted');
        } else {
          console.warn('[pi-browser-agent] broker restart after resume failed', error);
        }
      }
    })();
  });
}

async function getOrCreateBroker(logger: BrokerLogger): Promise<BrowserAgentBrokerLike> {
  // If an existing broker is healthy, reuse it.
  if (brokerSingleton) {
    const probe = brokerSingleton.probeConnectivity();
    if (probe.brokerListening) {
      return brokerSingleton;
    }
    // Non-listening singleton (e.g. after a prior failure). Drop it and retry.
    brokerSingleton = null;
  }

  // Serialize startup: at most one in-flight start attempt at a time.
  if (brokerStartup) {
    return await brokerStartup;
  }

  brokerStartup = (async () => {
    try {
      const broker = await createAndStartBroker(logger);
      // Only publish a broker as the singleton after a successful bind.
      brokerSingleton = broker;
      return broker;
    } finally {
      // Clear the in-flight promise so subsequent starts can retry on failure.
      brokerStartup = null;
    }
  })();

  return await brokerStartup;
}

export default async function piBrowserAgentExtension(pi: {
  on: (event: string, handler: (_event: unknown, ctx?: ExtensionContextLike) => Promise<void> | void) => void;
  registerTool: (tool: any) => void;
}) {
  const registerSessionTool = async (ctx?: ExtensionContextLike) => {
    resetBrowserAgentToolState();
    resetRegisteredBrowserTools();
    const logger = createUiLogger(ctx);

    try {
      const broker = await getOrCreateBroker(logger);
      startupMessage = null;
      pi.registerTool(createBrowserAgentToolsTool(pi, broker));
      // pi reads the tool registry at session_start; any later registerTool()
      // calls (e.g. from a meta-tool invocation) are dropped. Register the
      // full browser_* suite eagerly whenever the broker is listening. The
      // tools themselves probe the bridge at call time and return structured
      // errors if the Chrome extension bridge is disconnected.
      const probe = broker.probeConnectivity();
      if (probe.brokerListening) {
        registerAllTools(pi, { broker });
      }
    } catch (error) {
      startupMessage = error instanceof Error ? error.message : String(error);
      ctx?.ui?.notify?.(`Browser agent unavailable: ${startupMessage}`, 'error');
      // Install the meta-tool against a non-started fallback broker so the
      // session still exposes a diagnostic surface. Do NOT publish this broker
      // as the singleton — we want a real bind retry on the next session.
      const fallbackBroker = new BrowserAgentBroker({
        logger,
        taskStore: new TaskStore({ dir: join(await ensureStateDir('tasks')) }),
      });
      pi.registerTool(createBrowserAgentToolsTool(pi, fallbackBroker));
      // Intentionally do NOT call registerAllTools here: the fallback broker
      // is not listening, so the full suite would have no working backend.
    }
  };

  // Install once per process so Ctrl+Z releases the broker port instead of
  // freezing it while still bound.
  installSuspendResumeHandlers();

  pi.on('session_start', async (_event, ctx) => {
    await registerSessionTool(ctx);
  });

  pi.on('session_shutdown', async (_event, ctx) => {
    brokerStartup = null;
    if (!brokerSingleton) {
      startupMessage = null;
      return;
    }
    const broker = brokerSingleton;
    brokerSingleton = null;
    startupMessage = null;
    try {
      await broker.stop();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx?.ui?.notify?.(`pi-browser-agent shutdown failed: ${message}`, 'warning');
    } finally {
      try {
        await removeInstanceFile(process.pid);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx?.ui?.notify?.(`pi-browser-agent instance cleanup failed: ${message}`, 'warning');
      }
    }
  });
}

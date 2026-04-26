import { join } from 'node:path';

import { BrowserAgentBroker } from './broker/server.ts';
import { TaskStore } from './broker/task-store.ts';
import { ensureStateDir } from './util/paths.ts';
import { listInstances, removeInstanceFile, writeInstanceFile } from './util/instances.ts';
import { registerAllTools, resetRegisteredBrowserTools } from './tools/_register.ts';
import { createBrowserAgentToolsTool, resetBrowserAgentToolState } from './tools/browser_agent_tools.ts';

let brokerSingleton: BrowserAgentBroker | null = null;
let brokerStartup: Promise<BrowserAgentBroker> | null = null;
let startupMessage: string | null = null;

export function getBroker(): BrowserAgentBroker | null {
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

async function createAndStartBroker(logger: Console): Promise<BrowserAgentBroker> {
  const tasksDir = await ensureStateDir('tasks');
  const broker = new BrowserAgentBroker({
    logger,
    taskStore: new TaskStore({ dir: join(tasksDir) }),
  });
  // start() now throws on fatal startup failure. If we get here it bound successfully.
  await broker.start();
  // GC any stale instance files left behind by previous crashed runs, then
  // publish ourselves so the browser extension can discover us regardless of
  // which port we ended up on.
  try {
    await listInstances({ gcStale: true });
    await writeInstanceFile({
      pid: process.pid,
      port: broker.port,
      host: broker.host,
      url: broker.url,
      cwd: process.cwd(),
      startedAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.warn?.('[pi-browser-agent] failed to publish instance discovery file', error);
  }
  return broker;
}

async function getOrCreateBroker(logger: Console = console): Promise<BrowserAgentBroker> {
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
  on: (event: string, handler: (_event: unknown, ctx?: { ui?: { notify?: (message: string, type?: string) => void } }) => Promise<void> | void) => void;
  registerTool: (tool: any) => void;
}) {
  const registerSessionTool = async (ctx?: { ui?: { notify?: (message: string, type?: string) => void } }) => {
    resetBrowserAgentToolState();
    resetRegisteredBrowserTools();

    try {
      const broker = await getOrCreateBroker();
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
      ctx?.ui?.notify?.(`pi-browser-agent startup failed: ${startupMessage}`, 'error');
      // Install the meta-tool against a non-started fallback broker so the
      // session still exposes a diagnostic surface. Do NOT publish this broker
      // as the singleton — we want a real bind retry on the next session.
      const fallbackBroker = new BrowserAgentBroker({
        taskStore: new TaskStore({ dir: join(await ensureStateDir('tasks')) }),
      });
      pi.registerTool(createBrowserAgentToolsTool(pi, fallbackBroker));
      // Intentionally do NOT call registerAllTools here: the fallback broker
      // is not listening, so the full suite would have no working backend.
    }
  };

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

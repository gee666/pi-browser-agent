import { join } from 'node:path';

import { BrowserAgentBroker } from './broker/server.ts';
import { TaskStore } from './broker/task-store.ts';
import { ensureStateDir } from './util/paths.ts';
import { registerAllTools, resetRegisteredBrowserTools } from './tools/_register.ts';
import { createBrowserAgentToolsTool, resetBrowserAgentToolState, setBrowserAgentToolState } from './tools/browser_agent_tools.ts';

let brokerSingleton: BrowserAgentBroker | null = null;
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
  startupMessage = null;
}

async function getOrCreateBroker(logger: Console = console): Promise<BrowserAgentBroker> {
  if (brokerSingleton) {
    const probe = brokerSingleton.probeConnectivity();
    if (probe.brokerListening) {
      return brokerSingleton;
    }
    brokerSingleton = null;
  }

  const tasksDir = await ensureStateDir('tasks');
  const broker = new BrowserAgentBroker({
    logger,
    taskStore: new TaskStore({ dir: join(tasksDir) }),
  });
  await broker.start();
  brokerSingleton = broker;
  return broker;
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
      const metaTool = createBrowserAgentToolsTool(pi, broker);
      const probe = broker.probeConnectivity();
      startupMessage = probe.startupError || null;
      pi.registerTool(metaTool);
      if (probe.brokerListening) {
        registerAllTools(pi, { broker });
        setBrowserAgentToolState(true);
      }
      if (startupMessage) {
        ctx?.ui?.notify?.(`pi-browser-agent startup warning: ${startupMessage}`, 'warning');
      }
    } catch (error) {
      startupMessage = error instanceof Error ? error.message : String(error);
      ctx?.ui?.notify?.(`pi-browser-agent startup failed: ${startupMessage}`, 'error');
      const fallbackBroker = brokerSingleton ?? new BrowserAgentBroker({
        taskStore: new TaskStore({ dir: join(await ensureStateDir('tasks')) }),
      });
      brokerSingleton = fallbackBroker;
      pi.registerTool(createBrowserAgentToolsTool(pi, fallbackBroker));
    }
  };

  pi.on('session_start', async (_event, ctx) => {
    await registerSessionTool(ctx);
  });

  pi.on('session_shutdown', async (_event, ctx) => {
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
    }
  });
}

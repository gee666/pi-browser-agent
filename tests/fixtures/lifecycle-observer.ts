import { appendFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function observer(pi: ExtensionAPI) {
  const record = (event: string) => {
    appendFileSync(process.env.BA_AUDIT_LOG!, JSON.stringify({
      event,
      suspend: process.listenerCount('SIGTSTP'),
      resume: process.listenerCount('SIGCONT'),
      tools: pi.getAllTools().map((tool) => tool.name)
        .filter((name) => name.startsWith('browser_') || name === 'activate_browser_agent_tools').sort(),
    }) + '\n');
  };
  pi.on('session_start', () => record('start'));
  pi.on('session_shutdown', () => record('shutdown'));
  pi.registerCommand('audit-reload', {
    description: 'Reload the real extension runtime for the compatibility test',
    handler: async (_args, ctx) => { await ctx.reload(); },
  });
}

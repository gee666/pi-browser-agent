import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function getStateDir(): string {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'pi-browser-agent');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'pi-browser-agent');
  }
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'pi-browser-agent');
}

export async function ensureStateDir(subdir?: string): Promise<string> {
  const dir = subdir ? join(getStateDir(), subdir) : getStateDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { discoverAndLoadExtensions, VERSION } from '@earendil-works/pi-coding-agent';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the installed Pi host loads the browser extension and registers its lifecycle handlers', async () => {
  const tempRoot = path.join(root, 'tmp');
  await mkdir(tempRoot, { recursive: true });
  const agentDir = await mkdtemp(path.join(tempRoot, 'pi-compatibility-'));
  try {
    const result = await discoverAndLoadExtensions(
      [path.join(root, 'src/index.ts')],
      root,
      agentDir,
    );
    assert.deepEqual(result.errors, [], `Pi ${VERSION} must load the extension without errors`);
    assert.equal(result.extensions.length, 1);
    const extension = result.extensions[0];
    assert.equal(extension.handlers.get('session_start')?.length, 1);
    assert.equal(extension.handlers.get('session_shutdown')?.length, 1);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

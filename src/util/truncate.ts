import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_MAX_BYTES = 50_000;
export const DEFAULT_MAX_LINES = 2_000;

export async function truncateAndSpill(text: string, ext = 'txt', maxBytes = DEFAULT_MAX_BYTES, maxLines = DEFAULT_MAX_LINES) {
  const lines = text.split('\n');
  const truncatedLines = lines.slice(0, maxLines);
  let content = truncatedLines.join('\n');
  let truncated = truncatedLines.length < lines.length;

  if (Buffer.byteLength(content, 'utf8') > maxBytes) {
    truncated = true;
    while (Buffer.byteLength(content, 'utf8') > maxBytes && truncatedLines.length > 0) {
      truncatedLines.pop();
      content = truncatedLines.join('\n');
    }
  }

  if (!truncated) {
    return { text: content, truncated: false, fullOutputPath: undefined };
  }

  const fullOutputPath = join(tmpdir(), `pi-browser-agent-${randomBytes(6).toString('hex')}.${ext}`);
  await writeFile(fullOutputPath, text, 'utf8');
  return {
    text: `${content}\n\n[Output truncated. Full output: ${fullOutputPath}]`,
    truncated: true,
    fullOutputPath,
  };
}

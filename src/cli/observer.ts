import type { Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { writeAccentBlock } from './accent-block.js';

export function writeObserver(
  message: string,
  output: Writable & { isTTY?: boolean; columns?: number } = process.stderr,
): void {
  const text = stripVTControlCharacters(message).replace(/\s+/g, ' ').trim();
  if (!text) return;
  if (!output.isTTY) {
    output.write(`Observer: ${text}\n`);
    return;
  }

  writeAccentBlock('Observer', text, output);
}

import type { Writable } from 'node:stream';
import { stripVTControlCharacters, styleText } from 'node:util';
import * as prompts from '@clack/prompts';
import { wrapAnsi } from 'fast-wrap-ansi';

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

  // Reserve the guide's three columns and avoid the terminal's last column.
  const width = Math.max(1, (output.columns || 80) - 4);
  const border = styleText('cyan', prompts.S_BAR, { stream: output });
  const heading = styleText(
    ['bold', 'cyan'],
    wrapAnsi('Observer', width, { hard: true }),
    { stream: output },
  );
  output.write('\n');
  prompts.log.message(`${heading}\n${wrapAnsi(text, width, { hard: true })}`, {
    output,
    withGuide: true,
    symbol: border,
    secondarySymbol: border,
    spacing: 0,
  });
  output.write('\n');
}

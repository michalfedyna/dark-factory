import type { Writable } from 'node:stream';
import { styleText } from 'node:util';
import * as prompts from '@clack/prompts';
import { wrapAnsi } from 'fast-wrap-ansi';

/** Render sanitized text as a terminal-width accent block. */
export function writeAccentBlock(
  title: string,
  text: string,
  output: Writable & { columns?: number },
): void {
  // Reserve the guide's three columns and avoid the terminal's last column.
  const width = Math.max(1, (output.columns || 80) - 4);
  const border = styleText('cyan', prompts.S_BAR, { stream: output });
  const heading = styleText(
    ['bold', 'cyan'],
    wrapAnsi(title, width, { hard: true }),
    { stream: output },
  );
  const body = wrapAnsi(text, width, { hard: true, trim: false })
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');
  output.write('\n');
  prompts.log.message(`${heading}\n${body}`, {
    output,
    withGuide: true,
    symbol: border,
    secondarySymbol: border,
    spacing: 0,
  });
  output.write('\n');
}

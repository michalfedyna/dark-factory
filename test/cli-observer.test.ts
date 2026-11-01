import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { S_BAR } from '@clack/prompts';
import { writeObserver } from '../src/cli/observer.js';
import { captureTerminalOutput as terminal } from './fixtures/terminal.js';

afterEach(() => vi.unstubAllEnvs());

describe('Observer terminal output', () => {
  test('renders a cyan accent block with a bold heading and surrounding blank lines', () => {
    vi.stubEnv('NO_COLOR', undefined);
    vi.stubEnv('NODE_DISABLE_COLORS', undefined);
    vi.stubEnv('FORCE_COLOR', '1');
    const { output, log } = terminal();

    writeObserver('Tests are running.', output);

    expect(stripVTControlCharacters(log())).toBe(
      `\n${S_BAR}  Observer\n${S_BAR}  Tests are running.\n\n`,
    );
    expect(log()).toContain(`\u001b[36m${S_BAR}\u001b[39m`);
    expect(log()).toContain('\u001b[1m\u001b[36mObserver\u001b[39m\u001b[22m');
    expect(log()).not.toContain('\u001b[36mTests are running.');
  });

  test('keeps the accent layout without escape codes under NO_COLOR', () => {
    vi.stubEnv('FORCE_COLOR', undefined);
    vi.stubEnv('NO_COLOR', '1');
    const { output, log } = terminal();

    writeObserver('Tests are running.', output);

    expect(log()).toBe(
      `\n${S_BAR}  Observer\n${S_BAR}  Tests are running.\n\n`,
    );
  });

  test('keeps redirected output plain even when colors are forced', () => {
    vi.stubEnv('FORCE_COLOR', '1');
    const { output, log } = terminal(false, 20);

    writeObserver('Implementation is complete. Tests are running.', output);

    expect(log()).toBe(
      'Observer: Implementation is complete. Tests are running.\n',
    );
  });

  test('wraps at word boundaries and keeps the border on continuation lines', () => {
    const { output, log } = terminal(true, 30);

    writeObserver('Implementation is complete. Tests are running.', output);

    expect(stripVTControlCharacters(log())).toBe(
      [
        '',
        `${S_BAR}  Observer`,
        `${S_BAR}  Implementation is`,
        `${S_BAR}  complete. Tests are`,
        `${S_BAR}  running.`,
        '',
        '',
      ].join('\n'),
    );
  });

  test('wraps long unbroken tokens without losing content', () => {
    const { output, log } = terminal(true, 16);

    writeObserver('abcdefghijklmnopqrstuvwxyz', output);

    expect(stripVTControlCharacters(log())).toBe(
      `\n${S_BAR}  Observer\n${S_BAR}  abcdefghijkl\n${S_BAR}  mnopqrstuvwx\n${S_BAR}  yz\n\n`,
    );
  });

  test('counts wide Unicode characters as terminal columns', () => {
    const { output, log } = terminal(true, 12);

    writeObserver('界'.repeat(9), output);

    expect(stripVTControlCharacters(log())).toBe(
      `\n${S_BAR}  Observer\n${S_BAR}  界界界界\n${S_BAR}  界界界界\n${S_BAR}  界\n\n`,
    );
  });

  test('uses an 80-column fallback when the terminal width is unavailable', () => {
    const { output, log } = terminal();

    writeObserver('a'.repeat(77), output);

    expect(stripVTControlCharacters(log())).toBe(
      `\n${S_BAR}  Observer\n${S_BAR}  ${'a'.repeat(76)}\n${S_BAR}  a\n\n`,
    );
  });

  test('reads the current width for each update after a terminal resize', () => {
    const { output, log } = terminal(true, 80);
    writeObserver('Tests are running.', output);
    output.columns = 16;
    writeObserver('Tests are running.', output);

    expect(stripVTControlCharacters(log())).toBe(
      `\n${S_BAR}  Observer\n${S_BAR}  Tests are running.\n\n` +
        `\n${S_BAR}  Observer\n${S_BAR}  Tests are\n${S_BAR}  running.\n\n`,
    );
  });

  test('separates Observer blocks from each other and adjacent output', () => {
    const { output, log } = terminal();
    output.write('Inspecting repository\n');
    writeObserver('Reading manifests.', output);
    writeObserver('Reading source.', output);
    output.write('Preparing delivery\n');

    expect(stripVTControlCharacters(log())).toBe(
      [
        'Inspecting repository',
        '',
        `${S_BAR}  Observer`,
        `${S_BAR}  Reading manifests.`,
        '',
        '',
        `${S_BAR}  Observer`,
        `${S_BAR}  Reading source.`,
        '',
        'Preparing delivery',
        '',
      ].join('\n'),
    );
  });

  test.each([true, false])(
    'strips model-supplied escape codes and collapses whitespace (TTY: %s)',
    (isTTY) => {
      const { output, log } = terminal(isTTY);

      writeObserver(
        '\u001b[2J\u001b[31mTests\u001b[0m\n\t are running.  ',
        output,
      );

      const text = stripVTControlCharacters(log());
      expect(text).toContain('Tests are running.\n');
      expect(log()).not.toContain('\u001b[2J');
      expect(log()).not.toContain('\u001b[31m');
      expect(text).not.toContain('\t');
    },
  );

  test('does not print an empty block for blank summaries', () => {
    const { output, log } = terminal();

    writeObserver('\u001b[31m \n\t\u001b[0m', output);

    expect(log()).toBe('');
  });
});

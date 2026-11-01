import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as prompts from '@clack/prompts';
import { CancelledError, createTerminal } from '../src/cli/terminal.js';
import { captureTerminalOutput } from './fixtures/terminal.js';

vi.mock('@clack/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clack/prompts')>();
  return { ...actual, text: vi.fn(), select: vi.fn() };
});
const terminals: ReturnType<typeof createTerminal>[] = [];
afterEach(() => {
  terminals.splice(0).forEach((terminal) => {
    terminal.close();
  });
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});
const question = {
  question: 'Which format?',
  context: '',
  options: ['CSV', 'JSON'],
};
const implementationQuestion = {
  question: 'Implement this brief?',
  contextTitle: 'Implementation plan',
  context:
    '{\n  "allowedPaths": ["src"],\n  "warning": "Trusted repositories only."\n}',
  options: ['Implement', 'Stop'],
};
function terminal(interactive = false, isTTY = interactive, columns?: number) {
  const input = Object.assign(new PassThrough(), { isTTY: interactive });
  const { output, log } = captureTerminalOutput(isTTY, columns);
  const cancel = vi.fn((): never => {
    throw new CancelledError();
  });
  const client = createTerminal({ input, output, cancel });
  terminals.push(client);
  return { client, input, cancel, log };
}

describe('CLI interaction', () => {
  test('buffers piped issue and answers across multiple prompts', async () => {
    const { client, input } = terminal();
    input.end('Export issues\n1\nA custom answer\n');
    const signal = new AbortController().signal;
    expect(await client.issue(signal)).toBe('Export issues');
    expect(await client.ask(question, signal)).toBe('CSV');
    expect(await client.ask({ ...question, options: [] }, signal)).toBe(
      'A custom answer',
    );
  });
  test('piped answers allow free text even when choices exist', async () => {
    const { client, input } = terminal();
    input.end('CSV with a header row\n');
    expect(await client.ask(question, new AbortController().signal)).toBe(
      'CSV with a header row',
    );
  });
  test('blank input is rejected and EOF never counts as confirmation', async () => {
    const { client, input, log } = terminal();
    input.end(' \n');
    await expect(
      client.ask(question, new AbortController().signal),
    ).rejects.toThrow('Input ended');
    expect(log()).toContain('Enter 1–16,000 characters.');
  });
  test('aborts a pending line read', async () => {
    const { client } = terminal();
    const controller = new AbortController();
    const pending = client.issue(controller.signal);
    controller.abort(new Error('Stopped.'));
    await expect(pending).rejects.toThrow('Stopped.');
  });
  test('uses Clack choices in a terminal and always offers Other', async () => {
    const { client } = terminal(true);
    vi.mocked(prompts.select).mockResolvedValue(0);
    expect(await client.ask(question, new AbortController().signal)).toBe(
      'CSV',
    );
    expect(prompts.select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: [
          { value: 0, label: 'CSV' },
          { value: 1, label: 'JSON' },
          { value: -1, label: 'Other' },
        ],
      }),
    );
  });
  test('Other opens a free-text Clack prompt', async () => {
    const { client } = terminal(true);
    vi.mocked(prompts.select).mockResolvedValue(-1);
    vi.mocked(prompts.text).mockResolvedValue(' CSV with headers ');
    expect(await client.ask(question, new AbortController().signal)).toBe(
      'CSV with headers',
    );
  });
  test('Clack cancellation calls the cancellation handler', async () => {
    const { client, cancel } = terminal(true);
    vi.mocked(prompts.text).mockResolvedValue(prompts.CANCEL_SYMBOL);
    await expect(client.issue(new AbortController().signal)).rejects.toThrow(
      'Cancelled.',
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
  test('strips terminal escape sequences from model-provided display text', async () => {
    const { client, input, log } = terminal();
    input.end('CSV\n');
    await client.ask(
      {
        question: '\u001b[31mWhich format?\u001b[0m',
        context: '\u001b[2JContext',
        options: [],
      },
      new AbortController().signal,
    );
    expect(log()).toContain('Which format?');
    expect(log()).not.toContain('\u001b');
  });
  test('highlights the implementation plan without flattening its content', async () => {
    vi.stubEnv('NO_COLOR', undefined);
    vi.stubEnv('NODE_DISABLE_COLORS', undefined);
    vi.stubEnv('FORCE_COLOR', '1');
    const { client, log } = terminal(true);
    vi.mocked(prompts.select).mockResolvedValue(0);

    expect(
      await client.ask(implementationQuestion, new AbortController().signal),
    ).toBe('Implement');

    expect(stripVTControlCharacters(log())).toBe(
      [
        '',
        `${prompts.S_BAR}  Implementation plan`,
        `${prompts.S_BAR}  {`,
        `${prompts.S_BAR}    "allowedPaths": ["src"],`,
        `${prompts.S_BAR}    "warning": "Trusted repositories only."`,
        `${prompts.S_BAR}  }`,
        '',
        '',
      ].join('\n'),
    );
    expect(log()).toContain(`\u001b[36m${prompts.S_BAR}\u001b[39m`);
    expect(log()).toContain(
      '\u001b[1m\u001b[36mImplementation plan\u001b[39m\u001b[22m',
    );
    expect(log()).not.toContain('\u001b[36m{');
  });
  test('keeps plan content and wrapping under NO_COLOR', async () => {
    vi.stubEnv('FORCE_COLOR', undefined);
    vi.stubEnv('NO_COLOR', '1');
    const { client, log } = terminal(true, true, 25);
    vi.mocked(prompts.select).mockResolvedValue(1);

    expect(
      await client.ask(
        {
          ...implementationQuestion,
          context: 'Allowed paths\n  src\n\nRun checks before implementation.',
        },
        new AbortController().signal,
      ),
    ).toBe('Stop');

    expect(log()).toBe(
      [
        '',
        `${prompts.S_BAR}  Implementation plan`,
        `${prompts.S_BAR}  Allowed paths`,
        `${prompts.S_BAR}    src`,
        prompts.S_BAR,
        `${prompts.S_BAR}  Run checks before`,
        `${prompts.S_BAR}  implementation.`,
        '',
        '',
      ].join('\n'),
    );
  });
  test.each([true, false])(
    'keeps redirected plans plain even with forced colors (interactive input: %s)',
    async (interactive) => {
      vi.stubEnv('FORCE_COLOR', '1');
      const { client, input, log } = terminal(interactive, false);
      vi.mocked(prompts.select).mockResolvedValue(0);
      if (!interactive) input.end('Implement\n');

      await client.ask(implementationQuestion, new AbortController().signal);

      const context = `Implementation plan\n${implementationQuestion.context}\n\n`;
      expect(log()).toBe(
        interactive
          ? context
          : `${context}Implement this brief?\n  1. Implement\n  2. Stop\n>\n`,
      );
    },
  );
  test('uses the output TTY for plan styling even with piped input', async () => {
    const { client, input, log } = terminal(false, true);
    input.end('Stop\n');

    expect(
      await client.ask(implementationQuestion, new AbortController().signal),
    ).toBe('Stop');

    expect(stripVTControlCharacters(log())).toContain(
      `\n${prompts.S_BAR}  Implementation plan\n${prompts.S_BAR}  {\n`,
    );
    expect(log()).toContain('  1. Implement\n  2. Stop\n>\n');
  });
  test('sanitizes both the plan heading and content', async () => {
    vi.stubEnv('FORCE_COLOR', undefined);
    vi.stubEnv('NO_COLOR', '1');
    const { client, log } = terminal(true);
    vi.mocked(prompts.select).mockResolvedValue(0);

    await client.ask(
      {
        ...implementationQuestion,
        contextTitle: '\u001b[31mImplementation plan\u001b[0m',
        context: '\u001b[2JAllowed paths\n  src',
      },
      new AbortController().signal,
    );

    expect(log()).toBe(
      `\n${prompts.S_BAR}  Implementation plan\n${prompts.S_BAR}  Allowed paths\n${prompts.S_BAR}    src\n\n`,
    );
  });
  test('leaves ordinary question context unchanged', async () => {
    const { client, log } = terminal(true);
    vi.mocked(prompts.select).mockResolvedValue(0);

    await client.ask(
      { ...question, context: 'Export formats\nCSV or JSON' },
      new AbortController().signal,
    );

    expect(log()).toBe('Export formats\nCSV or JSON\n\n');
  });
  test('does not show a heading for empty context', async () => {
    const { client, log } = terminal(true);
    vi.mocked(prompts.select).mockResolvedValue(0);

    await client.ask(
      { ...implementationQuestion, context: '' },
      new AbortController().signal,
    );

    expect(log()).toBe('');
  });
});

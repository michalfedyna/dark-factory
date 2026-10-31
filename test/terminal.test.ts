import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as prompts from '@clack/prompts';
import { CancelledError, createTerminal } from '../src/cli/terminal.js';

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
});
const question = {
  question: 'Which format?',
  context: '',
  options: ['CSV', 'JSON'],
};
function terminal(interactive = false) {
  const input = Object.assign(new PassThrough(), { isTTY: interactive });
  const output = new PassThrough();
  let log = '';
  output.on('data', (chunk: Buffer) => {
    log += chunk.toString();
  });
  const cancel = vi.fn((): never => {
    throw new CancelledError();
  });
  const client = createTerminal({ input, output, cancel });
  terminals.push(client);
  return { client, input, cancel, log: () => log };
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
});

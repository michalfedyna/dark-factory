import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import * as prompts from '@clack/prompts';
import {
  answerSchema,
  questionSchema,
  type Ask,
} from '../contracts/interaction.js';

export class CancelledError extends Error {
  constructor() {
    super('Cancelled.');
  }
}

export function createTerminal(options: {
  input?: Readable & { isTTY?: boolean };
  output?: Writable;
  cancel: () => never;
}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  const interactive = Boolean(input.isTTY);
  // Keep one line reader for the whole run so piped answers are buffered, not lost
  // between model calls. EOF never counts as an answer or confirmation.
  const reader = interactive
    ? null
    : createInterface({ input, crlfDelay: Infinity });
  const lines = reader?.[Symbol.asyncIterator]();
  const clean = stripVTControlCharacters;

  const readLine = async (signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted();
    if (!lines) throw new Error('Line input is not available.');
    const result = await new Promise<IteratorResult<string>>(
      (resolve, reject) => {
        const onAbort = () => {
          reader?.close();
          const reason: unknown = signal.reason;
          reject(reason instanceof Error ? reason : new CancelledError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        void lines
          .next()
          .then(resolve, reject)
          .finally(() => {
            signal.removeEventListener('abort', onAbort);
          });
      },
    );
    signal.throwIfAborted();
    if (result.done)
      throw new Error(
        'Input ended before the workflow finished. Provide an answer for every question or run in an interactive terminal.',
      );
    return result.value;
  };

  const text = async (
    message: string,
    signal: AbortSignal,
  ): Promise<string> => {
    signal.throwIfAborted();
    if (interactive) {
      const value = await prompts.text({
        message: clean(message),
        input,
        output,
        signal,
        withGuide: false,
        validate: (value) =>
          answerSchema.safeParse(value).success
            ? undefined
            : 'Enter 1–16,000 characters.',
      });
      signal.throwIfAborted();
      if (prompts.isCancel(value)) return options.cancel();
      return answerSchema.parse(value);
    }
    output.write(`${clean(message)}\n`);
    while (true) {
      const value = answerSchema.safeParse(await readLine(signal));
      if (value.success) return value.data;
      output.write('Enter 1–16,000 characters.\n');
    }
  };

  const ask: Ask = async (inputQuestion, signal) => {
    signal.throwIfAborted();
    const question = questionSchema.parse(inputQuestion);
    if (question.context) output.write(`${clean(question.context)}\n\n`);
    if (interactive && question.options.length > 0) {
      const selected = await prompts.select({
        message: clean(question.question),
        input,
        output,
        signal,
        withGuide: false,
        showInstructions: false,
        options: [
          ...question.options.map((label, value) => ({
            value,
            label: clean(label),
          })),
          { value: -1, label: 'Other' },
        ],
      });
      signal.throwIfAborted();
      if (prompts.isCancel(selected)) return options.cancel();
      if (selected !== -1)
        return answerSchema.parse(question.options[selected]);
      return text(question.question, signal);
    }
    if (!interactive && question.options.length > 0) {
      output.write(
        `${clean(question.question)}\n${question.options.map((option, index) => `  ${index + 1}. ${clean(option)}`).join('\n')}\n`,
      );
      const value = await text('>', signal);
      const index = /^\d+$/.test(value) ? Number(value) - 1 : -1;
      return question.options[index] ?? value;
    }
    return text(question.question, signal);
  };
  return {
    issue: (signal: AbortSignal) => text('Issue', signal),
    ask,
    close: () => {
      reader?.close();
      input.pause();
    },
  };
}

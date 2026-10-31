import { randomUUID } from 'node:crypto';
import type { Explore } from '../agents/exploration.js';
import {
  answerSchema,
  issueInputSchema,
  questionSchema,
  type Ask,
} from '../contracts/interaction.js';
import { issueBriefSchema, type IssueBrief } from '../contracts/issue.js';

class OutputError extends Error {
  constructor(cause: unknown) {
    super(
      'Cannot save the issue brief. Check outputDir and file permissions.',
      { cause },
    );
  }
}

export async function runExploration(options: {
  issue: unknown;
  explore: Explore;
  ask: Ask;
  save: (id: string, brief: IssueBrief) => Promise<string>;
  signal: AbortSignal;
  timeoutMs: number;
}) {
  const issue = issueInputSchema.parse(options.issue);
  const id = randomUUID();
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new Error('Exploration timed out.'));
  }, options.timeoutMs);
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  let abort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      const reason: unknown = signal.reason;
      reject(
        reason instanceof Error ? reason : new Error('Exploration cancelled.'),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
  });
  let asking = false;
  const ask: Ask = async (question) => {
    signal.throwIfAborted();
    if (asking) throw new Error('Ask one question at a time.');
    asking = true;
    try {
      const answer = await options.ask(questionSchema.parse(question), signal);
      signal.throwIfAborted();
      return answerSchema.parse(answer);
    } finally {
      asking = false;
    }
  };
  const work = async () => {
    signal.throwIfAborted();
    const result = await options.explore(issue, ask, signal);
    signal.throwIfAborted();
    const brief = issueBriefSchema.parse(result);
    let outputFile: string;
    try {
      outputFile = await options.save(id, brief);
    } catch (error) {
      throw new OutputError(error);
    }
    signal.throwIfAborted();
    return { id, brief, outputFile };
  };
  try {
    return await Promise.race([work(), aborted]);
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (error instanceof OutputError) throw error;
    throw new Error(
      'Exploration failed or returned an invalid brief. Check router authentication/model access and try again.',
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    deadline.abort(new Error('Exploration ended.'));
  }
}

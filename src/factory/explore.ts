import { RequestContext } from '@mastra/core/request-context';
import { issueInputSchema, type Ask } from '../contracts/interaction.js';
import type { createExplorationWorkflow } from '../workflows/exploration.js';

const explorationError =
  'Exploration failed or returned an invalid brief. Check router authentication/model access and try again.';

export async function runExploration(options: {
  issue: unknown;
  workflow: ReturnType<typeof createExplorationWorkflow>;
  ask: Ask;
  signal: AbortSignal;
  timeoutMs: number;
}) {
  const issue = issueInputSchema.parse(options.issue);
  options.signal.throwIfAborted();
  const run = await options.workflow.createRun();
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new Error('Exploration timed out.'));
  }, options.timeoutMs);
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  const requestContext = new RequestContext<{
    ask: Ask;
    signal: AbortSignal;
  }>([
    ['ask', options.ask],
    ['signal', signal],
  ]);
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
  try {
    signal.throwIfAborted();
    // Keep the CLI deadline bounded even if a step ignores cancellation.
    const result = await Promise.race([
      run
        .start({ inputData: { issue }, requestContext })
        .catch((error: unknown) => {
          throw new Error(explorationError, { cause: error });
        }),
      aborted,
    ]);
    signal.throwIfAborted();
    if (result.status === 'success') return result.result;
    throw new Error(
      result.steps['save-brief']?.status === 'failed'
        ? 'Cannot save the issue brief. Check outputDir and file permissions.'
        : explorationError,
      { cause: result.status === 'failed' ? result.error : undefined },
    );
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    const cancelled = signal.aborted;
    deadline.abort(new Error('Exploration ended.'));
    if (cancelled) await run.cancel();
  }
}

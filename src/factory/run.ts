import { RequestContext } from '@mastra/core/request-context';
import { issueInputSchema, type Ask } from '../contracts/interaction.js';
import type { Observe } from '../contracts/progress.js';
import type {
  createDefaultWorkflow,
  DeliveryOperations,
} from '../workflows/default.js';

const explorationError =
  'Exploration failed or returned an invalid brief. Check router authentication/model access and try again.';
const workflowError =
  'Workflow failed. Check repository access, QA prerequisites, model access, and any run artifacts. No failed gate authorizes publication.';

export async function runDefault(options: {
  issue: unknown;
  ask: Ask;
  progress: (message: string) => void;
  observe?: Observe;
  workflow: ReturnType<typeof createDefaultWorkflow>;
  runtime: (
    runId: string,
    signal: AbortSignal,
  ) => { operations: DeliveryOperations; close: () => Promise<void> };
  signal: AbortSignal;
  timeoutMs: number;
}) {
  const issue = issueInputSchema.parse(options.issue);
  options.signal.throwIfAborted();
  const run = await options.workflow.createRun();
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new Error('Workflow timed out.'));
  }, options.timeoutMs);
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  let runtime: ReturnType<typeof options.runtime> | undefined;
  let abort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('Workflow cancelled.'),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    signal.throwIfAborted();
    runtime = options.runtime(run.runId, signal);
    const result = await Promise.race([
      run
        .start({
          inputData: { issue },
          requestContext: new RequestContext([
            ['ask', options.ask],
            ['progress', options.progress],
            ['observe', options.observe ?? (() => {})],
            ['operations', runtime.operations],
            ['signal', signal],
          ]),
        })
        .catch((error: unknown) => {
          throw new Error(workflowError, { cause: error });
        }),
      aborted,
    ]);
    signal.throwIfAborted();
    if (result.status !== 'success') {
      throw new Error(
        result.steps['explore-issue']?.status === 'failed'
          ? explorationError
          : workflowError,
      );
    }
    return result.result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    const cancelled = signal.aborted;
    deadline.abort(new Error('Workflow ended.'));
    try {
      if (cancelled) await run.cancel();
    } finally {
      await runtime?.close();
    }
  }
}

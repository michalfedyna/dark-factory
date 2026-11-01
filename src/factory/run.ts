import { RequestContext } from '@mastra/core/request-context';
import { issueInputSchema, type Ask } from '../contracts/interaction.js';
import type { Observe } from '../contracts/progress.js';
import type { createDefaultWorkflow } from '../workflows/default.js';
import type { DeliveryOperations } from '../delivery/operations.js';
import { PublicationError } from '../integrations/github/publish.js';

const explorationError =
  'Exploration failed or returned an invalid brief. Check router authentication/model access and try again.';
const workflowError =
  'Workflow failed. Check repository access, QA prerequisites, model access, and any run artifacts. No failed gate authorizes publication.';

export async function runDefault(options: {
  issue: unknown;
  ask: Ask;
  progress: (message: string) => void;
  observe?: Observe;
  onDeliveryStart?: (signal: AbortSignal) => void;
  workflow: ReturnType<typeof createDefaultWorkflow>;
  runtime: (
    runId: string,
    signal: AbortSignal,
  ) => { operations: DeliveryOperations; close: () => Promise<void> };
  signal: AbortSignal;
}) {
  const issue = issueInputSchema.parse(options.issue);
  options.signal.throwIfAborted();
  const run = await options.workflow.createRun();
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
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
            ['onDeliveryStart', () => options.onDeliveryStart?.(signal)],
            ['operations', runtime.operations],
            ['signal', signal],
          ]),
        })
        .catch((error: unknown) => {
          if (error instanceof PublicationError) throw error;
          throw new Error(workflowError, { cause: error });
        }),
      aborted,
    ]);
    signal.throwIfAborted();
    if (result.status !== 'success') {
      const publication = result.steps['publish-delivery'];
      if (
        publication?.status === 'failed' &&
        publication.error instanceof PublicationError
      )
        throw publication.error;
      throw new Error(
        result.steps['explore-issue']?.status === 'failed'
          ? explorationError
          : workflowError,
      );
    }
    return result.result;
  } finally {
    signal.removeEventListener('abort', abort);
    const cancelled = signal.aborted;
    lifetime.abort(new Error('Workflow ended.'));
    try {
      if (cancelled) await run.cancel();
    } finally {
      await runtime?.close();
    }
  }
}

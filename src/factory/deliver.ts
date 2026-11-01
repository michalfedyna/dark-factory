import { RequestContext } from '@mastra/core/request-context';
import type { IssueBrief } from '../contracts/issue.js';
import type {
  createDeliveryWorkflow,
  DeliveryOperations,
} from '../workflows/delivery.js';

const deliveryError =
  'Delivery failed. Check the saved run artifacts, approved scope, QA prerequisites, and model access. No failed gate authorizes publication.';

export async function runDelivery(options: {
  brief: IssueBrief;
  workflow: ReturnType<typeof createDeliveryWorkflow>;
  runtime: (
    runId: string,
    signal: AbortSignal,
  ) => { operations: DeliveryOperations; close: () => Promise<void> };
  signal: AbortSignal;
  timeoutMs: number;
}) {
  options.signal.throwIfAborted();
  const run = await options.workflow.createRun();
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new Error('Delivery timed out.'));
  }, options.timeoutMs);
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  const runtime = options.runtime(run.runId, signal);
  let abort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('Delivery cancelled.'),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    signal.throwIfAborted();
    const result = await Promise.race([
      run
        .start({
          inputData: { brief: options.brief },
          requestContext: new RequestContext([
            ['operations', runtime.operations],
            ['signal', signal],
          ]),
        })
        .catch((error: unknown) => {
          throw new Error(deliveryError, { cause: error });
        }),
      aborted,
    ]);
    signal.throwIfAborted();
    if (result.status !== 'success') {
      throw new Error(deliveryError);
    }
    return result.result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    const cancelled = signal.aborted;
    deadline.abort(new Error('Delivery ended.'));
    if (cancelled) await run.cancel();
    await runtime.close();
  }
}

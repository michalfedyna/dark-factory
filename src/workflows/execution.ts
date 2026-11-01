import type { DeliveryState } from '../contracts/delivery.js';
import { RunFailure, type StepEvent } from '../contracts/diagnostics.js';
import type { DeliveryOperations } from '../delivery/operations.js';
import { DeliveryStepFailure } from '../delivery/failure.js';
import { PublicationError } from '../delivery/publication.js';

/** Record native step callbacks; Mastra still owns all sequencing and run state. */
export async function executeRecordedStep<T>(options: {
  step: string;
  state: DeliveryState | null;
  operations: DeliveryOperations;
  signal: AbortSignal;
  execute: () => Promise<T>;
  skip?: () => { reason: string; result: T } | null;
  resultState?: (result: T) => DeliveryState;
  onFailure: (error: Error) => void;
}): Promise<T> {
  const { step, state, operations, signal } = options;
  signal.throwIfAborted();
  const started = Date.now();
  const event = (
    status: StepEvent['status'],
    reason?: string,
    context = state,
  ): StepEvent => ({
    step,
    status,
    round: context?.round ?? 0,
    attempt:
      (context?.implementationAttempts.length ?? 0) +
      (step === 'implement' && context === state && status !== 'skipped'
        ? 1
        : 0),
    revision: context?.history.at(-1)?.revision ?? null,
    ...(context ? { deliveryStatus: context.status } : {}),
    timestamp: new Date().toISOString(),
    ...(status !== 'started' ? { durationMs: Date.now() - started } : {}),
    ...(reason || context?.reason
      ? { reason: (reason || context?.reason || '').slice(0, 2_000) }
      : {}),
  });
  try {
    await operations.recordStep(event('started'));
    signal.throwIfAborted();
    const skipped = options.skip?.();
    if (skipped) {
      await operations.recordStep(event('skipped', skipped.reason));
      return skipped.result;
    }
    const result = await options.execute();
    signal.throwIfAborted();
    await operations.recordStep(
      event('completed', undefined, options.resultState?.(result) ?? state),
    );
    return result;
  } catch (error) {
    const cancelled = signal.aborted && !(signal.reason instanceof RunFailure);
    try {
      await operations.recordStep(
        event(
          cancelled ? 'cancelled' : 'failed',
          cancelled
            ? 'Workflow cancelled.'
            : 'See failure.json for private error details.',
        ),
      );
    } catch {
      // Keep the execution failure if diagnostic storage also failed.
    }
    if (cancelled) signal.throwIfAborted();
    let path: string | undefined;
    try {
      path = await operations.recordFailure(step, state, error);
    } catch {
      // The stage and original cause still survive without a writable journal.
    }
    const failure =
      error instanceof PublicationError
        ? error
        : new DeliveryStepFailure(step, path, error);
    options.onFailure(failure);
    throw failure;
  }
}

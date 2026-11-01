import { createStep } from '@mastra/core/workflows';
import { z } from 'zod';
import type { Explore } from '../agents/exploration.js';
import type { Observe } from '../contracts/progress.js';
import {
  answerSchema,
  issueInputSchema,
  questionSchema,
  type Ask,
} from '../contracts/interaction.js';
import {
  deliveryResultSchema,
  deliveryStateSchema,
} from '../contracts/delivery.js';
import { issueBriefSchema } from '../contracts/issue.js';
import type { DeliveryOperations } from '../delivery/operations.js';
import type { DeliveryStep } from '../delivery/steps.js';

export const inputSchema = z.strictObject({ issue: issueInputSchema });
export const requestContextSchema = z.object({
  ask: z.custom<Ask>((value) => typeof value === 'function'),
  progress: z.custom<(message: string) => void>(
    (value) => typeof value === 'function',
  ),
  operations: z.custom<DeliveryOperations>(
    (value) => typeof value === 'object' && value !== null,
  ),
  signal: z.instanceof(AbortSignal),
  observe: z.custom<Observe>((value) => typeof value === 'function').optional(),
  onDeliveryStart: z
    .custom<() => void>((value) => typeof value === 'function')
    .optional(),
});

export function createExploreStep(explore: Explore) {
  return createStep({
    id: 'explore-issue',
    inputSchema,
    outputSchema: issueBriefSchema,
    requestContextSchema,
    execute: async ({ inputData, requestContext, abortSignal }) => {
      const exploration = new AbortController();
      const signal = AbortSignal.any([
        abortSignal,
        requestContext.get('signal'),
        exploration.signal,
      ]);
      signal.throwIfAborted();
      requestContext.get('progress')('Exploring');
      let asking = false;
      const ask: Ask = async (question) => {
        signal.throwIfAborted();
        if (asking) throw new Error('Ask one question at a time.');
        asking = true;
        try {
          const answer = await requestContext.get('ask')(
            questionSchema.parse(question),
            signal,
          );
          signal.throwIfAborted();
          return answerSchema.parse(answer);
        } finally {
          asking = false;
        }
      };
      try {
        const brief = await explore(
          inputData.issue,
          ask,
          signal,
          requestContext.get('observe'),
        );
        signal.throwIfAborted();
        return issueBriefSchema.parse(brief);
      } finally {
        exploration.abort(new Error('Exploration ended.'));
      }
    },
  });
}

export const prepare = createStep({
  id: 'prepare-delivery',
  inputSchema: issueBriefSchema,
  outputSchema: deliveryStateSchema,
  requestContextSchema,
  execute: async ({ inputData, requestContext, abortSignal }) => {
    const signal = AbortSignal.any([abortSignal, requestContext.get('signal')]);
    signal.throwIfAborted();
    if (inputData.readiness !== 'ready' || !inputData.confirmedByUser)
      throw new Error('Delivery requires a confirmed, ready brief.');
    requestContext.get('onDeliveryStart')?.();
    requestContext.get('progress')('Preparing delivery');
    const baseRevision = await requestContext
      .get('operations')
      .prepare(inputData, signal);
    signal.throwIfAborted();
    return {
      brief: inputData,
      baseRevision,
      round: 0,
      status: 'repair' as const,
      reason: '',
      history: [],
      summary: null,
    };
  },
});

export function deliveryStep(id: string, execute: DeliveryStep) {
  return createStep({
    id,
    inputSchema: deliveryStateSchema,
    outputSchema: deliveryStateSchema,
    requestContextSchema,
    execute: async ({ inputData, requestContext, abortSignal }) => {
      const signal = AbortSignal.any([
        abortSignal,
        requestContext.get('signal'),
      ]);
      signal.throwIfAborted();
      const operations = requestContext.get('operations');
      const state = await execute(inputData, operations, signal);
      signal.throwIfAborted();
      await operations.record(state);
      return state;
    },
  });
}

export const finish = createStep({
  id: 'publish-delivery',
  inputSchema: deliveryStateSchema,
  outputSchema: deliveryResultSchema,
  requestContextSchema,
  execute: async ({ inputData, requestContext, abortSignal }) => {
    const signal = AbortSignal.any([abortSignal, requestContext.get('signal')]);
    signal.throwIfAborted();
    return deliveryResultSchema.parse(
      await requestContext.get('operations').finish(inputData, signal),
    );
  },
});

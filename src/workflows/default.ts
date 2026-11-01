import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { Explore } from '../agents/exploration.js';
import {
  answerSchema,
  issueInputSchema,
  questionSchema,
  type Ask,
} from '../contracts/interaction.js';
import {
  deliveryResultSchema,
  deliveryStateSchema,
  implementationSchema,
  qaSchema,
  reviewSchema,
  summarySchema,
  type DeliveryRound,
  type DeliveryState,
  type DeliveryResult,
} from '../contracts/delivery.js';
import { issueBriefSchema, type IssueBrief } from '../contracts/issue.js';

export interface DeliveryOperations {
  maxRepairRounds: number;
  prepare: (brief: IssueBrief, signal: AbortSignal) => Promise<string>;
  implement: (state: DeliveryState, signal: AbortSignal) => Promise<unknown>;
  capture: (signal: AbortSignal) => Promise<{ revision: string; tree: string }>;
  checks: (round: DeliveryRound, signal: AbortSignal) => Promise<DeliveryRound>;
  qa: (state: DeliveryState, signal: AbortSignal) => Promise<unknown>;
  validateQa: (
    state: DeliveryState,
    signal: AbortSignal,
  ) => Promise<DeliveryRound>;
  review: (state: DeliveryState, signal: AbortSignal) => Promise<unknown>;
  assertUnchanged: (revision: string, signal: AbortSignal) => Promise<void>;
  summarize: (state: DeliveryState, signal: AbortSignal) => Promise<unknown>;
  finish: (
    state: DeliveryState,
    signal: AbortSignal,
  ) => Promise<DeliveryResult>;
  record: (state: DeliveryState) => Promise<void>;
}

const inputSchema = z.strictObject({ issue: issueInputSchema });
const requestContextSchema = z.object({
  ask: z.custom<Ask>((value) => typeof value === 'function'),
  progress: z.custom<(message: string) => void>(
    (value) => typeof value === 'function',
  ),
  operations: z.custom<DeliveryOperations>(
    (value) => typeof value === 'object' && value !== null,
  ),
  signal: z.instanceof(AbortSignal),
});

export function createDefaultWorkflow(dependencies: { explore: Explore }) {
  const exploreIssue = createStep({
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
        const brief = await dependencies.explore(inputData.issue, ask, signal);
        signal.throwIfAborted();
        return issueBriefSchema.parse(brief);
      } finally {
        exploration.abort(new Error('Exploration ended.'));
      }
    },
  });
  const prepare = createStep({
    id: 'prepare-delivery',
    inputSchema: issueBriefSchema,
    outputSchema: deliveryStateSchema,
    requestContextSchema,
    execute: async ({ inputData, requestContext, abortSignal }) => {
      const signal = AbortSignal.any([
        abortSignal,
        requestContext.get('signal'),
      ]);
      signal.throwIfAborted();
      requestContext.get('progress')('Preparing delivery');
      if (inputData.readiness !== 'ready' || !inputData.confirmedByUser)
        throw new Error('Delivery requires a confirmed, ready brief.');
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
  const step = (
    id: string,
    execute: (
      state: DeliveryState,
      operations: DeliveryOperations,
      signal: AbortSignal,
    ) => Promise<DeliveryState>,
  ) =>
    createStep({
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
        const state = await execute(
          inputData,
          requestContext.get('operations'),
          signal,
        );
        signal.throwIfAborted();
        await requestContext.get('operations').record(state);
        return state;
      },
    });
  const implement = step('implement', async (state, operations, signal) => {
    const implementation = implementationSchema.parse(
      await operations.implement(state, signal),
    );
    signal.throwIfAborted();
    if (implementation.blockers.length)
      return {
        ...state,
        round: state.round + 1,
        status: 'blocked',
        reason: implementation.blockers.join('\n'),
      };
    const candidate = await operations.capture(signal);
    const round: DeliveryRound = {
      ...candidate,
      round: state.round + 1,
      implementation,
      evidence: [],
      qa: null,
      review: null,
      findings: [],
    };
    return { ...state, round: round.round, history: [...state.history, round] };
  });
  const checks = step('run-checks', async (state, operations, signal) => {
    if (state.status === 'blocked') return state;
    const round = await operations.checks(state.history.at(-1)!, signal);
    return replaceRound(state, round);
  });
  const qa = step('qa', async (state, operations, signal) => {
    if (state.status === 'blocked') return state;
    const round = state.history.at(-1)!;
    if (
      round.findings.some((finding) => finding.severity === 'blocking') ||
      round.implementation.blockers.length
    )
      return state;
    round.qa = qaSchema.parse(await operations.qa(state, signal));
    const next = await operations.validateQa(state, signal);
    await operations.assertUnchanged(round.revision, signal);
    return replaceRound(state, next);
  });
  const review = step('review', async (state, operations, signal) => {
    if (state.status === 'blocked') return state;
    const round = state.history.at(-1)!;
    if (
      round.qa?.verdict !== 'pass' ||
      round.findings.some((finding) => finding.severity === 'blocking')
    )
      return state;
    round.review = reviewSchema.parse(await operations.review(state, signal));
    for (const finding of round.review.findings) {
      if (finding.source !== 'review')
        throw new Error('Invalid review finding source.');
      if (
        finding.criterionId &&
        !state.brief.acceptanceCriteria.some(
          (criterion) => criterion.id === finding.criterionId,
        )
      )
        throw new Error('Review references an unknown acceptance criterion.');
      if (
        finding.evidenceIds.some(
          (id) =>
            !round.evidence.some(
              (record) =>
                record.id === id && record.revision === round.revision,
            ),
        )
      )
        throw new Error('Review references missing or stale evidence.');
    }
    round.findings.push(...round.review.findings);
    if (
      round.review.verdict !== 'pass' &&
      !round.review.findings.some((finding) => finding.severity === 'blocking')
    )
      round.findings.push({
        source: 'review',
        kind: round.review.verdict === 'blocked' ? 'question' : 'defect',
        severity: 'blocking',
        description: round.review.summary,
        criterionId: null,
        evidenceIds: [],
      });
    await operations.assertUnchanged(round.revision, signal);
    return replaceRound(state, round);
  });
  const gate = step('delivery-gate', (state, operations) => {
    if (state.status === 'blocked') return Promise.resolve(state);
    const round = state.history.at(-1)!;
    const blocking = round.findings.filter(
      (finding) => finding.severity === 'blocking',
    );
    const repeated = state.history
      .slice(0, -1)
      .some((previous) => previous.tree === round.tree);
    const passed =
      !repeated &&
      !round.implementation.blockers.length &&
      !blocking.length &&
      round.qa?.verdict === 'pass' &&
      round.review?.verdict === 'pass';
    let reason = '';
    if (!passed) {
      if (round.implementation.blockers.length)
        reason = round.implementation.blockers.join('\n');
      else if (
        round.qa?.verdict === 'blocked' ||
        round.review?.verdict === 'blocked' ||
        blocking.some((finding) => finding.kind !== 'defect')
      )
        reason =
          'A question, scope change, or unavailable QA target requires user input.';
      else if (state.round > operations.maxRepairRounds)
        reason = 'Repair budget exhausted.';
      else if (repeated)
        reason =
          'Repair made no progress: the candidate repeats an earlier source tree.';
    }
    return Promise.resolve({
      ...state,
      status: passed ? 'approved' : reason ? 'blocked' : 'repair',
      reason,
    });
  });
  const cycle = createWorkflow({
    id: 'delivery-cycle',
    inputSchema: deliveryStateSchema,
    outputSchema: deliveryStateSchema,
    requestContextSchema,
    retryConfig: { attempts: 0 },
  })
    .then(implement)
    .then(checks)
    .then(qa)
    .then(review)
    .then(gate)
    .commit();
  const summarize = step('summarize', async (state, operations, signal) => {
    if (state.status !== 'approved') return state;
    const summary = summarySchema.parse(
      await operations.summarize(state, signal),
    );
    await operations.assertUnchanged(state.history.at(-1)!.revision, signal);
    return { ...state, summary };
  });
  const finish = createStep({
    id: 'publish-delivery',
    inputSchema: deliveryStateSchema,
    outputSchema: deliveryResultSchema,
    requestContextSchema,
    execute: async ({ inputData, requestContext, abortSignal }) => {
      const signal = AbortSignal.any([
        abortSignal,
        requestContext.get('signal'),
      ]);
      signal.throwIfAborted();
      return deliveryResultSchema.parse(
        await requestContext.get('operations').finish(inputData, signal),
      );
    },
  });
  // Populate optional Workflow metadata to satisfy Step's exact optional types.
  const loop = Object.assign(cycle, {
    description: 'Implement, verify, and review a candidate.',
    metadata: {},
  });
  return createWorkflow({
    id: 'default',
    inputSchema,
    outputSchema: deliveryResultSchema,
    requestContextSchema,
    retryConfig: { attempts: 0 },
    options: { validateInputs: true, autoRestartActiveRuns: false },
  })
    .then(exploreIssue)
    .then(prepare)
    .dountil(loop, ({ inputData }) =>
      Promise.resolve(deliveryStateSchema.parse(inputData).status !== 'repair'),
    )
    .then(summarize)
    .then(finish)
    .commit();
}

function replaceRound(
  state: DeliveryState,
  round: DeliveryRound,
): DeliveryState {
  return { ...state, history: [...state.history.slice(0, -1), round] };
}

import {
  implementationSchema,
  qaSchema,
  reviewSchema,
  summarySchema,
  type DeliveryRound,
  type DeliveryState,
} from '../contracts/delivery.js';
import type { DeliveryOperations } from './operations.js';
import { figmaResultSchema } from '../contracts/figma.js';
import { applyReview, canReview, canRunQa } from './policy.js';
import {
  combineQaReports,
  identifyQaFindings,
  needsSandboxQa,
  uiFollowUpCriteria,
} from './qa-handoff.js';
import { currentRound, replaceRound } from './state.js';

type ExecuteDeliveryStep = (
  state: DeliveryState,
  operations: DeliveryOperations,
  signal: AbortSignal,
) => Promise<DeliveryState>;

export interface DeliveryStep {
  skip: (state: DeliveryState) => string | null;
  execute: ExecuteDeliveryStep;
}

const blocked = (state: DeliveryState) =>
  state.status === 'blocked' ? 'Delivery is blocked.' : null;
const qaSkip = (state: DeliveryState) =>
  blocked(state) ??
  (!canRunQa(currentRound(state))
    ? 'Blocking check findings prevent acceptance QA.'
    : null);

export const scaffoldUi: DeliveryStep = {
  skip: (state) =>
    blocked(state) ??
    (!state.figma
      ? 'No linked Figma designs.'
      : state.figma.result
        ? 'UI scaffolding already completed.'
        : null),
  execute: async (state, operations, signal) => {
    if (!state.figma) throw new Error('UI scaffolding requires Figma sources.');
    const result = figmaResultSchema.parse(
      await operations.figma(state, signal),
    );
    signal.throwIfAborted();
    return {
      ...state,
      figma: { ...state.figma, result },
      ...(result.blockers.length
        ? { status: 'blocked' as const, reason: result.blockers.join('\n') }
        : {}),
    };
  },
};

export const implementCandidate: DeliveryStep = {
  skip: blocked,
  execute: async (state, operations, signal) => {
    const implementation = implementationSchema.parse(
      await operations.implement(state, signal),
    );
    signal.throwIfAborted();
    const attempt = {
      attempt: state.implementationAttempts.length + 1,
      result: implementation,
      candidateRound: implementation.blockers.length ? null : state.round + 1,
    };
    const implementationAttempts = [...state.implementationAttempts, attempt];
    if (implementation.blockers.length)
      return {
        ...state,
        implementationAttempts,
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
    return {
      ...state,
      round: round.round,
      status: 'verifying',
      reason: '',
      implementationAttempts,
      history: [...state.history, round],
    };
  },
};

export const checkCandidate: DeliveryStep = {
  skip: blocked,
  execute: async (state, operations, signal) => {
    const round = await operations.checks(currentRound(state), signal);
    return replaceRound(state, round);
  },
};

export const verifyCandidate: DeliveryStep = {
  skip: qaSkip,
  execute: async (state, operations, signal) => {
    const round = currentRound(state);
    const qa = identifyQaFindings(
      qaSchema.parse(await operations.qa(state, signal)),
      'ui',
    );
    const reported = replaceRound(state, { ...round, qa, browserQa: qa });
    const validated = await operations.validateQa(
      reported,
      signal,
      'preliminary',
    );
    await operations.assertUnchanged(round.revision, signal);
    return replaceRound(reported, validated);
  },
};

export const verifySandboxCandidate: DeliveryStep = {
  skip: (state) => {
    const skipped = qaSkip(state);
    if (skipped) return skipped;
    const round = currentRound(state);
    if (!round.qa) throw new Error('Sandbox QA requires browser/mobile QA.');
    return needsSandboxQa(round.qa, round.evidence)
      ? null
      : 'No blocked criteria require sandbox QA.';
  },
  execute: async (state, operations, signal) => {
    const round = currentRound(state);
    if (!round.qa) throw new Error('Sandbox QA requires browser/mobile QA.');
    const sandboxQa = identifyQaFindings(
      qaSchema.parse(await operations.sandboxQa(state, signal)),
      'sandbox',
    );
    signal.throwIfAborted();
    const reported = replaceRound(state, {
      ...round,
      sandboxQa,
      qa: combineQaReports(round.qa, sandboxQa),
    });
    const validated = await operations.validateQa(
      reported,
      signal,
      'preliminary',
    );
    await operations.assertUnchanged(round.revision, signal);
    return replaceRound(reported, validated);
  },
};

export const verifyUiFollowUp: DeliveryStep = {
  skip: (state) =>
    qaSkip(state) ??
    (uiFollowUpCriteria(currentRound(state)).length
      ? null
      : 'No targeted UI follow-up requested.'),
  execute: async (state, operations, signal) => {
    const round = currentRound(state);
    if (!round.qa)
      throw new Error('UI follow-up requires a combined QA report.');
    const ids = uiFollowUpCriteria(round);
    const followUpQa = identifyQaFindings(
      qaSchema.parse(await operations.followUpQa(state, signal)),
      'follow-up',
    );
    signal.throwIfAborted();
    return replaceRound(state, {
      ...round,
      followUpQa,
      qa: combineQaReports(round.qa, followUpQa, ids),
    });
  },
};

export const validateAcceptance: DeliveryStep = {
  skip: qaSkip,
  execute: async (state, operations, signal) => {
    const round = currentRound(state);
    const validated = await operations.validateQa(state, signal);
    await operations.assertUnchanged(round.revision, signal);
    return replaceRound(state, validated);
  },
};

export const reviewCandidate: DeliveryStep = {
  skip: (state) =>
    blocked(state) ??
    (!canReview(currentRound(state))
      ? 'Review requires passing acceptance QA and no blocking findings.'
      : null),
  execute: async (state, operations, signal) => {
    const round = currentRound(state);
    const report = reviewSchema.parse(await operations.review(state, signal));
    const reviewed = applyReview(state, report);
    await operations.assertUnchanged(round.revision, signal);
    return replaceRound(state, reviewed);
  },
};

export const summarizeCandidate: DeliveryStep = {
  skip: (state) =>
    state.status !== 'approved'
      ? 'Only approved candidates receive a PR summary.'
      : null,
  execute: async (state, operations, signal) => {
    const round = currentRound(state);
    const summary = summarySchema.parse(
      await operations.summarize(state, signal),
    );
    await operations.assertUnchanged(round.revision, signal);
    return { ...state, summary };
  },
};

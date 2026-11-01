import {
  implementationSchema,
  qaSchema,
  reviewSchema,
  summarySchema,
  type DeliveryRound,
  type DeliveryState,
} from '../contracts/delivery.js';
import type { DeliveryOperations } from './operations.js';
import { applyReview, canReview, canRunQa } from './policy.js';
import { currentRound, replaceRound } from './state.js';

export type DeliveryStep = (
  state: DeliveryState,
  operations: DeliveryOperations,
  signal: AbortSignal,
) => Promise<DeliveryState>;

export const implementCandidate: DeliveryStep = async (
  state,
  operations,
  signal,
) => {
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
};

export const checkCandidate: DeliveryStep = async (
  state,
  operations,
  signal,
) => {
  if (state.status === 'blocked') return state;
  const round = await operations.checks(currentRound(state), signal);
  return replaceRound(state, round);
};

export const verifyCandidate: DeliveryStep = async (
  state,
  operations,
  signal,
) => {
  if (state.status === 'blocked') return state;
  const round = currentRound(state);
  if (!canRunQa(round)) return state;
  const qa = qaSchema.parse(await operations.qa(state, signal));
  const reported = replaceRound(state, { ...round, qa });
  const validated = await operations.validateQa(reported, signal);
  await operations.assertUnchanged(round.revision, signal);
  return replaceRound(reported, validated);
};

export const reviewCandidate: DeliveryStep = async (
  state,
  operations,
  signal,
) => {
  if (state.status === 'blocked') return state;
  const round = currentRound(state);
  if (!canReview(round)) return state;
  const report = reviewSchema.parse(await operations.review(state, signal));
  const reviewed = applyReview(state, report);
  await operations.assertUnchanged(round.revision, signal);
  return replaceRound(state, reviewed);
};

export const summarizeCandidate: DeliveryStep = async (
  state,
  operations,
  signal,
) => {
  if (state.status !== 'approved') return state;
  const round = currentRound(state);
  const summary = summarySchema.parse(
    await operations.summarize(state, signal),
  );
  await operations.assertUnchanged(round.revision, signal);
  return { ...state, summary };
};

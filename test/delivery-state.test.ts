import { expect, test } from 'vitest';
import type { DeliveryState } from '../src/contracts/delivery.js';
import { applyReview } from '../src/delivery/policy.js';
import { currentRound, replaceRound } from '../src/delivery/state.js';
import { reviewCandidate, verifyCandidate } from '../src/delivery/steps.js';
import { candidateState } from './fixtures/delivery.js';
import {
  createWorkflowSetup,
  qaPass,
  reviewPass,
} from './fixtures/workflow.js';

test('current-round preconditions reject missing or mismatched history', () => {
  const state = candidateState();
  expect(() => currentRound({ ...state, history: [] })).toThrow(
    'current round',
  );
  expect(() => currentRound({ ...state, round: 2 })).toThrow('current round');
  expect(() =>
    replaceRound(state, { ...currentRound(state), revision: 'other' }),
  ).toThrow('another candidate');
});

test('QA validates the reported state without mutating the input round', async () => {
  const { operations } = createWorkflowSetup();
  const state = candidateState();
  const before = structuredClone(state);
  const next = await verifyCandidate(
    state,
    operations,
    new AbortController().signal,
  );
  expect(state).toEqual(before);
  expect(currentRound(next).qa).toEqual(qaPass);
  expect(operations.validateQa.mock.calls[0]?.[0]).toMatchObject({
    history: [{ qa: qaPass }],
  });
});

test('review findings and fallback blockers are applied without mutating history', async () => {
  const { operations } = createWorkflowSetup();
  const state = candidateState();
  currentRound(state).qa = structuredClone(
    qaPass,
  ) as DeliveryState['history'][number]['qa'];
  operations.review.mockResolvedValue({
    ...reviewPass,
    verdict: 'changes-requested',
  });
  const before = structuredClone(state);
  const next = await reviewCandidate(
    state,
    operations,
    new AbortController().signal,
  );
  expect(state).toEqual(before);
  expect(currentRound(next).findings).toMatchObject([
    { source: 'review', severity: 'blocking' },
  ]);
});

test.each([
  { source: 'qa' as const, criterionId: 'AC1', evidenceIds: ['test'] },
  { source: 'review' as const, criterionId: 'unknown', evidenceIds: ['test'] },
  { source: 'review' as const, criterionId: 'AC1', evidenceIds: ['missing'] },
])(
  'independent review validation rejects invalid references: %j',
  (references) => {
    const state = candidateState();
    expect(() =>
      applyReview(state, {
        verdict: 'changes-requested',
        summary: 'Fix the issue.',
        findings: [
          {
            ...references,
            kind: 'defect',
            severity: 'blocking',
            description: 'Incorrect output.',
          },
        ],
      }),
    ).toThrow();
    expect(currentRound(state).findings).toEqual([]);
    expect(currentRound(state).review).toBeNull();
  },
);

test('review cannot cite an existing evidence ID from a stale revision', () => {
  const state = candidateState();
  currentRound(state).evidence[0]!.revision = 'older-candidate';
  expect(() =>
    applyReview(state, {
      verdict: 'changes-requested',
      summary: 'Fix the issue.',
      findings: [
        {
          source: 'review',
          criterionId: 'AC1',
          evidenceIds: ['test'],
          kind: 'defect',
          severity: 'blocking',
          description: 'Incorrect output.',
        },
      ],
    }),
  ).toThrow('missing or stale evidence');
});

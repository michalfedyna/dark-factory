import type { DeliveryRound, DeliveryState } from '../contracts/delivery.js';
import { currentRound } from './state.js';

export function canRunQa(round: DeliveryRound): boolean {
  return (
    !round.findings.some((finding) => finding.severity === 'blocking') &&
    !round.implementation.blockers.length
  );
}

export function canReview(round: DeliveryRound): boolean {
  return (
    round.qa?.verdict === 'pass' &&
    !round.findings.some((finding) => finding.severity === 'blocking')
  );
}

export function applyReview(
  state: DeliveryState,
  review: NonNullable<DeliveryRound['review']>,
): DeliveryRound {
  const round = currentRound(state);
  for (const finding of review.findings) {
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
            (record) => record.id === id && record.revision === round.revision,
          ),
      )
    )
      throw new Error('Review references missing or stale evidence.');
  }
  const findings = [...round.findings, ...review.findings];
  if (
    review.verdict !== 'pass' &&
    !review.findings.some((finding) => finding.severity === 'blocking')
  )
    findings.push({
      source: 'review',
      kind: review.verdict === 'blocked' ? 'question' : 'defect',
      severity: 'blocking',
      description: review.summary,
      criterionId: null,
      evidenceIds: [],
    });
  return { ...round, review, findings };
}

export function deliveryGate(state: DeliveryState): DeliveryState {
  if (state.status === 'blocked') return state;
  const round = currentRound(state);
  const blocking = round.findings.filter(
    (finding) => finding.severity === 'blocking',
  );
  const passed =
    !round.implementation.blockers.length &&
    !blocking.length &&
    round.qa?.verdict === 'pass' &&
    round.review?.verdict === 'pass';
  const requiresInput =
    round.implementation.blockers.length > 0 ||
    round.qa?.verdict === 'blocked' ||
    round.review?.verdict === 'blocked' ||
    blocking.some((finding) => finding.kind !== 'defect');
  const reason = passed
    ? ''
    : round.implementation.blockers.join('\n') ||
      blocking.map((finding) => finding.description).join('\n') ||
      (requiresInput
        ? 'A question, scope change, or unavailable QA target requires user input.'
        : 'Acceptance QA and independent review have not both passed.');
  return {
    ...state,
    status: passed ? 'approved' : requiresInput ? 'blocked' : 'repair',
    reason,
  };
}

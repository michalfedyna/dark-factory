import type { VerificationPlan } from '../contracts/project.js';
import type {
  DeliveryRound,
  Evidence,
  Finding,
} from '../contracts/delivery.js';
import type { IssueBrief } from '../contracts/issue.js';
import {
  combineQaReports,
  pendingQaCriteria,
  uiFollowUpCriteria,
} from './qa-handoff.js';

function isFollowUpObservation(record: Evidence): boolean {
  return (
    record.qaPhase === 'follow-up' &&
    ['browser', 'device', 'screenshot'].includes(record.kind)
  );
}

function validateReport(
  known: Set<string>,
  report: NonNullable<DeliveryRound['qa']>,
  round: DeliveryRound,
  resolutionKind?: 'sandbox' | 'ui',
) {
  const evidence = new Map(round.evidence.map((record) => [record.id, record]));
  if (
    report.criteria.length !== known.size ||
    new Set(report.criteria.map((criterion) => criterion.id)).size !==
      known.size ||
    report.criteria.some((criterion) => !known.has(criterion.id))
  )
    throw new Error('QA must cover every acceptance criterion exactly once.');
  for (const criterion of report.criteria) {
    for (const id of criterion.evidenceIds) {
      const record = evidence.get(id);
      if (
        !record ||
        record.revision !== round.revision ||
        (criterion.status === 'pass' && record.exitCode !== 0)
      )
        throw new Error('QA references missing, failed, or stale evidence.');
    }
  }
  for (const finding of report.findings) {
    if (
      finding.source !== 'qa' ||
      (finding.criterionId !== null && !known.has(finding.criterionId)) ||
      finding.evidenceIds.some(
        (id) => evidence.get(id)?.revision !== round.revision,
      )
    )
      throw new Error('Invalid QA finding references.');
  }
  for (const resolution of report.resolvedQuestions ?? []) {
    if (
      !resolutionKind ||
      resolution.evidenceIds.some((id) => {
        const record = evidence.get(id);
        return (
          !record ||
          record.revision !== round.revision ||
          record.exitCode !== 0 ||
          (resolutionKind === 'sandbox'
            ? record.kind !== 'sandbox'
            : !isFollowUpObservation(record))
        );
      })
    )
      throw new Error(
        'Resolving a QA question requires successful current tester evidence.',
      );
  }
  if (report.verdict === 'pass') {
    if (
      report.criteria.some((criterion) => criterion.status !== 'pass') ||
      report.findings.some((finding) => finding.severity === 'blocking')
    )
      throw new Error(
        'A passing QA report cannot contain failed criteria or blocking findings.',
      );
  }
}

export function validateQa(
  brief: IssueBrief,
  round: DeliveryRound,
  targets: VerificationPlan['targets'],
  phase: 'preliminary' | 'final' = 'final',
): DeliveryRound {
  const report = round.qa;
  if (!report) throw new Error('Missing QA report.');
  const known = new Set(
    brief.acceptanceCriteria.map((criterion) => criterion.id),
  );
  validateReport(known, report, round);
  if (round.sandboxQa) {
    if (!round.browserQa) throw new Error('Missing browser/mobile QA report.');
    validateReport(known, round.browserQa, round);
    const pending = new Set(
      pendingQaCriteria(round.browserQa).map(({ id }) => id),
    );
    validateReport(pending, round.sandboxQa, round, 'sandbox');
    const combined = combineQaReports(round.browserQa, round.sandboxQa);
    const followUpIds = uiFollowUpCriteria({ ...round, qa: combined });
    if (round.followUpQa) {
      if (!followUpIds.length)
        throw new Error('UI follow-up was not requested.');
      if (round.followUpQa.uiFollowUp)
        throw new Error('UI follow-up cannot request another follow-up.');
      validateReport(new Set(followUpIds), round.followUpQa, round, 'ui');
      combineQaReports(combined, round.followUpQa, followUpIds);
      for (const criterion of round.followUpQa.criteria) {
        if (
          criterion.status === 'pass' &&
          !criterion.evidenceIds.some((id) =>
            round.evidence.some(
              (record) =>
                record.id === id &&
                isFollowUpObservation(record) &&
                record.exitCode === 0 &&
                record.revision === round.revision,
            ),
          )
        )
          throw new Error(
            'Passing UI follow-up requires fresh browser/mobile evidence.',
          );
      }
    }
    for (const criterion of round.sandboxQa.criteria) {
      if (
        criterion.status === 'pass' &&
        !criterion.evidenceIds.some((id) =>
          round.evidence.some(
            (record) => record.id === id && record.kind === 'sandbox',
          ),
        )
      )
        throw new Error(
          'Passing sandbox QA requires sandbox command evidence.',
        );
    }
  }
  if (round.followUpQa && !round.sandboxQa)
    throw new Error('UI follow-up requires sandbox QA.');
  if (round.browserQa?.uiFollowUp || round.browserQa?.resolvedQuestions?.length)
    throw new Error(
      'Initial UI QA cannot resolve prior questions or request a follow-up.',
    );
  const findings: Finding[] = [...report.findings];
  if (report.verdict === 'pass') {
    for (const target of targets) {
      for (const operation of [
        'open',
        'snapshot',
        ...(target.screenshots ? ['screenshot'] : []),
      ]) {
        if (
          !round.evidence.some(
            (record) =>
              record.targetId === target.id &&
              record.operation === operation &&
              record.exitCode === 0 &&
              record.revision === round.revision,
          )
        )
          throw new Error(
            `QA did not produce required ${operation} evidence for ${target.id}.`,
          );
      }
    }
  }
  if (phase === 'preliminary') return round;
  if (
    report.verdict !== 'pass' &&
    !findings.some((finding) => finding.severity === 'blocking')
  ) {
    findings.push({
      source: 'qa',
      kind: report.verdict === 'blocked' ? 'question' : 'defect',
      severity: 'blocking',
      description:
        'QA did not pass. Address the criterion notes and rerun verification.',
      criterionId: null,
      evidenceIds: [],
    });
  }
  return { ...round, findings: [...round.findings, ...findings] };
}

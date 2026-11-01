import type { VerificationPlan } from '../contracts/project.js';
import type { DeliveryRound, Finding } from '../contracts/delivery.js';
import type { IssueBrief } from '../contracts/issue.js';

function validateReport(
  known: Set<string>,
  report: NonNullable<DeliveryRound['qa']>,
  round: DeliveryRound,
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
    const blocked = new Set(
      round.browserQa.criteria
        .filter((criterion) => criterion.status === 'blocked')
        .map((criterion) => criterion.id),
    );
    validateReport(blocked, round.sandboxQa, round);
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

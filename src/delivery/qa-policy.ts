import type { Project } from '../contracts/project.js';
import type { DeliveryRound, Finding } from '../contracts/delivery.js';
import type { IssueBrief } from '../contracts/issue.js';

export function validateQa(
  brief: IssueBrief,
  round: DeliveryRound,
  targets: Project['targets'],
): DeliveryRound {
  const report = round.qa;
  if (!report) throw new Error('Missing QA report.');
  const evidence = new Map(round.evidence.map((record) => [record.id, record]));
  const known = new Set(
    brief.acceptanceCriteria.map((criterion) => criterion.id),
  );
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
      finding.evidenceIds.some((id) => !evidence.has(id))
    )
      throw new Error('Invalid QA finding references.');
  }
  const findings: Finding[] = [...report.findings];
  if (report.verdict === 'pass') {
    if (
      report.criteria.some((criterion) => criterion.status !== 'pass') ||
      findings.some((finding) => finding.severity === 'blocking')
    )
      throw new Error(
        'A passing QA report cannot contain failed criteria or blocking findings.',
      );
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

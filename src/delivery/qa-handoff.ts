import type { DeliveryRound, Evidence } from '../contracts/delivery.js';

type QaReport = NonNullable<DeliveryRound['qa']>;

export function needsSandboxQa(
  report: QaReport,
  evidence: Evidence[],
): boolean {
  // A crashed candidate server is an implementation defect, not a tool limitation.
  return (
    report.criteria.some((criterion) => criterion.status === 'blocked') &&
    !evidence.some(
      (record) =>
        record.kind === 'check' &&
        record.operation.startsWith('qa-server-') &&
        record.exitCode !== 0,
    )
  );
}

export function combineQaReports(
  browserQa: QaReport,
  sandboxQa: QaReport,
): QaReport {
  const blocked = new Set(
    browserQa.criteria
      .filter((criterion) => criterion.status === 'blocked')
      .map((criterion) => criterion.id),
  );
  if (
    !blocked.size ||
    sandboxQa.criteria.length !== blocked.size ||
    new Set(sandboxQa.criteria.map((criterion) => criterion.id)).size !==
      blocked.size ||
    sandboxQa.criteria.some((criterion) => !blocked.has(criterion.id)) ||
    sandboxQa.findings.some(
      (finding) =>
        finding.criterionId !== null && !blocked.has(finding.criterionId),
    )
  )
    throw new Error(
      'Sandbox QA must cover only blocked criteria exactly once.',
    );
  const replacements = new Map(
    sandboxQa.criteria.map((criterion) => [criterion.id, criterion]),
  );
  const criteria = browserQa.criteria.map(
    (criterion) => replacements.get(criterion.id) ?? criterion,
  );
  const findings = [
    ...browserQa.findings.filter(
      (finding) =>
        !(
          finding.kind === 'question' &&
          finding.criterionId !== null &&
          replacements.has(finding.criterionId) &&
          replacements.get(finding.criterionId)?.status !== 'blocked'
        ),
    ),
    ...sandboxQa.findings,
  ];
  const blocking = findings.filter(
    (finding) => finding.severity === 'blocking',
  );
  const requiresInput =
    criteria.some((criterion) => criterion.status === 'blocked') ||
    blocking.some((finding) => finding.kind !== 'defect') ||
    sandboxQa.verdict === 'blocked';
  const requiresRepair =
    criteria.some((criterion) => criterion.status === 'fail') ||
    blocking.length > 0 ||
    sandboxQa.verdict === 'changes-requested';
  const verdict = requiresInput
    ? 'blocked'
    : requiresRepair
      ? 'changes-requested'
      : 'pass';
  return { verdict, criteria, findings };
}

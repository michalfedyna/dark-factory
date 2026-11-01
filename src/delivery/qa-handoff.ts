import type { DeliveryRound, Evidence } from '../contracts/delivery.js';

type QaReport = NonNullable<DeliveryRound['qa']>;

export function identifyQaFindings(report: QaReport, phase: string): QaReport {
  return {
    ...report,
    findings: report.findings.map((finding, index) => ({
      ...finding,
      id: `${phase}-${index + 1}`,
    })),
  };
}

/** A failed criterion may also have an untested portion that needs another tester. */
export function pendingQaCriteria(report: QaReport) {
  return report.criteria.filter(
    (criterion) =>
      criterion.status === 'blocked' ||
      report.findings.some(
        (finding) =>
          finding.criterionId === criterion.id &&
          finding.kind === 'question' &&
          finding.severity === 'blocking',
      ),
  );
}

export function needsSandboxQa(
  report: QaReport,
  evidence: Evidence[],
): boolean {
  // A crashed candidate server is an implementation defect, not a tool limitation.
  return (
    pendingQaCriteria(report).length > 0 &&
    !evidence.some(
      (record) =>
        record.kind === 'check' &&
        record.operation.startsWith('qa-server-') &&
        record.exitCode !== 0,
    )
  );
}

export function uiFollowUpCriteria(round: DeliveryRound): string[] {
  const request = round.sandboxQa?.uiFollowUp;
  if (!request) return [];
  if (!round.qa) throw new Error('UI follow-up requires a combined QA report.');
  const pending = new Set(pendingQaCriteria(round.qa).map(({ id }) => id));
  for (const criterion of round.sandboxQa?.criteria ?? [])
    if (criterion.status === 'blocked') pending.add(criterion.id);
  if (
    new Set(request.criterionIds).size !== request.criterionIds.length ||
    request.criterionIds.some((id) => !pending.has(id))
  )
    throw new Error(
      'UI follow-up must cover only unresolved acceptance criteria.',
    );
  return request.criterionIds;
}

export function combineQaReports(
  previous: QaReport,
  next: QaReport,
  expectedIds = pendingQaCriteria(previous).map(({ id }) => id),
): QaReport {
  const expected = new Set(expectedIds);
  if (
    !expected.size ||
    next.criteria.length !== expected.size ||
    new Set(next.criteria.map(({ id }) => id)).size !== expected.size ||
    next.criteria.some(({ id }) => !expected.has(id)) ||
    next.findings.some(
      (finding) =>
        finding.criterionId !== null && !expected.has(finding.criterionId),
    )
  )
    throw new Error(
      'QA handoff must cover only pending criteria exactly once (including blocked criteria).',
    );

  const resolved = new Set<string>();
  for (const resolution of next.resolvedQuestions ?? []) {
    const question = previous.findings.find(
      ({ id }) => id === resolution.questionId,
    );
    if (
      resolved.has(resolution.questionId) ||
      !question ||
      question.kind !== 'question' ||
      question.criterionId === null ||
      !expected.has(question.criterionId)
    )
      throw new Error(
        'QA can resolve only supplied criterion questions exactly once.',
      );
    resolved.add(resolution.questionId);
  }
  const replacements = new Map(
    next.criteria.map((criterion) => [criterion.id, criterion]),
  );
  const criteria = previous.criteria.map((criterion) => {
    const replacement = replacements.get(criterion.id);
    if (!replacement) return criterion;
    // Later testers resolve missing verification; they cannot erase observed defects.
    if (criterion.status === 'fail')
      return {
        ...criterion,
        evidenceIds: [
          ...new Set([...criterion.evidenceIds, ...replacement.evidenceIds]),
        ],
        notes: `${criterion.notes}\nFollow-up: ${replacement.notes}`.slice(
          0,
          16_000,
        ),
      };
    return replacement;
  });
  const findings = [
    ...previous.findings.filter(
      (finding) =>
        !(
          finding.kind === 'question' &&
          finding.criterionId !== null &&
          ((finding.id !== undefined && resolved.has(finding.id)) ||
            (replacements.has(finding.criterionId) &&
              replacements.get(finding.criterionId)?.status !== 'blocked'))
        ),
    ),
    ...next.findings,
  ];
  const blocking = findings.filter(({ severity }) => severity === 'blocking');
  const requiresInput =
    criteria.some(({ status }) => status === 'blocked') ||
    blocking.some(({ kind }) => kind !== 'defect') ||
    next.verdict === 'blocked';
  const requiresRepair =
    criteria.some(({ status }) => status === 'fail') ||
    blocking.length > 0 ||
    next.verdict === 'changes-requested';
  return {
    verdict: requiresInput
      ? 'blocked'
      : requiresRepair
        ? 'changes-requested'
        : 'pass',
    criteria,
    findings,
  };
}

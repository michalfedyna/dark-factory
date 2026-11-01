import type {
  FailedCheckLog,
  ImplementationContext,
} from '../agents/implementation.js';
import type { QaContext } from '../agents/qa.js';
import type { SandboxQaContext } from '../agents/sandbox-qa.js';
import type { ReviewContext } from '../agents/review.js';
import type { SummaryContext } from '../agents/summary.js';
import {
  createIssueTask,
  type EvidenceReference,
  type RepairFinding,
} from '../agents/task.js';
import type {
  DeliveryState,
  Evidence,
  Finding,
} from '../contracts/delivery.js';
import type { Project, VerificationProject } from '../contracts/project.js';
import { currentRound } from './state.js';

function repairFinding(finding: Finding): RepairFinding {
  return {
    source: finding.source,
    kind: finding.kind,
    severity: finding.severity,
    description: finding.description,
    criterionId: finding.criterionId,
  };
}

function evidenceReferences(records: Evidence[]): EvidenceReference[] {
  return records.map((record) => ({
    id: record.id,
    kind: record.kind,
    targetId: record.targetId,
    operation: record.operation,
    exitCode: record.exitCode,
    path: record.path,
  }));
}

export function implementationContext(
  state: DeliveryState,
  project: Project,
  checkLogs: FailedCheckLog[],
): ImplementationContext {
  const previous = state.round === 0 ? null : currentRound(state);
  return {
    task: createIssueTask(state.brief),
    allowedPaths: project.allowedPaths,
    checks: previous?.implementation.verification?.checks ?? [],
    repair: previous
      ? {
          findings: previous.findings.map(repairFinding),
          failedCriteria: (previous.qa?.criteria ?? [])
            .filter((criterion) => criterion.status !== 'pass')
            .map(({ id, notes }) => ({ id, notes })),
          checkLogs,
        }
      : null,
  };
}

export function qaContext(
  state: DeliveryState,
  project: VerificationProject,
  evidence: Evidence[],
): QaContext {
  const round = currentRound(state);
  return {
    acceptanceCriteria: state.brief.acceptanceCriteria,
    constraints: state.brief.constraints,
    targets: project.targets.map((target) =>
      target.kind === 'web'
        ? {
            id: target.id,
            kind: target.kind,
            url: target.url,
            screenshots: target.screenshots,
          }
        : {
            id: target.id,
            kind: target.kind,
            platform: target.platform,
            app: target.app,
            screenshots: target.screenshots,
            ...(target.device ? { device: target.device } : {}),
          },
    ),
    evidence: evidence
      .filter((record) => record.revision === round.revision)
      .map(({ id, kind, targetId, operation, exitCode }) => ({
        id,
        kind,
        targetId,
        operation,
        exitCode,
      })),
  };
}

export function sandboxQaContext(
  state: DeliveryState,
  project: VerificationProject,
  evidence: Evidence[],
): SandboxQaContext {
  const round = currentRound(state);
  if (!round.qa) throw new Error('Sandbox QA requires browser/mobile QA.');
  const blockedCriteria = round.qa.criteria.filter(
    (criterion) => criterion.status === 'blocked',
  );
  if (!blockedCriteria.length)
    throw new Error('Sandbox QA requires blocked acceptance criteria.');
  return {
    acceptanceCriteria: state.brief.acceptanceCriteria.filter((criterion) =>
      blockedCriteria.some((blocked) => blocked.id === criterion.id),
    ),
    constraints: state.brief.constraints,
    verification: { checks: project.checks, targets: project.targets },
    blockedCriteria,
    evidence: evidenceReferences(
      evidence.filter((record) => record.revision === round.revision),
    ),
  };
}

export function reviewContext(
  state: DeliveryState,
  project: Project,
  patch: string,
): ReviewContext {
  const round = currentRound(state);
  if (!round.qa) throw new Error('Review context requires a QA report.');
  if (!round.implementation.verification)
    throw new Error('Review context requires a verification plan.');
  const previousReview = state.history
    .slice(0, -1)
    .findLast((previous) => previous.review !== null);
  return {
    task: createIssueTask(state.brief),
    allowedPaths: project.allowedPaths,
    patch,
    verification: round.implementation.verification,
    evidence: evidenceReferences(
      round.evidence.filter((record) => record.revision === round.revision),
    ),
    acceptanceResults: round.qa.criteria.map(({ id, status, evidenceIds }) => ({
      id,
      status,
      evidenceIds,
    })),
    previousFindings: (previousReview?.findings ?? [])
      .filter((finding) => finding.source === 'review')
      .map(repairFinding),
  };
}

export function summaryContext(state: DeliveryState): SummaryContext {
  const round = currentRound(state);
  if (!round.qa || !round.review)
    throw new Error('Summary context requires QA and review reports.');
  return {
    issue: {
      title: state.brief.title,
      kind: state.brief.kind,
      desiredOutcome: state.brief.desiredOutcome,
    },
    implementation: round.implementation.summary,
    checks: round.evidence
      .filter(
        (record) =>
          record.kind === 'check' && record.revision === round.revision,
      )
      .map((record) => ({ id: record.operation, exitCode: record.exitCode })),
    qa: {
      verdict: round.qa.verdict,
      criteria: round.qa.criteria.map(({ id, status, notes }) => ({
        id,
        status,
        notes,
      })),
    },
    review: { verdict: round.review.verdict, summary: round.review.summary },
    findings: round.findings.map(repairFinding),
  };
}

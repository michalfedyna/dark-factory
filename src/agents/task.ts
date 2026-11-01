import type { IssueBrief } from '../contracts/issue.js';
import type { Evidence, Finding } from '../contracts/delivery.js';

export type RepairFinding = Pick<
  Finding,
  'source' | 'kind' | 'severity' | 'description' | 'criterionId'
>;

export type EvidenceReference = Pick<
  Evidence,
  'id' | 'kind' | 'targetId' | 'operation' | 'exitCode' | 'path'
>;

export type IssueTask = Pick<
  IssueBrief,
  | 'problem'
  | 'desiredOutcome'
  | 'users'
  | 'scope'
  | 'requirements'
  | 'acceptanceCriteria'
  | 'constraints'
  | 'assumptions'
  | 'decisions'
  | 'risks'
>;

/** Keep approved task content, not exploration or workflow bookkeeping. */
export function createIssueTask(brief: IssueBrief): IssueTask {
  return {
    problem: brief.problem,
    desiredOutcome: brief.desiredOutcome,
    users: brief.users,
    scope: brief.scope,
    requirements: brief.requirements,
    acceptanceCriteria: brief.acceptanceCriteria,
    constraints: brief.constraints,
    assumptions: brief.assumptions,
    decisions: brief.decisions,
    risks: brief.risks,
  };
}

import { Agent } from '@mastra/core/agent';
import type { Workspace } from '@mastra/core/workspace';
import type { FactoryConfig } from '../config/schema.js';
import { reviewSchema, type DeliveryRound } from '../contracts/delivery.js';
import type { Project, VerificationPlan } from '../contracts/project.js';
import { createModelConfig } from './model.js';
import {
  deliveryInstructions,
  generateDeliveryResult,
  type DeliveryAgentInput,
} from './shared.js';
import type { EvidenceReference, IssueTask, RepairFinding } from './task.js';

const instructions = `${deliveryInstructions}

Independently review source, changes and tests for correctness, security, regressions, scope compliance and maintainability.
You have full Mastra filesystem, shell, and background-process tools in the candidate checkout. Inspect the supplied patch and source yourself, not just implementation claims.

- Independently rerun relevant verification commands and add targeted probes when needed to test your conclusions. Supplied execution evidence does not replace your own checks. Report what you actually ran, the results, and any limitations in the review summary; never claim an unrun check passed.
- Do not repair source, modify tracked tests or configuration, weaken checks, or change the candidate. You may install dependencies and create ignored temporary test artifacts. Candidate mutations invalidate verification.
- Earlier QA servers and browser/device sessions have been closed. Start any processes you need with your sandbox tools; they stop when review ends.
- Do not run Git, publish, modify factory artifacts, or access files outside this run's repository except the supplied evidence references. Respect allowedPaths and the configured execution policy.
- Work is supervised. Do not set command execution timeouts; let commands finish and respect cancellation.
- Evaluate the current revision from scratch and verify previous review findings are fixed.
- Inspect verification against the task and source. Reject missing UI targets and no-op, irrelevant, or weakened checks even when commands pass.
- Acceptance results and evidence references describe this candidate only. Read referenced evidence files when needed; previousFindings are repair feedback, not current evidence.
- Use source review for all findings. Distinguish in-scope defects from scope-change requests or questions.
- Blocking findings require changes-requested; unavailable context means blocked.
- Do not approve if acceptance evidence is incomplete.`;

export interface ReviewContext {
  task: IssueTask;
  allowedPaths: Project['allowedPaths'];
  patch: string;
  verification: VerificationPlan;
  evidence: EvidenceReference[];
  acceptanceResults: Pick<
    NonNullable<DeliveryRound['qa']>['criteria'][number],
    'id' | 'status' | 'evidenceIds'
  >[];
  previousFindings: RepairFinding[];
}

export function createReview(model: FactoryConfig['model'], apiKey: string) {
  return (
    input: DeliveryAgentInput<ReviewContext> & { workspace: Workspace },
  ) => {
    const agent = new Agent({
      id: 'review',
      name: 'Delivery review',
      instructions,
      ...createModelConfig(model, apiKey),
      workspace: input.workspace,
    });
    return generateDeliveryResult(agent, reviewSchema, input);
  };
}

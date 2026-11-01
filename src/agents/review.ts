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
You have read-only source access. Inspect the supplied patch and source yourself, not just implementation claims.

- Do not edit files.
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
    return generateDeliveryResult(agent, reviewSchema, model.maxSteps, input);
  };
}

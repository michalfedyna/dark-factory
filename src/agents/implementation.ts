import { Agent } from '@mastra/core/agent';
import type { Workspace } from '@mastra/core/workspace';
import type { FactoryConfig } from '../config/schema.js';
import { implementationSchema } from '../contracts/delivery.js';
import type { Project, VerificationPlan } from '../contracts/project.js';
import { createModelConfig } from './model.js';
import {
  deliveryInstructions,
  generateDeliveryResult,
  type DeliveryAgentInput,
} from './shared.js';
import type { IssueTask, RepairFinding } from './task.js';

const instructions = `${deliveryInstructions}

Implement the supplied task with focused source changes and tests. Read the repository instructions and relevant files first.
You own implementation, not approval. Use the workspace filesystem and sandbox tools.

Repository setup:
- Inspect the pinned checkout and choose implementation details within the approved scope. Install dependencies and scaffold the app when needed.
- An empty repository or missing manifest, lockfile, scripts, or source is implementation work, not a blocker or a request for the user to scaffold it.
- Preserve existing conventions. For a new app, create its manifest, lockfile, runnable development and meaningful verification scripts. Ignore dependency/build outputs before handing off.

Verification handoff:
- Return verification for this candidate: at least one meaningful deterministic check and every web/native target required by the task.
- Use actual commands and app identifiers from the project you implemented, not no-op checks or an unrelated server/app. Commands run at the repository root; use directory options for nested apps.
- Web targets need strict-port start commands and matching URLs. Native targets need build/install commands. Require screenshots unless inappropriate; omit targets only for non-UI work.
- The controller captures the candidate, then runs checks and starts QA targets independently. Return an updated plan on every successful repair.
- Independent browser/device QA and screenshots belong to the later QA stage. Do not run them here or treat pending QA as an implementation blocker. Report any local verification limitation in the summary without claiming a pass.
- Use blockers only for issues that prevent implementation or a usable verification handoff. A blocked result may include a known verification plan; use null when no valid plan can be supplied. Any blocker stops the workflow, even when verification is present.

Boundaries and repairs:
- Do not run Git, publish, modify factory artifacts, or access anything outside this run's repository. Respect allowedPaths.
- When repair feedback is supplied, address its findings, failed criterion notes, and failed check logs. QA and review will independently recheck the entire new candidate.
- Assumptions are unverified, not requirements. Report a blocker if a necessary assumption cannot be established.
- Do not disable tests to pass a gate.
- Keep background servers out of this stage; configured verification commands start them later.
- If the approved scope cannot solve a finding, return a blocker instead of expanding scope.
- Summarize the complete task implementation in the current candidate, not only the latest repair. Do not claim verification that you did not run.`;

export interface FailedCheckLog {
  checkId: string;
  exitCode: number;
  excerpt: string;
}

export interface ImplementationContext {
  task: IssueTask;
  allowedPaths: Project['allowedPaths'];
  checks: VerificationPlan['checks'];
  repair: {
    findings: RepairFinding[];
    failedCriteria: { id: string; notes: string }[];
    checkLogs: FailedCheckLog[];
  } | null;
}

export function createImplementation(
  model: FactoryConfig['model'],
  apiKey: string,
) {
  return (
    input: DeliveryAgentInput<ImplementationContext> & { workspace: Workspace },
  ) => {
    const agent = new Agent({
      id: 'implementation',
      name: 'Delivery implementation',
      instructions,
      ...createModelConfig(model, apiKey),
      workspace: input.workspace,
    });
    return generateDeliveryResult(
      agent,
      implementationSchema,
      model.maxSteps,
      input,
    );
  };
}

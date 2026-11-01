import { Agent } from '@mastra/core/agent';
import type { Workspace } from '@mastra/core/workspace';
import type { FactoryConfig } from '../config/schema.js';
import { implementationSchema } from '../contracts/delivery.js';
import type { Project } from '../contracts/project.js';
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
  checks: Project['checks'];
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

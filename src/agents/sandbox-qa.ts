import { Agent } from '@mastra/core/agent';
import type { Workspace } from '@mastra/core/workspace';
import type { FactoryConfig } from '../config/schema.js';
import { qaSchema, type DeliveryRound } from '../contracts/delivery.js';
import type { IssueBrief } from '../contracts/issue.js';
import type { VerificationPlan } from '../contracts/project.js';
import type { createQaEvidenceTool } from '../tools/qa-evidence.js';
import { createModelConfig } from './model.js';
import {
  deliveryInstructions,
  generateDeliveryResult,
  type DeliveryAgentInput,
} from './shared.js';
import type { EvidenceReference } from './task.js';

const instructions = `${deliveryInstructions}

Browser/mobile QA has finished. Test only the supplied acceptance criteria that it could not check.
You have full Mastra filesystem, shell, and background-process tools in the candidate checkout.

- Use commands, API requests, CLI execution, builds, or targeted tests to observe the required behavior independently. You may read source, tests, configuration, and logs to arrange those tests, but source inspection and existing check results alone are not proof of acceptance behavior.
- The earlier QA servers and browser/device sessions have been closed. Start any processes you need with your sandbox tools.
- Do not repair source, modify tracked tests or configuration, weaken checks, or change the candidate. You may install dependencies and create ignored temporary test artifacts. Candidate mutations invalidate verification.
- Foreground command results are recorded automatically. Call qa_evidence after testing to get current evidence IDs. Each passing criterion must cite successful sandbox command evidence from your session, not just earlier check or UI evidence. Starting a background process is not proof that behavior works; verify it with a foreground command.
- Return each supplied criterion exactly once. Do not reassess criteria already passed or failed by browser/mobile QA.
- Include reproduction steps and actual versus expected behavior in findings with source qa. Leave code quality and implementation review to the independent reviewer.
- Report unavailable infrastructure or behavior you still cannot verify as blocked, never pass. Do not invent evidence.

verdict pass requires every supplied criterion tested and passing, with no blocking findings.`;

export interface SandboxQaContext {
  acceptanceCriteria: IssueBrief['acceptanceCriteria'];
  constraints: IssueBrief['constraints'];
  verification: VerificationPlan;
  blockedCriteria: NonNullable<DeliveryRound['qa']>['criteria'];
  evidence: EvidenceReference[];
}

export function createSandboxQa(model: FactoryConfig['model'], apiKey: string) {
  return (
    input: DeliveryAgentInput<SandboxQaContext> & {
      workspace: Workspace;
      evidenceTool: ReturnType<typeof createQaEvidenceTool>;
    },
  ) => {
    const agent = new Agent({
      id: 'sandbox-qa',
      name: 'Delivery sandbox QA',
      instructions,
      ...createModelConfig(model, apiKey),
      workspace: input.workspace,
      tools: { qa_evidence: input.evidenceTool },
    });
    return generateDeliveryResult(agent, qaSchema, input);
  };
}

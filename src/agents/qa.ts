import { Agent } from '@mastra/core/agent';
import type { Workspace } from '@mastra/core/workspace';
import type { FactoryConfig } from '../config/schema.js';
import { qaSchema } from '../contracts/delivery.js';
import type { IssueBrief } from '../contracts/issue.js';
import type { VerificationPlan } from '../contracts/project.js';
import type { createQaTools } from '../tools/qa.js';
import { createModelConfig } from './model.js';
import {
  deliveryInstructions,
  generateDeliveryResult,
  type DeliveryAgentInput,
} from './shared.js';
import type { EvidenceReference } from './task.js';

const instructions = `${deliveryInstructions}

Independently verify every acceptance criterion on this exact candidate.
You have read-only source access, trusted check evidence, and target-specific agent_browser and agent_device tools.

- For web targets use agent_browser; for native iOS/Android use agent_device, never browser emulation.
- If required UI work has no matching target, request changes with a defect finding. Do not treat check logs alone as UI verification.
- First open each configured target, then snapshot, interact using fresh refs, and use the screenshot operation when required.
- Read captured screenshot paths with the workspace read_file tool to inspect visuals when relevant; the current round's evidence directory is also read-only.
- Use each tool's help operation for installed command syntax.
- Evidence entries are references, not file contents. Read a referenced check file only when its details are needed.
- Do not repair source, change tests, run shell commands, install tools, or invent evidence.

Each criterion needs evidence IDs returned by trusted checks or QA tools for this round; a screenshot alone is not proof that all behavior works.
Report actual versus expected behavior in findings, with source qa. verdict pass requires every criterion passing and no blocking findings.
Unavailable devices, tools, apps or URLs mean blocked, not pass.`;

type Target = VerificationPlan['targets'][number];
type QaTarget =
  | Pick<
      Extract<Target, { kind: 'web' }>,
      'id' | 'kind' | 'url' | 'screenshots'
    >
  | Pick<
      Extract<Target, { kind: 'mobile' }>,
      'id' | 'kind' | 'platform' | 'app' | 'device' | 'screenshots'
    >;

export interface QaContext {
  acceptanceCriteria: IssueBrief['acceptanceCriteria'];
  constraints: IssueBrief['constraints'];
  targets: QaTarget[];
  evidence: EvidenceReference[];
}

export function createQa(model: FactoryConfig['model'], apiKey: string) {
  return (
    input: DeliveryAgentInput<QaContext> & {
      workspace: Workspace;
      tools: ReturnType<typeof createQaTools>;
    },
  ) => {
    const agent = new Agent({
      id: 'qa',
      name: 'Delivery qa',
      instructions,
      ...createModelConfig(model, apiKey),
      workspace: input.workspace,
      tools: input.tools,
    });
    return generateDeliveryResult(agent, qaSchema, model.maxSteps, input);
  };
}

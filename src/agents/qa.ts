import { Agent } from '@mastra/core/agent';
import type { Workspace } from '@mastra/core/workspace';
import type { FactoryConfig } from '../config/schema.js';
import { qaSchema } from '../contracts/delivery.js';
import type { createQaTools } from '../tools/qa.js';
import {
  createDeliveryModel,
  deliveryInstructions,
  generateDeliveryResult,
  type DeliveryAgentInput,
} from './shared.js';

const instructions = `${deliveryInstructions}
Independently verify every acceptance criterion on this exact candidate. You have read-only source access, trusted check evidence, and target-specific agent_browser and agent_device tools. For web targets use agent_browser; for native iOS/Android use agent_device, never browser emulation. First open each configured target, then snapshot, interact using fresh refs, and use the screenshot operation when required. Read captured screenshot paths with the workspace read_file tool to inspect visuals when relevant; the current round's evidence directory is also read-only. Use each tool's help operation for installed command syntax. Do not repair source, change tests, run shell commands, install tools, or invent evidence. Each criterion needs evidence IDs returned by trusted checks or QA tools for this round; a screenshot alone is not proof that all behavior works. Report actual versus expected behavior in findings, with source qa. verdict pass requires every criterion passing and no blocking findings. Unavailable devices, tools, apps or URLs mean blocked, not pass.`;

export function createQa(model: FactoryConfig['model'], apiKey: string) {
  return (
    input: DeliveryAgentInput & {
      workspace: Workspace;
      tools: ReturnType<typeof createQaTools>;
    },
  ) => {
    const agent = new Agent({
      id: 'qa',
      name: 'Delivery qa',
      instructions,
      model: createDeliveryModel(model, apiKey),
      workspace: input.workspace,
      tools: input.tools,
    });
    return generateDeliveryResult(agent, qaSchema, model.maxSteps, input);
  };
}

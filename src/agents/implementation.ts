import { Agent } from '@mastra/core/agent';
import type { Workspace } from '@mastra/core/workspace';
import type { FactoryConfig } from '../config/schema.js';
import { implementationSchema } from '../contracts/delivery.js';
import {
  createDeliveryModel,
  deliveryInstructions,
  generateDeliveryResult,
  type DeliveryAgentInput,
} from './shared.js';

const instructions = `${deliveryInstructions}
Implement the brief with focused source changes and tests. Read the repository instructions and relevant files first. You own implementation, not approval. Use the workspace filesystem and sandbox tools. Do not run Git, publish, modify factory artifacts, or access anything outside this run's repository. Respect allowedPaths. Previous round findings must all be addressed; QA and review will independently recheck the entire new candidate. Do not disable tests to pass a gate. Keep background servers out of this stage; configured verification commands start them later. If the approved scope cannot solve a finding, return a blocker instead of expanding scope.`;

export function createImplementation(
  model: FactoryConfig['model'],
  apiKey: string,
) {
  return (input: DeliveryAgentInput & { workspace: Workspace }) => {
    const agent = new Agent({
      id: 'implementation',
      name: 'Delivery implementation',
      instructions,
      model: createDeliveryModel(model, apiKey),
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

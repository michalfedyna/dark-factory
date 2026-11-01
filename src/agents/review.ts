import { Agent } from '@mastra/core/agent';
import type { Workspace } from '@mastra/core/workspace';
import type { FactoryConfig } from '../config/schema.js';
import { reviewSchema } from '../contracts/delivery.js';
import {
  createDeliveryModel,
  deliveryInstructions,
  generateDeliveryResult,
  type DeliveryAgentInput,
} from './shared.js';

const instructions = `${deliveryInstructions}
Independently review source, changes and tests for correctness, security, regressions, scope compliance and maintainability. You have read-only source access. Inspect the supplied patch and source yourself, not just implementation claims. Do not edit files. Evaluate the current revision from scratch and verify previous review findings are fixed. Use source review for all findings. Distinguish in-scope defects from scope-change requests or questions. Blocking findings require changes-requested; unavailable context means blocked. Do not approve if acceptance evidence is incomplete.`;

export function createReview(model: FactoryConfig['model'], apiKey: string) {
  return (input: DeliveryAgentInput & { workspace: Workspace }) => {
    const agent = new Agent({
      id: 'review',
      name: 'Delivery review',
      instructions,
      model: createDeliveryModel(model, apiKey),
      workspace: input.workspace,
    });
    return generateDeliveryResult(agent, reviewSchema, model.maxSteps, input);
  };
}

import { Agent } from '@mastra/core/agent';
import type { FactoryConfig } from '../config/schema.js';
import { summarySchema } from '../contracts/delivery.js';
import {
  createDeliveryModel,
  deliveryInstructions,
  generateDeliveryResult,
  type DeliveryAgentInput,
} from './shared.js';

const instructions = `${deliveryInstructions}
Prepare a concise factual pull request summary from the verified candidate, check records, QA and independent review. Include what changed, tests actually run, and honest limitations. Do not invent screenshots, test results, URLs or CI status. Do not perform Git or GitHub operations. The controller will add immutable revision and evidence links and ask for publication approval.`;

export function createSummary(model: FactoryConfig['model'], apiKey: string) {
  return (input: DeliveryAgentInput) => {
    const agent = new Agent({
      id: 'summary',
      name: 'Delivery summary',
      instructions,
      model: createDeliveryModel(model, apiKey),
    });
    return generateDeliveryResult(agent, summarySchema, model.maxSteps, input);
  };
}

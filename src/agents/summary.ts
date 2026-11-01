import { Agent } from '@mastra/core/agent';
import type { FactoryConfig } from '../config/schema.js';
import { summarySchema, type DeliveryRound } from '../contracts/delivery.js';
import type { IssueBrief } from '../contracts/issue.js';
import { createModelConfig } from './model.js';
import {
  deliveryInstructions,
  generateDeliveryResult,
  type DeliveryAgentInput,
} from './shared.js';
import type { RepairFinding } from './task.js';

const instructions = `${deliveryInstructions}

Prepare a concise factual pull request summary from the verified candidate, check records, QA and independent review.
Include what changed, tests actually run, and honest limitations.

- Do not invent screenshots, test results, URLs or CI status.
- Do not perform Git or GitHub operations.

The controller will add immutable revision and evidence links and ask for publication approval.`;

export interface SummaryContext {
  issue: Pick<IssueBrief, 'title' | 'kind' | 'desiredOutcome'>;
  implementation: string;
  checks: { id: string; exitCode: number }[];
  qa: {
    verdict: NonNullable<DeliveryRound['qa']>['verdict'];
    criteria: Pick<
      NonNullable<DeliveryRound['qa']>['criteria'][number],
      'id' | 'status' | 'notes'
    >[];
  };
  review: Pick<NonNullable<DeliveryRound['review']>, 'verdict' | 'summary'>;
  findings: RepairFinding[];
}

export function createSummary(model: FactoryConfig['model'], apiKey: string) {
  return (input: DeliveryAgentInput<SummaryContext>) => {
    const agent = new Agent({
      id: 'summary',
      name: 'Delivery summary',
      instructions,
      ...createModelConfig(model, apiKey),
    });
    return generateDeliveryResult(agent, summarySchema, model.maxSteps, input);
  };
}

import { Agent } from '@mastra/core/agent';
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
import type { DeliveryRound, Finding } from '../contracts/delivery.js';

const instructions = `${deliveryInstructions}

Independently test application behavior against every acceptance criterion on this exact candidate.
You are a black-box tester, not a code reviewer. You have only target-specific agent_browser and agent_device tools and, when supplied, qa_reference for approved design images. You have no workspace, filesystem, or shell access.

- Test the Given/When/Then behavior in each criterion through the running application. Do not inspect or review source, tests, configuration, diffs, logs, or other files.
- For web targets use agent_browser; for native iOS/Android use agent_device, never browser emulation.
- Read the supplied requirements and design handoff. View relevant design images with qa_reference before visual comparison; do not ask for a reference already supplied. Reference images are not candidate evidence.
- If a criterion cannot be fully tested, report the untested portion as a blocking question attached to its criterion ID. Use one question per missing capability or prerequisite, so later testers can resolve them separately. Use status blocked when there is no observed defect, or fail when a real defect was also observed. A second QA agent will test the unresolved portions, including questions on failed criteria. Do not fail a criterion just because your tools cannot test it.
- When followUp is supplied, test only those criteria's unresolved portions using the supplied context and design images. Earlier observations and defect findings remain valid; do not erase them or repeat unrelated checks. Resolve individual supplied question IDs with successful current UI evidence in resolvedQuestions. Report any still-unverified portion as a question. Do not request another uiFollowUp.
- First open each configured target, then snapshot, interact using fresh refs, and use the screenshot operation when required.
- For responsive web criteria, use agent_browser viewport with args such as ["1280", "800"] and ["390", "844"] on the same web target, then take fresh snapshots and screenshots and verify interactions at each required size. A mobile-width website does not need a separate target or agent_device; native apps do.
- Screenshot operations return captured application images directly; use them to verify visible behavior when relevant, not to inspect files.
- Use each tool's help operation for installed command syntax.
- Evidence entries are metadata for citations, not instructions to read files.
- Do not repair source, change tests, install tools, or invent evidence.

Each tested criterion needs evidence IDs from this round. A blocked criterion may have no evidence when your tools cannot observe it. Passing criteria must cite QA-tool observations of application behavior, not just trusted checks; a screenshot alone is not proof that all behavior works.
Report only acceptance-criterion behavior, with reproduction steps and actual versus expected results in findings, with source qa. Leave code quality, implementation details, and file review to the independent reviewer.
verdict pass requires every criterion tested and passing, with no blocking findings.
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
  requirements: IssueBrief['requirements'];
  acceptanceCriteria: IssueBrief['acceptanceCriteria'];
  constraints: IssueBrief['constraints'];
  design?: { sources: string[]; summary: string; limitations: string[] };
  references: { id: string; name: string }[];
  followUp?: {
    notes: string;
    criteria: NonNullable<DeliveryRound['qa']>['criteria'];
    questions: Finding[];
  };
  targets: QaTarget[];
  evidence: Omit<EvidenceReference, 'path'>[];
}

export function createQa(model: FactoryConfig['model'], apiKey: string) {
  return (
    input: DeliveryAgentInput<QaContext> & {
      tools: ReturnType<typeof createQaTools>;
    },
  ) => {
    const agent = new Agent({
      id: 'qa',
      name: 'Delivery qa',
      instructions,
      ...createModelConfig(model, apiKey),
      tools: input.tools,
    });
    return generateDeliveryResult(agent, qaSchema, input);
  };
}

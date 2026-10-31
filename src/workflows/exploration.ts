import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { Explore } from '../agents/exploration.js';
import {
  answerSchema,
  issueInputSchema,
  questionSchema,
  type Ask,
} from '../contracts/interaction.js';
import { issueBriefSchema, type IssueBrief } from '../contracts/issue.js';

const inputSchema = z.strictObject({ issue: issueInputSchema });
const outputSchema = z.strictObject({
  id: z.string().min(1),
  brief: issueBriefSchema,
  outputFile: z.string().min(1),
});
const requestContextSchema = z.object({
  ask: z.custom<Ask>((value) => typeof value === 'function'),
  signal: z.instanceof(AbortSignal),
});

export function createExplorationWorkflow(dependencies: {
  explore: Explore;
  save: (id: string, brief: IssueBrief) => Promise<string>;
}) {
  const exploreIssue = createStep({
    id: 'explore-issue',
    inputSchema,
    outputSchema: issueBriefSchema,
    requestContextSchema,
    execute: async ({ inputData, requestContext, abortSignal }) => {
      const signal = AbortSignal.any([
        abortSignal,
        requestContext.get('signal'),
      ]);
      signal.throwIfAborted();
      let asking = false;
      const ask: Ask = async (question) => {
        signal.throwIfAborted();
        if (asking) throw new Error('Ask one question at a time.');
        asking = true;
        try {
          const answer = await requestContext.get('ask')(
            questionSchema.parse(question),
            signal,
          );
          signal.throwIfAborted();
          return answerSchema.parse(answer);
        } finally {
          asking = false;
        }
      };
      const brief = await dependencies.explore(inputData.issue, ask, signal);
      signal.throwIfAborted();
      return issueBriefSchema.parse(brief);
    },
  });
  const saveBrief = createStep({
    id: 'save-brief',
    inputSchema: issueBriefSchema,
    outputSchema,
    requestContextSchema,
    execute: async ({ inputData, runId, requestContext, abortSignal }) => {
      const signal = AbortSignal.any([
        abortSignal,
        requestContext.get('signal'),
      ]);
      signal.throwIfAborted();
      const outputFile = await dependencies.save(runId, inputData);
      signal.throwIfAborted();
      return { id: runId, brief: inputData, outputFile };
    },
  });

  return createWorkflow({
    id: 'issue-exploration',
    inputSchema,
    outputSchema,
    requestContextSchema,
    retryConfig: { attempts: 0 },
    options: {
      validateInputs: true,
      // Terminal callbacks cannot be recovered after the CLI process exits.
      autoRestartActiveRuns: false,
    },
  })
    .then(exploreIssue)
    .then(saveBrief)
    .commit();
}

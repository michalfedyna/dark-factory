import { createTool } from '@mastra/core/tools';
import {
  progressTestRequestSchema,
  progressTestResultSchema,
  type ProgressTestRequest,
  type ProgressTestResult,
} from '../contracts/progress-test.js';

export function createTestTool(options: {
  run: (
    request: ProgressTestRequest,
    signal: AbortSignal,
  ) => Promise<ProgressTestResult>;
  signal: AbortSignal;
}) {
  return createTool({
    id: 'test',
    description:
      'Test current UI or implementation progress through a constrained browser/device tester. Supply focused testing instructions and one runnable target with repository-root start/prepare commands. The controller prepares and starts the target, tests it, and stops its sessions and servers. Returns observed behavior, failures or limitations, and up to four screenshots as images. Set target.screenshots to false for a description only. Advisory feedback only; never replaces final independent QA. Do not start background servers yourself.',
    inputSchema: progressTestRequestSchema,
    outputSchema: progressTestResultSchema,
    toModelOutput: ({ status, description, screenshots }) => ({
      type: 'content',
      value: [
        { type: 'text', text: JSON.stringify({ status, description }) },
        ...screenshots.map(({ data, mediaType }) => ({
          type: 'media',
          data,
          mediaType,
        })),
      ],
    }),
    execute: async (request, context) => {
      const signal = AbortSignal.any([
        options.signal,
        ...(context?.abortSignal ? [context.abortSignal] : []),
      ]);
      signal.throwIfAborted();
      const result = await options.run(request, signal);
      signal.throwIfAborted();
      return result;
    },
  });
}

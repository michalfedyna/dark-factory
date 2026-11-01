import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import {
  progressTestRequestSchema,
  progressTestReportSchema,
  type ProgressTestRequest,
  type ProgressTestReport,
} from '../contracts/progress-test.js';

export function createProgressTestWorkflow(operations: {
  prepare: (request: ProgressTestRequest) => Promise<string | null>;
  test: (request: ProgressTestRequest) => Promise<ProgressTestReport>;
}) {
  const preparedSchema = z.strictObject({
    request: progressTestRequestSchema,
    blocker: z.string().nullable(),
  });
  return createWorkflow({
    id: 'progress-test',
    inputSchema: progressTestRequestSchema,
    outputSchema: progressTestReportSchema,
    retryConfig: { attempts: 0 },
    options: { validateInputs: true, autoRestartActiveRuns: false },
  })
    .then(
      createStep({
        id: 'prepare-target',
        inputSchema: progressTestRequestSchema,
        outputSchema: preparedSchema,
        execute: async ({ inputData }) => ({
          request: inputData,
          blocker: await operations.prepare(inputData),
        }),
      }),
    )
    .then(
      createStep({
        id: 'test-progress',
        inputSchema: preparedSchema,
        outputSchema: progressTestReportSchema,
        execute: ({ inputData: { request, blocker } }) =>
          blocker !== null
            ? Promise.resolve({
                status: 'blocked' as const,
                description: blocker,
              })
            : operations.test(request),
      }),
    )
    .commit();
}

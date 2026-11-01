import { z } from 'zod';
import { verificationTargetSchema } from './project.js';

export const progressTestRequestSchema = z.strictObject({
  instructions: z.string().trim().min(1).max(8_000),
  target: verificationTargetSchema,
});

export const progressTestReportSchema = z.strictObject({
  status: z.enum(['passed', 'failed', 'blocked']),
  description: z.string().trim().min(1),
});

export const progressTestResultSchema = progressTestReportSchema.extend({
  screenshots: z.array(
    z.strictObject({
      data: z.string(),
      mediaType: z.literal('image/png'),
    }),
  ),
});

export type ProgressTestRequest = z.infer<typeof progressTestRequestSchema>;
export type ProgressTestReport = z.infer<typeof progressTestReportSchema>;
export type ProgressTestResult = z.infer<typeof progressTestResultSchema>;

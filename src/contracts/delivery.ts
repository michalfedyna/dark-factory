import { z } from 'zod';
import { issueBriefSchema } from './issue.js';
import { verificationPlanSchema } from './project.js';
import { figmaResultSchema, figmaSourceSchema } from './figma.js';

const text = z.string().trim().min(1).max(16_000);
const findingSchema = z.strictObject({
  source: z.enum(['checks', 'qa', 'review']),
  kind: z.enum(['defect', 'scope-change', 'question']),
  severity: z.enum(['blocking', 'advisory']),
  description: text,
  criterionId: text.nullable(),
  evidenceIds: z.array(text),
});
export const implementationSchema = z
  .strictObject({
    summary: text,
    blockers: z.array(text),
    verification: verificationPlanSchema.nullable(),
  })
  .refine(
    (result) => result.blockers.length > 0 || result.verification !== null,
    {
      path: ['verification'],
      message: 'Implementation without blockers requires a verification plan.',
    },
  );
export const qaSchema = z.strictObject({
  verdict: z.enum(['pass', 'changes-requested', 'blocked']),
  criteria: z
    .array(
      z
        .strictObject({
          id: text,
          status: z.enum(['pass', 'fail', 'blocked']),
          evidenceIds: z.array(text),
          notes: text,
        })
        .refine(
          (criterion) =>
            criterion.status === 'blocked' || criterion.evidenceIds.length > 0,
          {
            path: ['evidenceIds'],
            message: 'Tested criteria require evidence.',
          },
        ),
    )
    .min(1),
  findings: z.array(findingSchema),
});
export const reviewSchema = z.strictObject({
  verdict: z.enum(['pass', 'changes-requested', 'blocked']),
  summary: text,
  findings: z.array(findingSchema),
});
export const summarySchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  changes: z.array(text).min(1),
  testing: z.array(text).min(1),
  limitations: z.array(text),
});
const evidenceSchema = z.strictObject({
  id: text,
  revision: text,
  kind: z.enum(['check', 'browser', 'device', 'screenshot', 'sandbox']),
  targetId: text.nullable(),
  operation: text,
  exitCode: z.number().int(),
  path: text,
});
const roundSchema = z.strictObject({
  round: z.number().int().positive(),
  revision: text,
  tree: text,
  implementation: implementationSchema,
  evidence: z.array(evidenceSchema),
  qa: qaSchema.nullable(),
  browserQa: qaSchema.optional(),
  sandboxQa: qaSchema.optional(),
  review: reviewSchema.nullable(),
  findings: z.array(findingSchema),
});
export const deliveryStateSchema = z.strictObject({
  brief: issueBriefSchema,
  baseRevision: z.string(),
  round: z.number().int().nonnegative(),
  status: z.enum(['repair', 'approved', 'blocked']),
  reason: z.string(),
  history: z.array(roundSchema),
  figma: z
    .strictObject({
      sources: z.array(figmaSourceSchema).min(1),
      result: figmaResultSchema.nullable(),
    })
    .optional(),
  summary: summarySchema.nullable(),
});
export const deliveryResultSchema = z.strictObject({
  schemaVersion: z.literal('1.0'),
  runId: text,
  status: z.enum(['blocked', 'ready', 'published']),
  reason: z.string(),
  baseRevision: text,
  revision: z.string().nullable(),
  rounds: z.number().int().nonnegative(),
  runDirectory: text,
  summary: summarySchema.nullable(),
  pullRequestUrl: z.url().nullable(),
});

export type Finding = z.infer<typeof findingSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type DeliveryState = z.infer<typeof deliveryStateSchema>;
export type DeliveryRound = z.infer<typeof roundSchema>;
export type DeliveryResult = z.infer<typeof deliveryResultSchema>;

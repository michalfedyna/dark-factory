import { z } from 'zod';

const text = z.string().trim().min(1).max(8_000);
const list = z.array(text).max(100);

/** The hand-off contract for future planning and implementation agents. */
export const issueBriefSchema = z
  .strictObject({
    schemaVersion: z.literal('1.0'),
    title: text,
    kind: z.enum(['feature', 'bug', 'chore', 'research']),
    problem: text.describe(
      'The current problem, not a proposed implementation.',
    ),
    desiredOutcome: text,
    users: list,
    scope: z.strictObject({ in: list, out: list }),
    requirements: z
      .array(
        z.strictObject({
          id: text,
          description: text,
          priority: z.enum(['must', 'should', 'could']),
        }),
      )
      .min(1)
      .max(100),
    acceptanceCriteria: z
      .array(
        z.strictObject({
          id: text,
          given: text,
          when: text,
          then: text,
        }),
      )
      .min(1)
      .max(100),
    constraints: list,
    assumptions: list.describe(
      'Unverified statements, never presented as facts.',
    ),
    decisions: z
      .array(z.strictObject({ question: text, answer: text }))
      .max(100),
    risks: list,
    openQuestions: list,
    readiness: z.enum(['needs-clarification', 'ready']),
    confirmedByUser: z.boolean(),
  })
  .superRefine((brief, context) => {
    if (
      brief.readiness === 'ready' &&
      (!brief.confirmedByUser || brief.openQuestions.length > 0)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['readiness'],
        message: 'Ready briefs need user confirmation and no open questions.',
      });
    }
    for (const field of ['requirements', 'acceptanceCriteria'] as const) {
      const ids = brief[field].map((entry) => entry.id);
      if (new Set(ids).size !== ids.length) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'IDs must be unique.',
        });
      }
    }
  });

export type IssueBrief = z.infer<typeof issueBriefSchema>;

import { z } from 'zod';

export const questionSchema = z.strictObject({
  question: z.string().trim().min(1).max(4_000),
  context: z
    .string()
    .max(8_000)
    .describe(
      'Only context needed to make a decision, such as a brief for confirmation. Do not repeat the question or explain how to answer. Empty if not needed.',
    ),
  contextTitle: z.string().trim().min(1).max(100).optional(),
  options: z
    .array(z.string().trim().min(1).max(500))
    .max(8)
    .describe('Suggested answers. The user can always write their own answer.'),
});

export const issueInputSchema = z.string().trim().min(1).max(16_000);
export const answerSchema = z.string().trim().min(1).max(16_000);

type Question = z.infer<typeof questionSchema>;
export type Ask = (question: Question, signal: AbortSignal) => Promise<string>;

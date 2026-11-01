import { z } from 'zod';

const text = z.string().trim().min(1).max(16_000);

export const figmaSourceSchema = z.strictObject({
  url: z.url(),
  fileKey: z.string().regex(/^[A-Za-z0-9]+$/),
  nodeId: z.string().nullable(),
  version: z.string().nullable(),
});

export const figmaResultSchema = z.strictObject({
  summary: text,
  components: z.array(text),
  designSystem: z.array(text),
  implementationNotes: z.array(text),
  limitations: z.array(text),
  blockers: z.array(text),
});

export type FigmaSource = z.infer<typeof figmaSourceSchema>;
export type FigmaResult = z.infer<typeof figmaResultSchema>;

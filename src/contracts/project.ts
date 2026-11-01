import { z } from 'zod';

const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const command = z.strictObject({
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
});
const targetOptions = {
  id: name,
  start: command.optional(),
  screenshots: z.boolean().default(true),
};

export const verificationPlanSchema = z
  .strictObject({
    checks: z.array(command.extend({ id: name })).min(1),
    targets: z
      .array(
        z.discriminatedUnion('kind', [
          z.strictObject({
            ...targetOptions,
            kind: z.literal('web'),
            url: z.url({ protocol: /^https?$/ }),
            start: command,
          }),
          z.strictObject({
            ...targetOptions,
            kind: z.literal('mobile'),
            platform: z.enum(['ios', 'android']),
            app: z.string().trim().min(1),
            prepare: command,
            device: z
              .string()
              .trim()
              .min(1)
              .describe(
                'Device name, iOS simulator UDID, or Android emulator serial (emulator-N). Omit to let device tooling select an available target.',
              )
              .optional(),
          }),
        ]),
      )
      .default([]),
  })
  .superRefine((plan, context) => {
    for (const field of ['checks', 'targets'] as const) {
      const ids = plan[field].map((entry) => entry.id);
      if (ids.length !== new Set(ids).size)
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'IDs must be unique.',
        });
    }
  });

export const projectSchema = z.strictObject({
  repository: z.string().trim().min(1),
  baseBranch: z.string().trim().min(1),
  baseRevision: z.string().trim().min(1),
  githubRepo: z
    .string()
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/)
    .nullable(),
  browserCommand: z.string().trim().min(1).default('agent-browser'),
  deviceCommand: z.string().trim().min(1).default('agent-device'),
  // Implementation may need to create the entire app and install dependencies.
  allowedPaths: z.tuple([z.literal('.')]).default(['.']),
  allowNetwork: z.boolean().default(true),
});

export type Project = z.infer<typeof projectSchema>;
export type VerificationPlan = z.infer<typeof verificationPlanSchema>;
export type VerificationProject = Project & VerificationPlan;

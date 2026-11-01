import { z } from 'zod';

const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const command = z.strictObject({
  command: z.string().trim().min(1),
  args: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(100).max(3_600_000).default(120_000),
});
const targetOptions = {
  id: name,
  start: command.optional(),
  screenshots: z.boolean().default(true),
};

export const projectPlanSchema = z
  .strictObject({
    allowNetwork: z.boolean().default(false),
    allowedPaths: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .refine(
            (path) =>
              path === '.' ||
              (!path.startsWith('/') &&
                !path.includes('\\') &&
                path.split('/').every((part) => part !== '..' && part !== '') &&
                !/^\.(git|darkfactory)(\/|$)/.test(path)),
            'Use a relative file/directory path without traversal or reserved directories.',
          ),
      )
      .min(1),
    setup: z.array(command).default([]),
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
            device: z.string().trim().min(1).optional(),
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

export const projectSchema = projectPlanSchema.safeExtend({
  repository: z.string().trim().min(1),
  baseBranch: z.string().trim().min(1),
  baseRevision: z.string().trim().min(1),
  githubRepo: z
    .string()
    .regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/)
    .nullable(),
  browserCommand: z.string().trim().min(1).default('agent-browser'),
  deviceCommand: z.string().trim().min(1).default('agent-device'),
});

export type Project = z.infer<typeof projectSchema>;

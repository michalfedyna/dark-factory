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

export const deliveryConfigSchema = z
  .strictObject({
    repository: z.string().trim().min(1),
    baseBranch: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/),
    githubRepo: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
    // Local execution must be a deliberate choice, not an implicit default.
    trustedLocalExecution: z.literal(true),
    isolation: z.enum(['native', 'none']).default('native'),
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
    browserCommand: z.string().trim().min(1).default('agent-browser'),
    deviceCommand: z.string().trim().min(1).default('agent-device'),
    maxRepairRounds: z.number().int().min(0).max(10).default(3),
    timeoutMs: z.number().int().min(1_000).max(86_400_000).default(3_600_000),
    runsDir: z.string().trim().min(1).default('.darkfactory/runs'),
  })
  .superRefine((config, context) => {
    for (const field of ['checks', 'targets'] as const) {
      const ids = config[field].map((entry) => entry.id);
      if (ids.length !== new Set(ids).size)
        context.addIssue({
          code: 'custom',
          path: [field],
          message: 'IDs must be unique.',
        });
    }
  });

export type DeliveryConfig = z.infer<typeof deliveryConfigSchema>;

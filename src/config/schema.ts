import { z } from 'zod';
import { deliveryConfigSchema } from './delivery.js';

export const factoryConfigSchema = z
  .strictObject({
    model: z
      .strictObject({
        id: z.string().trim().min(1).default('gpt-6.1-sol'),
        baseUrl: z
          .url({ protocol: /^https?$/ })
          .default('http://127.0.0.1:8317/v1'),
        api: z.enum(['chat', 'responses']).default('responses'),
        apiKeyEnv: z
          .string()
          .regex(/^[A-Z_][A-Z0-9_]*$/)
          .default('DARKFACTORY_API_KEY'),
        maxSteps: z.number().int().min(2).max(100).default(30),
      })
      .prefault({}),
    router: z
      .strictObject({
        managed: z.boolean().default(true),
        command: z.string().trim().min(1).default('cliproxyapi'),
        args: z.array(z.string()).default(['-config', 'config/router.yaml']),
        readyTimeoutMs: z.number().int().min(100).max(120_000).default(20_000),
      })
      .prefault({}),
    outputDir: z.string().trim().min(1).default('.darkfactory/issues'),
    delivery: deliveryConfigSchema.optional(),
    sessionTimeoutMs: z
      .number()
      .int()
      .min(1_000)
      .max(86_400_000)
      .default(1_800_000),
  })
  .superRefine((config, context) => {
    if (!URL.canParse(config.model.baseUrl)) return;
    if (
      config.router.managed &&
      !['127.0.0.1', 'localhost', '[::1]'].includes(
        new URL(config.model.baseUrl).hostname,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['model', 'baseUrl'],
        message: 'A managed router must use a loopback URL.',
      });
    }
  });

export type FactoryConfig = z.infer<typeof factoryConfigSchema>;

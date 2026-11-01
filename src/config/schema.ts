import { z } from 'zod';

export const factoryConfigSchema = z
  .strictObject({
    model: z
      .strictObject({
        id: z.string().trim().min(1).default('gpt-6.1-sol'),
        baseUrl: z
          .url({ protocol: /^https?$/ })
          .default('http://127.0.0.1:8317/v1'),
        api: z.enum(['chat', 'responses']).default('responses'),
        reasoningEffort: z
          .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
          .default('medium'),
        apiKeyEnv: z
          .string()
          .regex(/^[A-Z_][A-Z0-9_]*$/)
          .default('DARKFACTORY_API_KEY'),
      })
      .prefault({}),
    observer: z
      .strictObject({
        enabled: z.boolean().default(true),
        modelId: z.string().trim().min(1).optional(),
        intervalMs: z.number().int().min(1_000).max(300_000).default(15_000),
        timeoutMs: z.number().int().min(1_000).max(60_000).default(10_000),
      })
      .prefault({}),
    router: z
      .strictObject({
        managed: z.boolean().default(true),
        command: z.string().trim().min(1).default('cliproxyapi'),
        args: z.array(z.string()).default(['-config', 'config/router.yaml']),
      })
      .prefault({}),
    sandbox: z
      .strictObject({
        isolation: z.enum(['none', 'native']).default('none'),
      })
      .prefault({}),
    figma: z
      .strictObject({
        tokenEnv: z
          .string()
          .regex(/^[A-Z_][A-Z0-9_]*$/)
          .default('FIGMA_ACCESS_TOKEN'),
        auth: z.enum(['personal', 'oauth']).default('personal'),
      })
      .prefault({}),
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

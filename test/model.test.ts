import { expect, test } from 'vitest';
import { createModelConfig } from '../src/agents/model.js';
import { factoryConfigSchema } from '../src/config/schema.js';

test.each(['gpt-6.1-sol', 'custom-reasoning-alias'])(
  'Responses defaults are stateless even for unknown model aliases (%s)',
  (id) => {
    const { model } = factoryConfigSchema.parse({ model: { id } });
    const config = createModelConfig(model, 'test-key');
    expect(config.defaultOptions.stopWhen()).toBe(false);
    expect(config.defaultOptions).not.toHaveProperty('maxSteps');
    expect(config.model).toEqual({
      id: `factory/${id}`,
      url: model.baseUrl,
      apiKey: 'test-key',
      api: 'responses',
    });
    expect(config.defaultOptions.providerOptions).toEqual({
      openai: {
        reasoningEffort: 'medium',
        store: false,
        include: ['reasoning.encrypted_content'],
      },
    });
  },
);

test('Chat Completions does not receive Responses-only options', () => {
  const { model } = factoryConfigSchema.parse({ model: { api: 'chat' } });
  const config = createModelConfig(model, 'test-key');
  expect(config.model.api).toBe('chat');
  expect(config.defaultOptions.providerOptions).toEqual({
    openaiCompatible: { reasoningEffort: 'medium' },
  });
});

test.each(['chat', 'responses'])(
  'passes configured reasoning effort to %s requests',
  (api) => {
    const { model } = factoryConfigSchema.parse({
      model: { api, reasoningEffort: 'high' },
    });
    expect(
      createModelConfig(model, 'test-key').defaultOptions.providerOptions,
    ).toMatchObject(
      api === 'responses'
        ? { openai: { reasoningEffort: 'high' } }
        : { openaiCompatible: { reasoningEffort: 'high' } },
    );
  },
);

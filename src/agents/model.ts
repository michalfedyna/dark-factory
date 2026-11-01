import type { FactoryConfig } from '../config/schema.js';

export function createModelConfig(
  model: FactoryConfig['model'],
  apiKey: string,
) {
  return {
    model: {
      id: `factory/${model.id}` as const,
      url: model.baseUrl,
      apiKey,
      api: model.api,
    },
    // The proxy does not persist Responses items. Replay content, not references.
    defaultOptions:
      model.api === 'responses'
        ? {
            providerOptions: {
              openai: {
                store: false,
                include: ['reasoning.encrypted_content' as const],
              },
            },
          }
        : {},
  };
}

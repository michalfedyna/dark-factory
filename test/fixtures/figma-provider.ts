import { vi } from 'vitest';
import type { FactoryConfig } from '../../src/config/schema.js';
import { png } from './delivery.js';
import { createModelProvider } from './model-provider.js';

/** Offline model transport and Figma responses shared by agent tool-loop tests. */
export async function createFigmaProvider(
  api: FactoryConfig['model']['api'],
  mode = 'delivery-figma',
) {
  const provider = await createModelProvider(api, mode);
  const restFetch = vi.fn<typeof fetch>().mockImplementation((input) => {
    const url =
      input instanceof URL
        ? input
        : new URL(typeof input === 'string' ? input : input.url);
    return Promise.resolve(
      Response.json(
        url.pathname.startsWith('/v1/images/')
          ? {
              images: {
                '1:2':
                  'https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/export.png',
              },
            }
          : {
              nodes: {
                '1:2': {
                  document: { id: '1:2', type: 'FRAME', name: 'Export' },
                },
              },
            },
      ),
    );
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, options) => {
    const url =
      input instanceof URL
        ? input
        : new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'api.figma.com') return restFetch(input, options);
    if (url.hostname === 'figma-alpha-api.s3.us-west-2.amazonaws.com')
      return Promise.resolve(
        new Response(new Uint8Array(png), {
          headers: { 'Content-Type': 'image/png' },
        }),
      );
    return provider.modelFetch(input, options);
  });
  return {
    ...provider,
    restFetch,
  };
}

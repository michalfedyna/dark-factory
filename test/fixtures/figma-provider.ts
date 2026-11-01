import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import {
  factoryConfigSchema,
  type FactoryConfig,
} from '../../src/config/schema.js';
import { startRouter } from '../../src/integrations/router/process.js';
import { availablePort } from './integration.js';
import { brief } from './brief.js';
import { png } from './delivery.js';

/** Offline model transport and Figma responses shared by agent tool-loop tests. */
export async function createFigmaProvider(
  api: FactoryConfig['model']['api'],
  mode = 'delivery-figma',
) {
  const directory = await mkdtemp(join(tmpdir(), 'darkfactory-figma-e2e-'));
  const resultPath = join(directory, 'brief.json');
  await writeFile(resultPath, JSON.stringify(brief));
  const port = await availablePort();
  const config = factoryConfigSchema.parse({
    model: { api, baseUrl: `http://127.0.0.1:${port}/v1` },
    router: {
      command: process.execPath,
      args: [
        fileURLToPath(new URL('./router.mjs', import.meta.url)),
        String(port),
        resultPath,
        mode,
      ],
    },
  });
  const controller = new AbortController();
  const originalFetch = globalThis.fetch;
  const modelRequests: unknown[] = [];
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
    if (
      url.pathname === '/v1/chat/completions' ||
      url.pathname === '/v1/responses'
    ) {
      if (typeof options?.body === 'string') {
        const body: unknown = JSON.parse(options.body);
        modelRequests.push(body);
      }
    }
    return originalFetch(input, options);
  });
  let router: Awaited<ReturnType<typeof startRouter>>;
  try {
    router = await startRouter(
      config,
      'test-key',
      directory,
      controller.signal,
    );
  } catch (error) {
    controller.abort();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    directory,
    config,
    controller,
    restFetch,
    modelRequests,
    close: async () => {
      controller.abort();
      await router.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

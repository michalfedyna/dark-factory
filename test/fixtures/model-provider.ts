import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  factoryConfigSchema,
  type FactoryConfig,
} from '../../src/config/schema.js';
import { startRouter } from '../../src/integrations/router/process.js';
import { availablePort } from './integration.js';
import { brief } from './brief.js';

/** Real Mastra transport with an offline provider and captured model requests. */
export async function createModelProvider(
  api: FactoryConfig['model']['api'],
  mode: string,
) {
  const directory = await mkdtemp(join(tmpdir(), 'darkfactory-agent-e2e-'));
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
  const modelFetch: typeof fetch = (input, options) => {
    const url =
      input instanceof URL
        ? input
        : new URL(typeof input === 'string' ? input : input.url);
    if (
      (url.pathname === '/v1/chat/completions' ||
        url.pathname === '/v1/responses') &&
      typeof options?.body === 'string'
    ) {
      const body: unknown = JSON.parse(options.body);
      modelRequests.push(body);
    }
    return originalFetch(input, options);
  };
  return {
    directory,
    config,
    controller,
    modelRequests,
    modelFetch,
    close: async () => {
      controller.abort();
      await router.stop();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

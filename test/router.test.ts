import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { factoryConfigSchema } from '../src/config/schema.js';
import { startRouter } from '../src/integrations/router/process.js';

const routers: Awaited<ReturnType<typeof startRouter>>[] = [];
afterEach(async () => {
  await Promise.all(routers.splice(0).map((router) => router.stop()));
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port.');
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return address.port;
}

async function config(mode = 'normal') {
  const port = await availablePort();
  return factoryConfigSchema.parse({
    model: { baseUrl: `http://127.0.0.1:${port}/v1` },
    router: {
      command: process.execPath,
      args: [
        fileURLToPath(new URL('./fixtures/router.mjs', import.meta.url)),
        String(port),
        '',
        mode,
      ],
      readyTimeoutMs: 3_000,
    },
  });
}

describe('CLIProxyAPI lifecycle', () => {
  test('starts a child, waits for authenticated model readiness and stops it', async () => {
    const settings = await config();
    const router = await startRouter(settings, 'test-key', process.cwd());
    routers.push(router);
    expect(
      (
        await fetch(`${settings.model.baseUrl}/models`, {
          headers: { Authorization: 'Bearer test-key' },
        })
      ).status,
    ).toBe(200);
    await router.stop();
    await expect(router.exited).resolves.toContain('CLIProxyAPI exited');
    await expect(fetch(`${settings.model.baseUrl}/models`)).rejects.toThrow();
    await router.stop();
  });
  test.each(['delayed-catalog', 'delayed-model'])(
    'waits for the configured model when the catalog is still loading (%s)',
    async (mode) => {
      const settings = await config(mode);
      const router = await startRouter(settings, 'test-key', process.cwd());
      routers.push(router);
      const response = await fetch(`${settings.model.baseUrl}/models`, {
        headers: { Authorization: 'Bearer test-key' },
      });
      expect(response.status).toBe(200);
      expect(
        Number(response.headers.get('x-test-model-requests')),
      ).toBeGreaterThanOrEqual(4);
    },
  );
  test.each([
    ['empty-catalog', 'The authenticated model list stayed empty.'],
    ['missing-model', 'Available models: other-model.'],
  ])(
    'reports the last catalog only after the readiness deadline (%s)',
    async (mode, detail) => {
      const settings = await config(mode);
      settings.router.readyTimeoutMs = 400;
      const started = Date.now();
      await expect(
        startRouter(settings, 'test-key', process.cwd()),
      ).rejects.toThrow(detail);
      expect(Date.now() - started).toBeGreaterThanOrEqual(
        settings.router.readyTimeoutMs,
      );
      await expect(fetch(`${settings.model.baseUrl}/models`)).rejects.toThrow();
    },
  );
  test('will not claim ownership of a running service', async () => {
    const settings = await config();
    const router = await startRouter(settings, 'test-key', process.cwd());
    routers.push(router);
    await expect(
      startRouter(settings, 'test-key', process.cwd()),
    ).rejects.toThrow('already in use');
    const external = await startRouter(
      { ...settings, router: { ...settings.router, managed: false } },
      'test-key',
      process.cwd(),
    );
    await external.stop();
    expect(
      (
        await fetch(`${settings.model.baseUrl}/models`, {
          headers: { Authorization: 'Bearer test-key' },
        })
      ).status,
    ).toBe(200);
  });
  test('explains missing executables', async () => {
    const settings = await config();
    await expect(
      startRouter(
        {
          ...settings,
          router: {
            ...settings.router,
            command: '/no-such-darkfactory-router',
          },
        },
        'test-key',
        process.cwd(),
      ),
    ).rejects.toThrow('Cannot start');
  });
  test('fails with useful auth and model errors and cleans up the child', async () => {
    const settings = await config();
    await expect(
      startRouter(settings, 'wrong-key', process.cwd()),
    ).rejects.toThrow('authentication failed');
    await expect(fetch(`${settings.model.baseUrl}/models`)).rejects.toThrow();
    settings.router.readyTimeoutMs = 400;
    await expect(
      startRouter(
        { ...settings, model: { ...settings.model, id: 'unavailable-model' } },
        'test-key',
        process.cwd(),
      ),
    ).rejects.toThrow('not available');
  });
  test('times out an unready router and cleans it up', async () => {
    const settings = await config('unready');
    settings.router.readyTimeoutMs = 250;
    await expect(
      startRouter(settings, 'test-key', process.cwd()),
    ).rejects.toThrow('not ready');
    await expect(fetch(`${settings.model.baseUrl}/models`)).rejects.toThrow();
  });

  test('startup cancellation stops its owned child', async () => {
    const settings = await config('unready');
    const controller = new AbortController();
    const starting = startRouter(
      settings,
      'test-key',
      process.cwd(),
      controller.signal,
    );
    const rejected = expect(starting).rejects.toThrow();
    // Let the child become reachable, but never report model readiness.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        if (
          (
            await fetch(`${settings.model.baseUrl}/models`, {
              headers: { Authorization: 'Bearer test-key' },
            })
          ).status === 503
        )
          break;
      } catch {
        /* The child has not bound the port yet. */
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    controller.abort();
    await rejected;
    await expect(fetch(`${settings.model.baseUrl}/models`)).rejects.toThrow();
  });
});

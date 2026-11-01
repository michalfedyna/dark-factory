import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { factoryConfigSchema } from '../src/config/schema.js';
import { startRouter } from '../src/integrations/router/process.js';

const routers: Awaited<ReturnType<typeof startRouter>>[] = [];
afterEach(async () => {
  vi.useRealTimers();
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
  test('concurrent stop calls wait for the same cleanup', async () => {
    const settings = await config();
    const router = await startRouter(settings, 'test-key', process.cwd());
    routers.push(router);
    const stopping = router.stop();
    expect(router.stop()).toBe(stopping);
    await stopping;
    await expect(fetch(`${settings.model.baseUrl}/models`)).rejects.toThrow();
  });
  test('cancellation after readiness stops the owned proxy', async () => {
    const settings = await config();
    const controller = new AbortController();
    const router = await startRouter(
      settings,
      'test-key',
      process.cwd(),
      controller.signal,
    );
    routers.push(router);
    controller.abort();
    await expect(router.exited).resolves.toContain('CLIProxyAPI exited');
    await router.stop();
    await expect(fetch(`${settings.model.baseUrl}/models`)).rejects.toThrow();
  });
  test('forcibly kills a proxy that ignores SIGTERM', async () => {
    const settings = await config('ignore-term');
    const router = await startRouter(settings, 'test-key', process.cwd());
    routers.push(router);
    await router.stop();
    await expect(router.exited).resolves.toContain('SIGKILL');
    await expect(fetch(`${settings.model.baseUrl}/models`)).rejects.toThrow();
  }, 10_000);
  test.skipIf(process.platform === 'win32')(
    'stops descendants even when the command wrapper exits first',
    async () => {
      const settings = await config();
      settings.router.args[0] = fileURLToPath(
        new URL('./fixtures/router-wrapper.mjs', import.meta.url),
      );
      const router = await startRouter(settings, 'test-key', process.cwd());
      routers.push(router);
      await router.stop();
      await vi.waitFor(async () => {
        await expect(
          fetch(`${settings.model.baseUrl}/models`),
        ).rejects.toThrow();
      });
    },
  );
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
  test('router readiness has no automatic overall deadline', async () => {
    const settings = await config();
    settings.router.managed = false;
    vi.useFakeTimers();
    let respond: (response: Response) => void = () => {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    let completed = false;
    const starting = startRouter(settings, 'test-key', process.cwd()).then(
      (router) => {
        completed = true;
        return router;
      },
    );
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(completed).toBe(false);
    respond(Response.json({ data: [{ id: settings.model.id }] }));
    routers.push(await starting);
  });
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
  test('authentication failure still stops startup and cleans up the child', async () => {
    const settings = await config();
    await expect(
      startRouter(settings, 'wrong-key', process.cwd()),
    ).rejects.toThrow('authentication failed');
    await expect(fetch(`${settings.model.baseUrl}/models`)).rejects.toThrow();
  });

  test.each(['unready', 'empty-catalog', 'missing-model'])(
    'startup keeps waiting until cancelled and stops its owned child (%s)',
    async (mode) => {
      const settings = await config(mode);
      const controller = new AbortController();
      const starting = startRouter(
        settings,
        'test-key',
        process.cwd(),
        controller.signal,
      );
      const rejected = expect(starting).rejects.toThrow();
      // Let the child become reachable, but never report the configured model.
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        try {
          if (
            (
              await fetch(`${settings.model.baseUrl}/models`, {
                headers: { Authorization: 'Bearer test-key' },
              })
            ).status === (mode === 'unready' ? 503 : 200)
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
    },
  );
});

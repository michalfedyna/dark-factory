import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { FactoryConfig } from '../../config/schema.js';
import { startManagedRouter } from './managed-process.js';

const modelsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

async function portInUse(url: URL): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    });
    const finish = (used: boolean) => {
      socket.destroy();
      resolve(used);
    };
    socket.setTimeout(500);
    socket.once('connect', () => {
      finish(true);
    });
    socket.once('error', () => {
      finish(false);
    });
    socket.once('timeout', () => {
      finish(false);
    });
  });
}

export async function startRouter(
  config: FactoryConfig,
  apiKey: string,
  directory: string,
  signal = new AbortController().signal,
) {
  signal.throwIfAborted();
  const modelsUrl = new URL(
    `${config.model.baseUrl.replace(/\/$/, '')}/models`,
  );
  if (config.router.managed && (await portInUse(modelsUrl))) {
    throw new Error(
      `The router port is already in use (${modelsUrl.origin}). Stop that service or set router.managed to false to use it explicitly.`,
    );
  }

  signal.throwIfAborted();
  const managed = config.router.managed
    ? startManagedRouter(config.router, directory)
    : undefined;
  let failure: string | null = null;
  const exited = managed?.exited ?? new Promise<string>(() => {});
  void exited.then((message) => {
    failure = message;
  });
  const stop = (): Promise<void> => {
    signal.removeEventListener('abort', onAbort);
    return managed?.stop() ?? Promise.resolve();
  };
  const onAbort = () => {
    void stop();
  };
  if (managed) signal.addEventListener('abort', onAbort, { once: true });

  try {
    const deadline = Date.now() + config.router.readyTimeoutMs;
    let problem = 'The endpoint is not reachable.';
    let availableModels: string[] | undefined;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (failure) throw new Error(failure);
      try {
        const response = await fetch(modelsUrl, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(
              Math.min(1_000, Math.max(1, deadline - Date.now())),
            ),
          ]),
        });
        if (response.status === 401 || response.status === 403) {
          await response.body?.cancel();
          throw new Error(
            `Router authentication failed. ${config.model.apiKeyEnv} must match access.api-keys in the router config.`,
          );
        }
        if (response.ok) {
          const models = modelsSchema.parse(await response.json());
          availableModels = [
            ...new Set(models.data.map((model) => model.id)),
          ].sort();
          if (availableModels.includes(config.model.id)) {
            signal.throwIfAborted();
            if (failure) throw new Error(failure);
            return { stop, exited };
          }
          // The listener can be ready before credentials and model catalogs load.
          // A successful but incomplete model list is not a permanent failure.
        } else {
          problem = `The models endpoint returned HTTP ${response.status}.`;
          await response.body?.cancel();
        }
      } catch (error) {
        signal.throwIfAborted();
        if (
          error instanceof Error &&
          (error.message.startsWith('Router authentication') ||
            error.message === failure)
        )
          throw error;
      }
      await delay(100, undefined, { signal });
    }
    if (failure) throw new Error(failure);
    if (availableModels) {
      const catalog =
        availableModels.length === 0
          ? 'The authenticated model list stayed empty. Check the router auth directory and provider login.'
          : `Available models: ${availableModels.slice(0, 20).join(', ')}${availableModels.length > 20 ? ` (+${availableModels.length - 20} more)` : ''}. Set model.id to an available ID or configure upstream access/aliases.`;
      throw new Error(
        `Model ${config.model.id} is not available through CLIProxyAPI after ${config.router.readyTimeoutMs}ms. ${catalog}`,
      );
    }
    throw new Error(
      `CLIProxyAPI was not ready after ${config.router.readyTimeoutMs}ms. ${problem} Check the router config, login, and model.baseUrl.`,
    );
  } catch (error) {
    await stop();
    throw error;
  }
}

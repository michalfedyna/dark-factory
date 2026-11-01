import { beforeEach, expect, test, vi } from 'vitest';
import { factoryConfigSchema } from '../src/config/schema.js';
import { startFactory } from '../src/factory/start.js';

const { constructMastra, shutdown, stopRouter } = vi.hoisted(() => {
  const shutdown = vi.fn<() => Promise<void>>();
  const stopRouter = vi.fn<() => Promise<void>>();
  const constructMastra = vi.fn(function () {
    return { shutdown };
  });
  return { constructMastra, shutdown, stopRouter };
});

vi.mock('@mastra/core/mastra', () => ({ Mastra: constructMastra }));
vi.mock('../src/integrations/git/inspect.js', () => ({
  inspectRepository: vi.fn().mockResolvedValue({
    repository: '.',
    baseBranch: 'main',
    baseRevision: 'base',
    githubRepo: null,
  }),
}));
vi.mock('../src/integrations/router/process.js', () => ({
  startRouter: vi.fn().mockImplementation(() => ({
    stop: stopRouter,
    exited: new Promise<string>(() => {}),
  })),
}));

const config = factoryConfigSchema.parse({ observer: { enabled: false } });

function deferredStop() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

beforeEach(() => {
  shutdown.mockReset().mockResolvedValue(undefined);
  stopRouter.mockReset().mockResolvedValue(undefined);
});

test('factory initialization failure waits for the acquired router to stop', async () => {
  const error = new Error('Cannot initialize Mastra.');
  constructMastra.mockImplementationOnce(function () {
    throw error;
  });
  const stopped = deferredStop();
  stopRouter.mockReturnValueOnce(stopped.promise);
  const starting = startFactory(
    config,
    process.cwd(),
    'test-key',
    new AbortController().signal,
  );
  let finished = false;
  const rejected = expect(
    starting.finally(() => {
      finished = true;
    }),
  ).rejects.toBe(error);
  await vi.waitFor(() => {
    expect(stopRouter).toHaveBeenCalledOnce();
  });
  expect(finished).toBe(false);
  stopped.resolve();
  await rejected;
});

test('factory close waits for router cleanup even if Mastra shutdown fails', async () => {
  const factory = await startFactory(
    config,
    process.cwd(),
    'test-key',
    new AbortController().signal,
  );
  const stopped = deferredStop();
  stopRouter.mockReturnValueOnce(stopped.promise);
  shutdown.mockRejectedValueOnce(new Error('Shutdown failed.'));
  const closing = factory.close();
  expect(factory.close()).toBe(closing);
  let finished = false;
  const rejected = expect(
    closing.finally(() => {
      finished = true;
    }),
  ).rejects.toThrow('Shutdown failed.');
  await vi.waitFor(() => {
    expect(shutdown).toHaveBeenCalledOnce();
  });
  expect(stopRouter).toHaveBeenCalledOnce();
  expect(factory.signal.aborted).toBe(true);
  expect(finished).toBe(false);
  stopped.resolve();
  await rejected;
});

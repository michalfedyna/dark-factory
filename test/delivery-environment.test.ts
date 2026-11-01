import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalSandbox,
  ProcessHandle,
  Workspace,
  type CommandResult,
} from '@mastra/core/workspace';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { factoryConfigSchema } from '../src/config/schema.js';
import type { DeliveryRound } from '../src/contracts/delivery.js';
import type { DeliveryOptions } from '../src/delivery/context.js';
import { createDeliveryEnvironment } from '../src/delivery/environment.js';
import { createDeliveryRuntime } from '../src/delivery/runtime.js';
import {
  createRunRepository,
  readBase,
} from '../src/integrations/git/repository.js';
import { brief } from './fixtures/brief.js';
import { implementation, projectPlan } from './fixtures/delivery.js';

vi.mock('../src/integrations/git/repository.js');
const projectCommand = vi.hoisted(() =>
  vi.fn<NonNullable<LocalSandbox['executeCommand']>>(),
);
const sandboxInstances = vi.hoisted(() => [] as LocalSandbox[]);
vi.mock('@mastra/core/workspace', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@mastra/core/workspace')>();
  return {
    ...actual,
    LocalSandbox: class extends actual.LocalSandbox {
      constructor(...args: ConstructorParameters<typeof actual.LocalSandbox>) {
        super(...args);
        sandboxInstances.push(this);
      }
      override executeCommand = vi
        .fn<NonNullable<LocalSandbox['executeCommand']>>()
        .mockImplementation(projectCommand);
    },
  };
});
const environments: ReturnType<typeof createDeliveryEnvironment>[] = [];
const directories: string[] = [];
const webTarget = {
  id: 'web',
  kind: 'web' as const,
  url: 'http://localhost:3000',
  screenshots: true,
  start: { command: 'node', args: ['server.js'], timeoutMs: 1_000 },
};
const commandPassed: CommandResult = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  success: true,
  executionTimeMs: 0,
};

class QaServer extends ProcessHandle {
  readonly pid = 'qa-server';
  exitCode: number | undefined;
  kill = vi.fn(() => {
    this.exitCode = 0;
    return Promise.resolve(true);
  });
  sendStdin = vi.fn<ProcessHandle['sendStdin']>().mockResolvedValue();
}

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  if (!resolve) throw new Error('Promise did not initialize synchronously.');
  return { promise, resolve };
}
beforeEach(() => {
  sandboxInstances.length = 0;
  vi.spyOn(LocalSandbox, 'detectIsolation').mockReturnValue({
    available: true,
    backend: 'seatbelt',
    message: 'Test',
  });
  vi.mocked(readBase).mockResolvedValue('base');
  vi.mocked(createRunRepository).mockImplementation(
    async (_source, directory) => {
      const path = join(directory, 'repository');
      await mkdir(path);
      return {
        path,
        git: vi.fn().mockResolvedValue(''),
        capture: vi
          .fn()
          .mockResolvedValue({ revision: 'revision', tree: 'tree' }),
        assertUnchanged: vi.fn().mockResolvedValue(undefined),
      };
    },
  );
});
afterEach(async () => {
  await Promise.all(
    environments.splice(0).map((environment) => environment.close()),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup(project = projectPlan) {
  const source = await mkdtemp(join(tmpdir(), 'darkfactory-environment-'));
  directories.push(source);
  const controller = new AbortController();
  const options: DeliveryOptions = {
    repository: {
      repository: source,
      baseBranch: project.baseBranch,
      baseRevision: project.baseRevision,
      githubRepo: project.githubRepo,
    },
    model: factoryConfigSchema.parse({}).model,
    apiKey: 'private-key',
    runId: 'run',
    signal: controller.signal,
    progress: vi.fn(),
  };
  const environment = createDeliveryEnvironment(options);
  environments.push(environment);
  return {
    environment,
    options,
    controller,
    source,
    candidate: (round = 1, revision = 'revision'): DeliveryRound => ({
      round,
      revision,
      tree: 'tree',
      implementation: {
        ...implementation,
        verification: { checks: project.checks, targets: project.targets },
      },
      evidence: [],
      qa: null,
      review: null,
      findings: [],
    }),
  };
}

test('operations reject use before preparation and close is safe before setup', async () => {
  const { options } = await setup();
  const runtime = createDeliveryRuntime(options);
  expect(() => runtime.operations.capture(options.signal)).toThrow(
    'not been prepared',
  );
  await runtime.close();
  await runtime.close();
});

test('partial setup failure destroys every acquired resource and never exposes a ready run', async () => {
  const { environment, options } = await setup();
  vi.mocked(createRunRepository).mockImplementationOnce(
    async (_source, directory) => {
      const path = join(directory, 'repository');
      await mkdir(path);
      // Fail the later browser-config write after acquiring the live resources.
      await mkdir(join(directory, 'browser.json'));
      return { path, git: vi.fn(), capture: vi.fn(), assertUnchanged: vi.fn() };
    },
  );
  const destroySandbox = vi.spyOn(LocalSandbox.prototype, 'destroy');
  const destroyWorkspace = vi.spyOn(Workspace.prototype, 'destroy');
  await expect(environment.prepare(brief, options.signal)).rejects.toThrow(
    'directory',
  );
  expect(() => environment.requireRun()).toThrow('not been prepared');
  await environment.close();
  expect(sandboxInstances).toHaveLength(3);
  expect(destroySandbox.mock.contexts).toEqual(sandboxInstances.slice(1));
  // Mastra disposes a pending static sandbox without invoking its destroy hook.
  expect(sandboxInstances[0]?.status).toBe('destroyed');
  expect(destroyWorkspace).toHaveBeenCalledTimes(2);
});

test('closing during base validation prevents late setup from acquiring resources', async () => {
  const { environment, options } = await setup();
  const base = deferred<string>();
  vi.mocked(readBase).mockReturnValueOnce(base.promise);
  const preparing = environment.prepare(brief, options.signal);
  const rejected = expect(preparing).rejects.toThrow('closed');
  await environment.close();
  base.resolve('base');
  await rejected;
  expect(createRunRepository).not.toHaveBeenCalled();
});

test('preparation needs only Git metadata, not an existing executable app', async () => {
  const { environment, options, source } = await setup();
  await expect(environment.prepare(brief, options.signal)).resolves.toBe(
    'base',
  );
  expect(createRunRepository).toHaveBeenCalledWith(
    source,
    expect.any(String),
    'base',
    ['.'],
    expect.any(AbortSignal),
  );
  expect(sandboxInstances).toHaveLength(3);
  expect(projectCommand).not.toHaveBeenCalled();
  const run = environment.requireRun();
  expect(run.project.allowNetwork).toBe(true);
  expect(run.project).not.toHaveProperty('checks');
  expect(
    JSON.parse(
      await readFile(join(source, '.darkfactory/runs/run/input.json'), 'utf8'),
    ),
  ).toMatchObject({ brief, baseRevision: 'base' });
});

test('a moved base still blocks before acquiring mutable resources', async () => {
  const { environment, options } = await setup();
  vi.mocked(readBase).mockResolvedValueOnce('new-base');
  await expect(environment.prepare(brief, options.signal)).rejects.toThrow(
    'base branch changed',
  );
  expect(createRunRepository).not.toHaveBeenCalled();
  expect(sandboxInstances).toHaveLength(0);
});

test('native isolation is still required before implementation can run', async () => {
  const { environment, options } = await setup();
  vi.spyOn(LocalSandbox, 'detectIsolation').mockReturnValueOnce({
    available: false,
    backend: 'none',
    message: 'Unavailable',
  });
  await expect(environment.prepare(brief, options.signal)).rejects.toThrow(
    'Native sandbox isolation is unavailable',
  );
  expect(createRunRepository).not.toHaveBeenCalled();
});

test('each candidate owns its check commands and QA targets without changing an earlier round', async () => {
  const { environment, options, candidate } = await setup();
  await environment.prepare(brief, options.signal);
  const first = environment.beginRound(candidate());
  const repaired = candidate(2, 'repaired');
  repaired.implementation.verification = {
    checks: [
      { id: 'updated-test', command: 'npm', args: ['test'], timeoutMs: 1_000 },
    ],
    targets: [webTarget],
  };
  const second = environment.beginRound(repaired);
  expect(first.project.checks).toEqual(projectPlan.checks);
  expect(first.project.targets).toEqual([]);
  expect(second.project.checks[0]?.id).toBe('updated-test');
  expect(second.project.targets).toEqual([webTarget]);
  expect(() => environment.requireRound(candidate())).toThrow(
    'current candidate',
  );
});

test('cancellation during checkout creation cannot expose a late ready environment', async () => {
  const { environment, options, controller } = await setup();
  const started = deferred<void>();
  const checkout = deferred<Awaited<ReturnType<typeof createRunRepository>>>();
  vi.mocked(createRunRepository).mockImplementationOnce(() => {
    started.resolve();
    return checkout.promise;
  });
  const preparing = environment.prepare(brief, options.signal);
  const rejected = expect(preparing).rejects.toThrow('Cancelled');
  await started.promise;
  controller.abort(new Error('Cancelled'));
  await environment.close();
  checkout.resolve({
    path: 'unused',
    git: vi.fn(),
    capture: vi.fn(),
    assertUnchanged: vi.fn(),
  });
  await rejected;
  expect(() => environment.requireRun()).toThrow('closed');
});

test('round resources cannot be reused for another revision or repair round', async () => {
  const { environment, options, candidate } = await setup();
  await environment.prepare(brief, options.signal);
  expect(() => environment.requireRound(candidate())).toThrow(
    'Run checks first',
  );
  const first = environment.beginRound(candidate());
  expect(environment.requireRound(candidate())).toBe(first);
  expect(() => environment.requireRound(candidate(1, 'other'))).toThrow(
    'current candidate',
  );
  expect(() => environment.requireRound(candidate(2))).toThrow(
    'current candidate',
  );
  const second = environment.beginRound(candidate(2, 'repair'));
  expect(second.evidence.records).toEqual([]);
  expect(second.evidence.directory).not.toBe(first.evidence.directory);
  expect(() => environment.requireRound(candidate())).toThrow(
    'current candidate',
  );
});

test('QA failure closes automation with a fresh signal and stops servers exactly once', async () => {
  const { environment, options, controller, candidate } = await setup({
    ...projectPlan,
    targets: [webTarget, { ...webTarget, id: 'second' }],
  });
  await environment.prepare(brief, options.signal);
  const run = environment.requireRun();
  const session = environment.beginRound(candidate()).qaSession;
  const server = new QaServer();
  const spawn = vi
    .spyOn(run.projectSandbox.processes, 'spawn')
    .mockResolvedValueOnce(server)
    .mockRejectedValueOnce(new Error('Server failed'));
  const closeCommand = vi
    .spyOn(run.automationSandbox, 'executeCommand')
    .mockResolvedValue(commandPassed);
  const stop = vi.spyOn(run.projectSandbox, 'stop').mockResolvedValue();
  await expect(session.start(options.signal)).rejects.toThrow('Server failed');
  controller.abort();
  await session.close();
  const cleanupSignal = closeCommand.mock.calls[0]?.[2]?.abortSignal;
  expect(cleanupSignal).toBeInstanceOf(AbortSignal);
  expect(cleanupSignal?.aborted).toBe(false);
  expect(closeCommand.mock.calls[0]?.[1]).toEqual([
    '--config',
    run.browserConfig,
    '--session',
    'run-r1-web',
    'close',
  ]);
  await session.close();
  await environment.close();
  expect(spawn).toHaveBeenCalledTimes(2);
  expect(closeCommand).toHaveBeenCalledTimes(2);
  expect(stop).toHaveBeenCalledOnce();
});

test('a server returned after session closure is killed and cannot continue QA', async () => {
  const { environment, options, candidate } = await setup({
    ...projectPlan,
    targets: [webTarget],
  });
  await environment.prepare(brief, options.signal);
  const run = environment.requireRun();
  const session = environment.beginRound(candidate()).qaSession;
  const spawning = deferred<ProcessHandle>();
  vi.spyOn(run.projectSandbox.processes, 'spawn').mockReturnValue(
    spawning.promise,
  );
  vi.spyOn(run.projectSandbox, 'stop').mockResolvedValue();
  vi.spyOn(run.automationSandbox, 'executeCommand').mockResolvedValue(
    commandPassed,
  );
  const starting = session.start(options.signal);
  const rejected = expect(starting).rejects.toThrow('closed');
  await session.close();
  const server = new QaServer();
  spawning.resolve(server);
  await rejected;
  expect(server.kill).toHaveBeenCalledOnce();
  expect(() => session.assertRunning()).toThrow('not active');
});

test('QA cleanup failure still attempts every acquired environment resource', async () => {
  const { environment, options, candidate } = await setup({
    ...projectPlan,
    targets: [webTarget],
  });
  await environment.prepare(brief, options.signal);
  const run = environment.requireRun();
  const session = environment.beginRound(candidate()).qaSession;
  vi.spyOn(run.projectSandbox.processes, 'spawn').mockRejectedValue(
    new Error('Server failed'),
  );
  vi.spyOn(run.automationSandbox, 'executeCommand').mockRejectedValue(
    new Error('Tool unavailable'),
  );
  vi.spyOn(run.projectSandbox, 'stop').mockRejectedValue(
    new Error('Stop failed'),
  );
  const destroySandbox = vi.spyOn(LocalSandbox.prototype, 'destroy');
  const destroyWorkspace = vi.spyOn(Workspace.prototype, 'destroy');
  await expect(session.start(options.signal)).rejects.toThrow('Server failed');
  await expect(environment.close()).rejects.toThrow('Stop failed');
  expect(destroySandbox.mock.contexts).toEqual(
    expect.arrayContaining([run.projectSandbox, run.automationSandbox]),
  );
  expect(destroyWorkspace).toHaveBeenCalledTimes(2);
  // The rejected close promise is already asserted above.
  environments.splice(environments.indexOf(environment), 1);
});

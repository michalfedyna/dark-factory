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
import { projectPlan } from './fixtures/delivery.js';

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
    inspect: vi.fn().mockResolvedValue({ ...project, repository: source }),
    model: factoryConfigSchema.parse({}).model,
    apiKey: 'private-key',
    runId: 'run',
    signal: controller.signal,
    progress: vi.fn(),
    diagnostic: vi.fn(),
  };
  const environment = createDeliveryEnvironment(options);
  environments.push(environment);
  return { environment, options, controller, source };
}

function candidate(round = 1, revision = 'revision'): DeliveryRound {
  return {
    round,
    revision,
    tree: 'tree',
    implementation: { summary: 'Implemented.', blockers: [] },
    evidence: [],
    qa: null,
    review: null,
    findings: [],
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
  const { environment, options, source } = await setup({
    ...projectPlan,
    setup: [{ command: 'install', args: [], timeoutMs: 1_000 }],
  });
  projectCommand.mockResolvedValue({
    exitCode: 1,
    stdout: '',
    stderr: 'failed',
    success: false,
    executionTimeMs: 0,
  });
  const destroySandbox = vi.spyOn(LocalSandbox.prototype, 'destroy');
  const destroyWorkspace = vi.spyOn(Workspace.prototype, 'destroy');
  await expect(environment.prepare(brief, options.signal)).rejects.toThrow(
    'setup failed',
  );
  expect(() => environment.requireRun()).toThrow('not been prepared');
  await environment.close();
  expect(sandboxInstances).toHaveLength(3);
  expect(destroySandbox.mock.contexts).toEqual(sandboxInstances.slice(1));
  // Mastra disposes a pending static sandbox without invoking its destroy hook.
  expect(sandboxInstances[0]?.status).toBe('destroyed');
  expect(destroyWorkspace).toHaveBeenCalledTimes(2);
  expect(
    JSON.parse(
      await readFile(
        join(source, '.darkfactory/runs/run/setup-0.json'),
        'utf8',
      ),
    ),
  ).toMatchObject({ exitCode: 1 });
});

test('closing during inspection prevents late setup from acquiring resources', async () => {
  const { environment, options } = await setup();
  const inspection = deferred<typeof projectPlan>();
  options.inspect = () => inspection.promise;
  const preparing = environment.prepare(brief, options.signal);
  const rejected = expect(preparing).rejects.toThrow('closed');
  await environment.close();
  inspection.resolve(projectPlan);
  await rejected;
  expect(createRunRepository).not.toHaveBeenCalled();
});

test('inspection blockers stop before mutable resources without asking the user', async () => {
  const { environment, options, source } = await setup();
  options.inspect = () =>
    Promise.resolve({ blockers: ['Missing native app identifier.'] });
  await expect(environment.prepare(brief, options.signal)).rejects.toThrow(
    'Repository inspection blocked',
  );
  expect(options.diagnostic).toHaveBeenCalledWith(
    'Repository inspection blocked: Missing native app identifier.',
  );
  expect(options.progress).toHaveBeenCalledExactlyOnceWith(
    'Inspecting repository',
  );
  expect(createRunRepository).not.toHaveBeenCalled();
  expect(sandboxInstances).toHaveLength(0);
  await expect(
    readFile(join(source, '.darkfactory/runs/run/input.json')),
  ).rejects.toThrow();
});

test('cancellation during dependency setup cannot expose a late ready environment', async () => {
  const { environment, options, controller } = await setup({
    ...projectPlan,
    setup: [{ command: 'install', args: [], timeoutMs: 1_000 }],
  });
  const started = deferred<void>();
  const command = deferred<CommandResult>();
  projectCommand.mockImplementation(() => {
    started.resolve();
    return command.promise;
  });
  const preparing = environment.prepare(brief, options.signal);
  const rejected = expect(preparing).rejects.toThrow('Cancelled');
  await started.promise;
  controller.abort(new Error('Cancelled'));
  await environment.close();
  command.resolve(commandPassed);
  await rejected;
  expect(() => environment.requireRun()).toThrow('closed');
});

test('round resources cannot be reused for another revision or repair round', async () => {
  const { environment, options } = await setup();
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
  const { environment, options, controller } = await setup({
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
  const { environment, options } = await setup({
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
  const { environment, options } = await setup({
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

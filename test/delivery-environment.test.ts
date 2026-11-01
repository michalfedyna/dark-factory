import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
  LocalSandbox,
  ProcessHandle,
  Workspace,
  type CommandResult,
} from '@mastra/core/workspace';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { factoryConfigSchema } from '../src/config/schema.js';
import { createSandboxQa } from '../src/agents/sandbox-qa.js';
import { createFigma } from '../src/agents/figma.js';
import { createReview } from '../src/agents/review.js';
import { qaSchema, type DeliveryRound } from '../src/contracts/delivery.js';
import { createDeliveryAgents } from '../src/delivery/agent-sessions.js';
import type { DeliveryOptions } from '../src/delivery/context.js';
import { createDeliveryEnvironment } from '../src/delivery/environment.js';
import { createDeliveryRuntime } from '../src/delivery/runtime.js';
import { QaTargetFailure } from '../src/delivery/qa-session.js';
import {
  createRunRepository,
  readBase,
} from '../src/integrations/git/repository.js';
import { brief } from './fixtures/brief.js';
import {
  candidateState,
  implementation,
  projectPlan,
} from './fixtures/delivery.js';
import { qaPass, reviewPass } from './fixtures/workflow.js';
import { figmaResult, figmaSource } from './fixtures/figma.js';

vi.mock('../src/integrations/git/repository.js');
vi.mock('../src/agents/sandbox-qa.js');
vi.mock('../src/agents/review.js');
vi.mock('../src/agents/figma.js');
const projectCommand = vi.hoisted(() =>
  vi.fn<NonNullable<LocalSandbox['executeCommand']>>(),
);
const sandboxInstances = vi.hoisted(() => [] as LocalSandbox[]);
const sandboxSettings = vi.hoisted(
  () => [] as ConstructorParameters<typeof LocalSandbox>[0][],
);
vi.mock('@mastra/core/workspace', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@mastra/core/workspace')>();
  return {
    ...actual,
    LocalSandbox: class extends actual.LocalSandbox {
      constructor(...args: ConstructorParameters<typeof actual.LocalSandbox>) {
        super(...args);
        sandboxInstances.push(this);
        sandboxSettings.push(args[0]);
      }
      override executeCommand = vi
        .fn<NonNullable<LocalSandbox['executeCommand']>>()
        .mockImplementation(projectCommand);
    },
  };
});
const environments: ReturnType<typeof createDeliveryEnvironment>[] = [];
const directories: string[] = [];
const nativeIsolation = z
  .object({
    available: z.boolean(),
    backend: z.enum(['none', 'seatbelt', 'bwrap']),
  })
  .parse(LocalSandbox.detectIsolation());
const webTarget = {
  id: 'web',
  kind: 'web' as const,
  url: 'http://localhost:3000',
  screenshots: true,
  start: { command: 'node', args: ['server.js'] },
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
  sandboxSettings.length = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(new Response(null, { status: 200 })),
  );
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
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await Promise.all(
    environments.splice(0).map((environment) => environment.close()),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup(
  project = projectPlan,
  sandbox = factoryConfigSchema.parse({}).sandbox,
) {
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
    sandbox,
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

test('all project roles receive explicit toolchain paths without inheriting host credentials or HOME', async () => {
  vi.stubEnv('JAVA_HOME', '/test/jdk');
  vi.stubEnv('ANDROID_HOME', '/test/sdk');
  vi.stubEnv('DEVELOPER_DIR', '/test/Xcode/Developer');
  vi.stubEnv('DARKFACTORY_API_KEY', 'host-secret');
  const { environment, options, candidate } = await setup();
  await environment.prepare(brief, options.signal);
  environment.createFigmaWorkspace();
  environment.beginRound(candidate());
  for (const settings of sandboxSettings) {
    expect(settings?.env).toMatchObject({
      JAVA_HOME: '/test/jdk',
      ANDROID_HOME: '/test/sdk',
      DEVELOPER_DIR: '/test/Xcode/Developer',
    });
    expect(settings?.env).not.toHaveProperty('DARKFACTORY_API_KEY');
  }
  const run = environment.requireRun();
  expect(run.projectSandboxOptions?.env?.HOME).toBe(
    join(run.directory, 'home'),
  );
  const automationSettings =
    sandboxSettings[sandboxInstances.indexOf(run.automationSandbox)];
  const hostPaths = process.env.PATH?.split(delimiter) ?? [];
  expect(
    automationSettings?.env?.PATH?.split(delimiter).slice(0, hostPaths.length),
  ).toEqual(hostPaths);
  expect(run.projectSandboxOptions?.nativeSandbox?.readOnlyPaths).toEqual([
    '/test/sdk',
    '/test/jdk',
    '/test/Xcode/Developer',
  ]);
});

test('private failure journals retain partial check evidence and redact configured credentials', async () => {
  const { environment, options, candidate } = await setup();
  options.apiKey = 'private-"key\\';
  options.figmaToken = 'private-figma-token';
  await environment.prepare(brief, options.signal);
  const resources = environment.beginRound(candidate());
  const record = await resources.evidence.record(
    {
      kind: 'check',
      targetId: null,
      operation: 'prepare-ios',
      exitCode: 1,
    },
    { stderr: 'Missing simulator' },
  );
  const error = new Error(`Provider rejected ${options.apiKey}`, {
    cause: new Error('Token private-figma-token'),
  });
  const path = await environment.recordFailure(
    'run-checks',
    candidateState(),
    error,
  );
  const content = await readFile(path, 'utf8');
  expect(JSON.parse(content)).toMatchObject({
    step: 'run-checks',
    round: 1,
    revision: 'revision',
    evidence: [record],
    error: {
      message: 'Provider rejected [redacted]',
      cause: { message: 'Token [redacted]' },
    },
  });
  expect(content).not.toContain('private-');
  expect(content).not.toContain('private-figma-token');
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
  expect(sandboxInstances).toHaveLength(4);
  expect(destroySandbox.mock.contexts).toEqual(sandboxInstances.slice(1, 3));
  // Mastra disposes a pending static sandbox without invoking its destroy hook.
  expect(sandboxInstances[0]?.status).toBe('destroyed');
  expect(sandboxInstances[3]?.status).toBe('destroyed');
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
  expect(sandboxInstances).toHaveLength(4);
  expect(projectCommand).not.toHaveBeenCalled();
  const run = environment.requireRun();
  expect(run.project.allowNetwork).toBe(true);
  expect(sandboxSettings.map((settings) => settings?.timeout)).toEqual([
    0, 0, 0, 0,
  ]);
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

test('host execution does not require or detect a native isolation backend', async () => {
  const { environment, options } = await setup();
  const detection = vi.spyOn(LocalSandbox, 'detectIsolation').mockReturnValue({
    available: false,
    backend: 'none',
    message: 'Unavailable',
  });
  await environment.prepare(brief, options.signal);
  expect(detection).not.toHaveBeenCalled();
  const run = environment.requireRun();
  expect(run.implementationSandbox.isolation).toBe('none');
  expect(run.reviewWorkspace.sandbox).toMatchObject({ isolation: 'none' });
  expect(run.projectSandbox.isolation).toBe('none');
  expect(
    JSON.parse(await readFile(join(run.directory, 'input.json'), 'utf8')),
  ).toMatchObject({ sandbox: { isolation: 'none' } });
});

test.skipIf(!nativeIsolation.available)(
  'native isolation is applied to implementation, review, and project commands when requested',
  async () => {
    const { backend } = nativeIsolation;
    const { environment, options, candidate } = await setup(projectPlan, {
      isolation: 'native',
    });
    vi.spyOn(LocalSandbox, 'detectIsolation').mockReturnValue({
      available: true,
      backend,
      message: 'Available',
    });
    await environment.prepare(brief, options.signal);
    const run = environment.requireRun();
    expect(run.implementationSandbox.isolation).toBe(backend);
    expect(run.reviewWorkspace.sandbox).toMatchObject({ isolation: backend });
    expect(run.projectSandbox.isolation).toBe(backend);
    expect(
      environment.beginRound(candidate()).sandboxQaWorkspace.sandbox,
    ).toMatchObject({ isolation: backend });
    expect(
      JSON.parse(await readFile(join(run.directory, 'input.json'), 'utf8')),
    ).toMatchObject({ sandbox: { isolation: 'native' } });
  },
);

test('review has its own full workspace and current evidence access', async () => {
  const { environment, options, candidate } = await setup();
  await environment.prepare(brief, options.signal);
  const round = environment.beginRound(candidate());
  const run = environment.requireRun();
  expect(run.reviewWorkspace).not.toBe(run.implementationWorkspace);
  expect(run.reviewWorkspace.filesystem).toBe(run.reviewFiles);
  expect(run.reviewWorkspace.sandbox).toBeInstanceOf(LocalSandbox);
  expect(run.reviewWorkspace.sandbox).not.toBe(run.implementationSandbox);
  expect(run.reviewWorkspace.sandbox).not.toBe(run.projectSandbox);
  expect(run.reviewWorkspace.sandbox).not.toBe(
    round.sandboxQaWorkspace.sandbox,
  );
  expect(run.reviewFiles.readOnly).not.toBe(true);
  await run.reviewFiles.writeFile('review-probe.txt', 'probe');
  expect(
    await readFile(join(run.repository.path, 'review-probe.txt'), 'utf8'),
  ).toBe('probe');
  const evidence = await round.evidence.record(
    {
      kind: 'check',
      targetId: null,
      operation: 'test',
      exitCode: 0,
    },
    'Current evidence.',
  );
  expect(
    await run.reviewFiles.readFile(evidence.path, { encoding: 'utf8' }),
  ).toContain('Current evidence.');
  const next = environment.beginRound(candidate(2, 'repair'));
  expect(run.reviewFiles.allowedPaths).toEqual([next.evidence.directory]);
  await expect(run.reviewFiles.readFile(evidence.path)).rejects.toThrow();
});

test.each(['pass', 'error', 'cancel', 'patch-error'] as const)(
  'review stops its own workspace after %s and preserves the run execution policy',
  async (outcome) => {
    const { environment, options, controller } = await setup();
    await environment.prepare(brief, options.signal);
    const run = environment.requireRun();
    const state = candidateState();
    state.history[0]!.qa = qaSchema.parse(qaPass);
    const result = { ...reviewPass, verdict: 'pass' as const };
    const generate = vi
      .fn<ReturnType<typeof createReview>>()
      .mockImplementation((input) => {
        expect(input.workspace).toBe(run.reviewWorkspace);
        expect(input.context.verification).toEqual(
          state.history[0]!.implementation.verification,
        );
        expect(input.signal).toBe(options.signal);
        if (outcome === 'cancel') {
          controller.abort(new Error('Cancelled'));
          return Promise.reject(new Error('Cancelled'));
        }
        return outcome === 'error'
          ? Promise.reject(new Error('Provider failed'))
          : Promise.resolve(result);
      });
    vi.mocked(createReview).mockReturnValueOnce(generate);
    if (outcome === 'patch-error')
      vi.mocked(run.repository.git).mockRejectedValueOnce(
        new Error('Diff failed'),
      );
    const stop = vi.spyOn(run.reviewWorkspace, 'stop');
    const agents = createDeliveryAgents(options);
    const pending = agents.review(run, state, options.signal);
    if (outcome === 'pass') await expect(pending).resolves.toEqual(result);
    else
      await expect(pending).rejects.toThrow(
        outcome === 'cancel'
          ? 'Cancelled'
          : outcome === 'patch-error'
            ? 'Diff failed'
            : 'Provider failed',
      );
    expect(stop).toHaveBeenCalledOnce();
    const settings =
      sandboxSettings[
        sandboxInstances.indexOf(run.reviewWorkspace.sandbox as LocalSandbox)
      ];
    expect(settings).toEqual(run.projectSandboxOptions);
    expect(settings?.env).not.toHaveProperty('DARKFACTORY_API_KEY');
  },
);

test('requested native isolation fails closed when unavailable', async () => {
  const { environment, options } = await setup(projectPlan, {
    isolation: 'native',
  });
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
    checks: [{ id: 'updated-test', command: 'npm', args: ['test'] }],
    targets: [webTarget],
  };
  const second = environment.beginRound(repaired);
  expect(first.project.checks).toEqual(projectPlan.checks);
  expect(first.project.targets).toEqual([]);
  expect(second.project.checks[0]?.id).toBe('updated-test');
  expect(second.project.targets).toEqual([webTarget]);
  expect(second.sandboxQaWorkspace).not.toBe(first.sandboxQaWorkspace);
  expect(second.sandboxQaWorkspace.sandbox).not.toBe(
    first.sandboxQaWorkspace.sandbox,
  );
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
  await expect(session.start(options.signal)).rejects.toThrow(
    'QA server second failed',
  );
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
  await expect(session.assertRunning()).rejects.toThrow('not active');
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
  await expect(session.start(options.signal)).rejects.toThrow(
    'QA server web failed',
  );
  await expect(environment.close()).rejects.toThrow('Stop failed');
  expect(destroySandbox.mock.contexts).toEqual(
    expect.arrayContaining([run.projectSandbox, run.automationSandbox]),
  );
  expect(destroyWorkspace).toHaveBeenCalledTimes(3);
  // The rejected close promise is already asserted above.
  environments.splice(environments.indexOf(environment), 1);
});

async function setupQaServer() {
  const setupResult = await setup({ ...projectPlan, targets: [webTarget] });
  const { environment, options, candidate } = setupResult;
  await environment.prepare(brief, options.signal);
  const run = environment.requireRun();
  const resources = environment.beginRound(candidate());
  const server = new QaServer();
  const spawn = vi
    .spyOn(run.projectSandbox.processes, 'spawn')
    .mockResolvedValue(server);
  vi.spyOn(run.projectSandbox, 'stop').mockResolvedValue();
  vi.spyOn(run.automationSandbox, 'executeCommand').mockResolvedValue(
    commandPassed,
  );
  return { ...setupResult, ...resources, server, spawn };
}

test('web QA waits through refused connections and unavailable responses before starting', async () => {
  const { qaSession, options, spawn } = await setupQaServer();
  vi.mocked(fetch)
    .mockRejectedValueOnce(new TypeError('Connection refused'))
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
  await qaSession.start(options.signal);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(webTarget.url);
  const request = vi.mocked(fetch).mock.calls[0]?.[1];
  expect(request?.redirect).toBe('manual');
  expect(request?.signal).toBeInstanceOf(AbortSignal);
  expect(spawn).toHaveBeenCalledOnce();
  await expect(qaSession.assertRunning()).resolves.toBeUndefined();
});

test.each([0, 1])(
  'an exited QA server retains its command and output as failed revision-bound evidence (exit %s)',
  async (exitCode) => {
    const { qaSession, options, evidence, server } = await setupQaServer();
    server.exitCode = exitCode;
    server.emitStdout('Ready\n');
    server.emitStderr('unable to start FSEvent stream\n');
    await expect(qaSession.start(options.signal)).rejects.toBeInstanceOf(
      QaTargetFailure,
    );
    expect(fetch).not.toHaveBeenCalled();
    const record = evidence.records[0]!;
    expect(record).toMatchObject({
      kind: 'check',
      targetId: 'web',
      operation: 'qa-server-web',
      exitCode: 1,
      revision: 'revision',
    });
    expect(JSON.parse(await readFile(record.path, 'utf8'))).toMatchObject({
      output: {
        start: webTarget.start,
        exitCode,
        stdout: 'Ready\n',
        stderr: 'unable to start FSEvent stream\n',
      },
    });
  },
);

test('QA readiness waits without an overall startup deadline', async () => {
  const { qaSession, options, evidence } = await setupQaServer();
  vi.useFakeTimers();
  const response = deferred<Response>();
  vi.mocked(fetch).mockReturnValue(response.promise);
  let completed = false;
  const starting = qaSession.start(options.signal).then(() => {
    completed = true;
  });
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(completed).toBe(false);
  expect(evidence.records).toEqual([]);
  response.resolve(new Response(null, { status: 200 }));
  await starting;
  await expect(qaSession.assertRunning()).resolves.toBeUndefined();
});

test('cancellation during readiness is not reported as a repairable server defect', async () => {
  const { qaSession, options, controller, evidence } = await setupQaServer();
  const requested = deferred<void>();
  vi.mocked(fetch).mockImplementation(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        requested.resolve();
        init?.signal?.addEventListener(
          'abort',
          () => reject(new Error('Readiness request aborted')),
          { once: true },
        );
      }),
  );
  const starting = qaSession.start(options.signal);
  const rejected = expect(starting).rejects.toThrow('Stopped by user');
  await requested.promise;
  controller.abort(new Error('Stopped by user'));
  await rejected;
  expect(evidence.records).toEqual([]);
});

test('a server that exits during QA invalidates verification and retains its crash output', async () => {
  const { qaSession, options, server, evidence } = await setupQaServer();
  await qaSession.start(options.signal);
  server.emitStderr('Server crashed during verification');
  server.exitCode = 1;
  await expect(qaSession.assertRunning()).rejects.toBeInstanceOf(
    QaTargetFailure,
  );
  expect(await readFile(evidence.records[0]!.path, 'utf8')).toContain(
    'Server crashed during verification',
  );
});

test.each(['pass', 'error', 'cancel'] as const)(
  'sandbox QA stops its own workspace after %s and preserves the run execution policy',
  async (outcome) => {
    const { environment, options, candidate, controller } = await setup();
    await environment.prepare(brief, options.signal);
    const resources = environment.beginRound(candidate());
    const run = environment.requireRun();
    const state = candidateState();
    state.history[0]!.qa = qaSchema.parse({
      verdict: 'blocked',
      criteria: [
        {
          id: 'AC1',
          status: 'blocked',
          evidenceIds: [],
          notes: 'Needs shell.',
        },
      ],
      findings: [],
    });
    const result = qaSchema.parse({
      verdict: 'blocked',
      criteria: [
        {
          id: 'AC1',
          status: 'blocked',
          evidenceIds: [],
          notes: 'Still blocked.',
        },
      ],
      findings: [],
    });
    const generate = vi
      .fn<ReturnType<typeof createSandboxQa>>()
      .mockImplementation((input) => {
        expect(input.workspace).toBe(resources.sandboxQaWorkspace);
        expect(input.context.acceptanceCriteria).toEqual(
          brief.acceptanceCriteria,
        );
        expect(input.evidenceTool.id).toBe('qa_evidence');
        if (outcome === 'cancel') {
          controller.abort(new Error('Cancelled'));
          return Promise.reject(new Error('Cancelled'));
        }
        return outcome === 'error'
          ? Promise.reject(new Error('Provider failed'))
          : Promise.resolve(result);
      });
    vi.mocked(createSandboxQa).mockReturnValueOnce(generate);
    const stop = vi.spyOn(resources.sandboxQaWorkspace, 'stop');
    const agents = createDeliveryAgents(options);
    const pending = agents.sandboxQa(resources, state, options.signal);
    if (outcome === 'pass') await expect(pending).resolves.toEqual(result);
    else
      await expect(pending).rejects.toThrow(
        outcome === 'cancel' ? 'Cancelled' : 'Provider failed',
      );
    expect(stop).toHaveBeenCalledOnce();
    expect(resources.sandboxQaWorkspace.sandbox).not.toBe(
      run.implementationSandbox,
    );
    expect(resources.sandboxQaWorkspace.sandbox?.id).not.toBe(
      run.projectSandbox.id,
    );
    expect(sandboxSettings.at(-1)).toEqual(run.projectSandboxOptions);
    expect(sandboxSettings.at(-1)?.env).not.toHaveProperty(
      'DARKFACTORY_API_KEY',
    );
  },
);

test.each(['pass', 'unread', 'error', 'cancel', 'missing-token'] as const)(
  'Figma owns a separate workspace in the implementation checkout and stops it after %s',
  async (outcome) => {
    const { environment, options, controller } = await setup();
    options.figma = { tokenEnv: 'FIGMA_TEST_TOKEN', auth: 'personal' };
    if (outcome !== 'missing-token') options.figmaToken = 'private-figma-token';
    await environment.prepare(brief, options.signal);
    const run = environment.requireRun();
    const workspace = environment.createFigmaWorkspace();
    const stop = vi.spyOn(workspace, 'stop');
    const state = {
      ...candidateState(),
      round: 0,
      history: [],
      figma: { sources: [figmaSource], result: null },
    };
    const generate = vi
      .fn<ReturnType<typeof createFigma>>()
      .mockImplementation(async (input) => {
        expect(input.workspace).toBe(workspace);
        expect(input.context.sources).toEqual([figmaSource]);
        expect(input.tools).not.toHaveProperty('ask');
        expect(JSON.stringify(input.context)).not.toContain(
          'private-figma-token',
        );
        if (outcome === 'error') throw new Error('Provider failed');
        if (outcome === 'cancel') {
          controller.abort(new Error('Cancelled'));
          return figmaResult;
        }
        if (outcome !== 'unread') {
          vi.mocked(fetch).mockResolvedValueOnce(
            Response.json({ nodes: { '1:2': { document: { id: '1:2' } } } }),
          );
          await input.tools.figma.execute!(
            {
              source: figmaSource.url,
              operation: 'nodes',
              nodeIds: ['1:2'],
              format: 'png',
            },
            {},
          );
        }
        await input.workspace.filesystem!.writeFile(
          'ui-scaffold.tsx',
          'export const Panel = () => null;',
        );
        return figmaResult;
      });
    vi.mocked(createFigma).mockReturnValueOnce(generate);
    const agents = createDeliveryAgents(options);
    const pending = agents.figma(run, state, workspace, options.signal);
    if (outcome === 'error' || outcome === 'cancel')
      await expect(pending).rejects.toThrow(
        outcome === 'error' ? 'Provider failed' : 'Cancelled',
      );
    else {
      const result = await pending;
      if (outcome === 'missing-token') {
        expect(result.blockers[0]).toContain('Set FIGMA_TEST_TOKEN');
        expect(generate).not.toHaveBeenCalled();
      } else if (outcome === 'unread')
        expect(result.blockers[0]).toContain('was not inspected');
      else {
        expect(result).toEqual(figmaResult);
        expect(
          (
            await run.implementationWorkspace.filesystem!.readFile(
              'ui-scaffold.tsx',
            )
          ).toString(),
        ).toBe('export const Panel = () => null;');
      }
    }
    expect(stop).toHaveBeenCalledOnce();
    expect(workspace).not.toBe(run.implementationWorkspace);
    expect(workspace.sandbox).not.toBe(run.implementationSandbox);
    expect(sandboxSettings.at(-1)).toEqual(run.projectSandboxOptions);
    expect(sandboxSettings.at(-1)?.env).not.toHaveProperty('FIGMA_TEST_TOKEN');
    expect(sandboxSettings.at(-1)?.env).not.toHaveProperty(
      'private-figma-token',
    );
    await environment.close();
    expect(workspace.status).toBe('destroyed');
  },
);

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  LocalFilesystem,
  LocalSandbox,
  Workspace,
} from '@mastra/core/workspace';
import { z } from 'zod';
import { createImplementation } from '../agents/implementation.js';
import { createQa } from '../agents/qa.js';
import { createReview } from '../agents/review.js';
import { createSummary } from '../agents/summary.js';
import type { FactoryConfig } from '../config/schema.js';
import { projectSchema, type Project } from '../contracts/project.js';
import type { IssueBrief } from '../contracts/issue.js';
import {
  deliveryResultSchema,
  type DeliveryRound,
  type DeliveryState,
} from '../contracts/delivery.js';
import type { Ask } from '../contracts/interaction.js';
import type { Observe } from '../contracts/progress.js';
import {
  createRunRepository,
  readBase,
  type RunRepository,
} from '../integrations/git/repository.js';
import {
  publishPullRequest,
  renderPullRequest,
} from '../integrations/github/publish.js';
import {
  createEvidence,
  type EvidenceRecorder,
} from '../integrations/qa/evidence.js';
import { validateQa } from '../integrations/qa/gate.js';
import { createQaTools } from '../tools/qa.js';
import type { DeliveryOperations } from '../workflows/default.js';

export function createDeliveryRuntime(options: {
  inspect: (brief: IssueBrief, signal: AbortSignal) => Promise<Project>;
  model: FactoryConfig['model'];
  apiKey: string;
  runId: string;
  ask: Ask;
  signal: AbortSignal;
  progress: (message: string) => void;
  observe?: Observe;
}) {
  const { runId, ask, progress } = options;
  let config: Project;
  let directory: string;
  const implement = createImplementation(options.model, options.apiKey);
  const qa = createQa(options.model, options.apiKey);
  const review = createReview(options.model, options.apiKey);
  const summarize = createSummary(options.model, options.apiKey);
  let repository: RunRepository;
  let implementation: Workspace;
  let reader: Workspace;
  let readOnlyFiles: LocalFilesystem;
  let commands: LocalSandbox;
  let automation: LocalSandbox;
  let evidence: EvidenceRecorder;
  let browserConfig: string;
  let qaRound = 0;
  const workspaces: Workspace[] = [];
  const sandboxes: LocalSandbox[] = [];
  const checkLogs = async (state: DeliveryState) => {
    const records =
      state.history
        .at(-1)
        ?.evidence.filter((record) => record.kind === 'check') ?? [];
    return Promise.all(
      records.map(async (record) => ({
        evidenceId: record.id,
        excerpt: (await readFile(record.path, 'utf8')).slice(-12_000),
      })),
    );
  };
  const approval = async (
    question: string,
    context: string,
    accept: string,
    decline: string,
    signal: AbortSignal,
  ) => {
    const answer = await ask(
      { question, context, options: [accept, decline] },
      signal,
    );
    signal.throwIfAborted();
    return answer === accept;
  };
  const projectCommand = async (
    command: Project['checks'][number] | Project['setup'][number],
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const result = await commands.executeCommand!(
      command.command,
      command.args,
      { timeout: command.timeoutMs, abortSignal: signal },
    );
    signal.throwIfAborted();
    return result;
  };
  const stopQa = async () => {
    if (!automation || !qaRound) return;
    // Cleanup gets its own short deadline even after the run is cancelled.
    const signal = AbortSignal.timeout(10_000);
    await Promise.allSettled(
      config.targets.map(async (target) => {
        const session = `${runId}-r${qaRound}-${target.id}`;
        await automation.executeCommand!(
          target.kind === 'web' ? config.browserCommand : config.deviceCommand,
          target.kind === 'web'
            ? ['--config', browserConfig, '--session', session, 'close']
            : ['close', '--session', session, '--platform', target.platform],
          { timeout: 8_000, abortSignal: signal },
        );
      }),
    );
    qaRound = 0;
    await commands.stop();
  };
  const operations: DeliveryOperations = {
    maxRepairRounds: 3,
    prepare: async (brief, signal) => {
      progress('Inspecting repository');
      config = projectSchema.parse(await options.inspect(brief, signal));
      signal.throwIfAborted();
      const source = config.repository;
      directory = join(source, '.darkfactory', 'runs', runId);
      const base = await readBase(source, config.baseBranch, signal);
      if (base !== config.baseRevision)
        throw new Error(
          'The base branch changed during inspection. Start a new run.',
        );
      const detection = z
        .object({
          available: z.boolean(),
          backend: z.enum(['none', 'seatbelt', 'bwrap']),
        })
        .parse(LocalSandbox.detectIsolation());
      if (!detection.available || detection.backend === 'none')
        throw new Error(
          'Native sandbox isolation is unavailable. Install Seatbelt or Bubblewrap before running project commands.',
        );
      const accepted = await approval(
        'Implement this brief?',
        JSON.stringify(
          {
            brief,
            repository: source,
            baseRevision: base,
            project: config,
            isolation: detection.backend,
            maxRepairRounds: operations.maxRepairRounds,
            warning:
              'Project commands and browser/device automation run on this host. Use only trusted repositories and test accounts. Local sandboxing is not a complete security boundary. Your original checkout is not edited. Publication requires a separate approval.',
          },
          null,
          2,
        ),
        'Implement',
        'Stop',
        signal,
      );
      if (!accepted) throw new Error('Implementation was not approved.');
      await mkdir(join(source, '.darkfactory', 'runs'), {
        recursive: true,
        mode: 0o700,
      });
      await mkdir(directory, { mode: 0o700 });
      await writeFile(
        join(directory, 'input.json'),
        JSON.stringify(
          {
            runId,
            brief,
            config,
            model: options.model,
            baseRevision: base,
            implementationApproved: true,
          },
          null,
          2,
        ),
        { mode: 0o600, flag: 'wx' },
      );
      repository = await createRunRepository(
        source,
        directory,
        base,
        config.allowedPaths,
        signal,
      );
      const home = join(directory, 'home');
      await mkdir(home, { mode: 0o700 });
      const sandbox = () =>
        new LocalSandbox({
          workingDirectory: repository.path,
          isolation: detection.backend,
          env: { HOME: home, CI: '1' },
          nativeSandbox: {
            allowNetwork: config.allowNetwork,
            readWritePaths: [home],
          },
        });
      const implementationSandbox = sandbox();
      commands = sandbox();
      automation = new LocalSandbox({
        workingDirectory: join(directory, 'qa'),
        env: {
          HOME: process.env.HOME,
          AGENT_DEVICE_STATE_DIR: join(directory, 'device-state'),
        },
      });
      sandboxes.push(commands, automation);
      implementation = new Workspace({
        filesystem: new LocalFilesystem({ basePath: repository.path }),
        sandbox: implementationSandbox,
      });
      readOnlyFiles = new LocalFilesystem({
        basePath: repository.path,
        readOnly: true,
      });
      reader = new Workspace({ filesystem: readOnlyFiles });
      workspaces.push(implementation, reader);
      browserConfig = join(directory, 'browser.json');
      await writeFile(browserConfig, '{}', { mode: 0o600 });
      for (const setup of config.setup) {
        progress('Preparing dependencies');
        const result = await projectCommand(setup, signal);
        await writeFile(
          join(directory, `setup-${config.setup.indexOf(setup)}.json`),
          JSON.stringify(result, null, 2),
          { mode: 0o600 },
        );
        if (result.exitCode !== 0)
          throw new Error(`Repository setup failed. See ${directory}.`);
      }
      return base;
    },
    implement: async (state, signal) => {
      progress(`Implementing (round ${state.round + 1})`);
      try {
        return await implement({
          state,
          context: {
            repository: repository.path,
            allowedPaths: config.allowedPaths,
            checks: config.checks,
            checkLogs: await checkLogs(state),
          },
          workspace: implementation,
          signal,
          ...(options.observe ? { observe: options.observe } : {}),
        });
      } finally {
        await implementation.sandbox!.stop?.();
      }
    },
    capture: (signal) => repository.capture(signal),
    checks: async (round, signal) => {
      progress('Running checks');
      evidence = createEvidence(
        join(directory, `round-${round.round}`),
        round.revision,
        round.round,
      );
      readOnlyFiles.setAllowedPaths([evidence.directory]);
      for (const check of [
        ...config.checks,
        ...config.targets.flatMap((target) =>
          target.kind === 'mobile'
            ? [{ ...target.prepare, id: `prepare-${target.id}` }]
            : [],
        ),
      ]) {
        options.observe?.({ kind: 'check', id: check.id, status: 'started' });
        const result = await projectCommand(check, signal);
        options.observe?.({
          kind: 'check',
          id: check.id,
          status: result.exitCode === 0 ? 'passed' : 'failed',
        });
        const record = await evidence.record(
          {
            kind: 'check',
            targetId: null,
            operation: check.id,
            exitCode: result.exitCode,
          },
          { check, ...result },
        );
        if (result.exitCode !== 0)
          round.findings.push({
            source: 'checks',
            kind: 'defect',
            severity: 'blocking',
            description: `Check ${check.id} failed. See ${record.path}.`,
            criterionId: null,
            evidenceIds: [record.id],
          });
      }
      await repository.assertUnchanged(round.revision, signal);
      return { ...round, evidence: [...evidence.records] };
    },
    qa: async (state, signal) => {
      progress('Verifying acceptance criteria');
      qaRound = state.round;
      const servers: Awaited<ReturnType<typeof commands.processes.spawn>>[] =
        [];
      try {
        for (const target of config.targets) {
          if (target.start) {
            const line = [target.start.command, ...target.start.args]
              .map((value) => `'${value.replace(/'/g, `'\\''`)}'`)
              .join(' ');
            servers.push(
              await commands.processes.spawn(line, {
                abortSignal: signal,
                stdinMode: 'ignore',
              }),
            );
          }
        }
        const tools = createQaTools({
          config,
          sandbox: automation,
          evidence,
          session: `${runId}-r${state.round}`,
          browserConfig,
          signal,
        });
        const report = await qa({
          state,
          context: {
            targets: config.targets,
            evidence: evidence.records,
            checkLogs: await checkLogs(state),
          },
          workspace: reader,
          tools,
          signal,
          ...(options.observe ? { observe: options.observe } : {}),
        });
        if (servers.some((process) => process.exitCode !== undefined))
          throw new Error(
            'A configured QA server exited. Verification cannot be trusted.',
          );
        return report;
      } finally {
        await stopQa();
      }
    },
    validateQa: (state) => {
      const round: DeliveryRound = {
        ...state.history.at(-1)!,
        evidence: [...evidence.records],
      };
      return Promise.resolve(validateQa(state.brief, round, config.targets));
    },
    review: async (state, signal) => {
      progress('Reviewing code');
      const patch = await repository.git(
        [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          state.baseRevision,
          state.history.at(-1)!.revision,
        ],
        signal,
      );
      if (patch.length > 160_000)
        throw new Error(
          'Patch is too large for the initial review workflow. Split the issue.',
        );
      return review({
        state,
        context: { patch },
        workspace: reader,
        signal,
        ...(options.observe ? { observe: options.observe } : {}),
      });
    },
    assertUnchanged: (revision, signal) =>
      repository.assertUnchanged(revision, signal),
    summarize: (state, signal) => {
      progress('Writing PR summary');
      return summarize({
        state,
        context: { targets: config.targets },
        signal,
        ...(options.observe ? { observe: options.observe } : {}),
      });
    },
    finish: async (state, signal) => {
      let pullRequestUrl: string | null = null;
      const round = state.history.at(-1);
      if (state.status === 'approved' && state.summary && round) {
        const screenshots = round.evidence.filter(
          (record) => record.kind === 'screenshot' && record.exitCode === 0,
        );
        const preview = renderPullRequest(
          state,
          screenshots,
          (record) => record.path,
        );
        await writeFile(join(directory, 'pull-request-preview.md'), preview, {
          mode: 0o600,
        });
        if (
          config.githubRepo &&
          (await approval(
            'Push this candidate and create a draft GitHub PR?',
            `${config.githubRepo} ← darkfactory/${runId}\n\n${state.summary.title}\n\n${preview}\nScreenshots and the verification manifest will be committed and published. Inspect screenshots for sensitive data before approving. Private logs remain in ${directory}.`,
            'Publish',
            'Keep local',
            signal,
          ))
        ) {
          progress('Publishing draft PR');
          pullRequestUrl = await publishPullRequest({
            config,
            repository,
            state,
            runId,
            directory,
            signal,
          });
        }
      }
      const result = deliveryResultSchema.parse({
        schemaVersion: '1.0',
        runId,
        status:
          state.status === 'blocked'
            ? 'blocked'
            : pullRequestUrl
              ? 'published'
              : 'ready',
        reason:
          state.reason ||
          (!config.githubRepo
            ? 'No unambiguous GitHub remote was found; the verified candidate remains local.'
            : ''),
        baseRevision: state.baseRevision,
        revision: round?.revision ?? null,
        rounds: state.round,
        runDirectory: directory,
        summary: state.summary,
        pullRequestUrl,
      });
      await writeFile(
        join(directory, 'result.json'),
        JSON.stringify(result, null, 2),
        { mode: 0o600 },
      );
      return result;
    },
    record: async (state) => {
      const round = state.history.at(-1);
      options.observe?.({
        kind: 'round',
        round: state.round,
        status: state.status,
        blockingFindings:
          round?.findings.filter((finding) => finding.severity === 'blocking')
            .length ?? 0,
        qa: round?.qa?.verdict ?? null,
        review: round?.review?.verdict ?? null,
      });
      await writeFile(
        join(directory, 'state.json'),
        JSON.stringify(state, null, 2),
        { mode: 0o600 },
      );
    },
  };
  return {
    operations,
    close: async () => {
      try {
        await stopQa();
      } finally {
        await Promise.allSettled([
          ...workspaces.map((workspace) => workspace.destroy()),
          ...sandboxes.map((sandbox) => sandbox.destroy()),
        ]);
      }
    },
  };
}

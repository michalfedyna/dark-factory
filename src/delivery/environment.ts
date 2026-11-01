import { mkdir, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import {
  LocalFilesystem,
  LocalSandbox,
  Workspace,
} from '@mastra/core/workspace';
import type { DeliveryRound, DeliveryState } from '../contracts/delivery.js';
import type { IssueBrief } from '../contracts/issue.js';
import { verificationPlanSchema } from '../contracts/project.js';
import { createRunRepository } from '../integrations/git/repository.js';
import { toolchainEnvironment } from '../integrations/local/toolchain.js';
import { createRunArtifacts } from './artifacts.js';
import type {
  DeliveryOptions,
  RoundResources,
  RunResources,
} from './context.js';
import { createEvidence } from './evidence.js';
import { createQaSession } from './qa-session.js';
import { prepareProject } from './preparation.js';
import { recordSandboxQaCommands } from './sandbox-qa-evidence.js';

/** Owns live resources, including resources acquired before setup completes. */
export function createDeliveryEnvironment(options: DeliveryOptions) {
  const lifetime = new AbortController();
  const resources = new Set<{ destroy: () => Promise<void> }>();
  let run: RunResources | undefined;
  let round: RoundResources | undefined;
  let preparing = false;
  let closing: Promise<void> | undefined;
  const own = <T extends { destroy: () => Promise<void> }>(resource: T): T => {
    resources.add(resource);
    return resource;
  };
  const requireRun = (): RunResources => {
    lifetime.signal.throwIfAborted();
    if (!run) throw new Error('Delivery environment has not been prepared.');
    return run;
  };
  return {
    requireRun,
    recordFailure: (step: string, state: DeliveryState, error: unknown) =>
      requireRun().artifacts.failure({
        step,
        state,
        error,
        evidence: round?.evidence.records ?? [],
        secrets: [options.apiKey, options.figmaToken ?? ''],
      }),
    createFigmaWorkspace: () => {
      const run = requireRun();
      const sandbox = own(new LocalSandbox(run.projectSandboxOptions));
      const workspace = own(
        new Workspace({
          filesystem: new LocalFilesystem({ basePath: run.repository.path }),
          sandbox,
        }),
      );
      resources.delete(sandbox);
      return workspace;
    },
    requireRound: (candidate: DeliveryRound): RoundResources => {
      requireRun();
      if (
        !round ||
        round.round !== candidate.round ||
        round.revision !== candidate.revision
      )
        throw new Error(
          'Verification resources do not match the current candidate. Run checks first.',
        );
      return round;
    },
    beginRound: (candidate: DeliveryRound): RoundResources => {
      const run = requireRun();
      const project = {
        ...run.project,
        ...verificationPlanSchema.parse(candidate.implementation.verification),
      };
      const evidence = createEvidence(
        join(run.directory, `round-${candidate.round}`),
        candidate.revision,
        candidate.round,
      );
      run.reviewFiles.setAllowedPaths([evidence.directory]);
      const sandboxQaSandbox = own(new LocalSandbox(run.projectSandboxOptions));
      recordSandboxQaCommands(sandboxQaSandbox, evidence);
      const sandboxQaWorkspace = own(
        new Workspace({
          filesystem: new LocalFilesystem({ basePath: run.repository.path }),
          sandbox: sandboxQaSandbox,
        }),
      );
      resources.delete(sandboxQaSandbox);
      round = {
        round: candidate.round,
        revision: candidate.revision,
        project,
        evidence,
        qaSession: createQaSession(run, project, candidate.round, evidence),
        sandboxQaWorkspace,
      };
      return round;
    },
    prepare: async (brief: IssueBrief, requestedSignal: AbortSignal) => {
      if (preparing || run)
        throw new Error('Delivery environment can only be prepared once.');
      preparing = true;
      const signal = AbortSignal.any([
        requestedSignal,
        options.signal,
        lifetime.signal,
      ]);
      signal.throwIfAborted();
      const { project, base, isolation } = await prepareProject(
        options,
        brief,
        signal,
      );
      signal.throwIfAborted();
      const source = project.repository;
      const directory = join(source, '.darkfactory', 'runs', options.runId);
      await mkdir(join(source, '.darkfactory', 'runs'), {
        recursive: true,
        mode: 0o700,
      });
      signal.throwIfAborted();
      await mkdir(directory, { mode: 0o700 });
      const artifacts = createRunArtifacts(directory);
      await artifacts.input({
        runId: options.runId,
        brief,
        config: project,
        model: options.model,
        sandbox: options.sandbox,
        baseRevision: base,
      });
      signal.throwIfAborted();
      const repository = await createRunRepository(
        source,
        directory,
        base,
        project.allowedPaths,
        signal,
      );
      signal.throwIfAborted();
      const home = join(directory, 'home');
      await mkdir(home, { mode: 0o700 });
      const toolchain = await toolchainEnvironment();
      signal.throwIfAborted();
      const projectSandboxOptions = {
        workingDirectory: repository.path,
        timeout: 0,
        isolation,
        env: {
          ...toolchain,
          HOME: home,
          CI: '1',
        },
        nativeSandbox: {
          allowNetwork: project.allowNetwork,
          readOnlyPaths: [
            toolchain.ANDROID_HOME,
            toolchain.ANDROID_AVD_HOME,
            toolchain.JAVA_HOME,
            toolchain.DEVELOPER_DIR,
          ].filter((path): path is string => Boolean(path)),
          readWritePaths: [home],
        },
      };
      const implementationSandbox = own(
        new LocalSandbox(projectSandboxOptions),
      );
      const projectSandbox = own(new LocalSandbox(projectSandboxOptions));
      const automationSandbox = own(
        new LocalSandbox({
          workingDirectory: join(directory, 'qa'),
          timeout: 0,
          env: {
            ...toolchain,
            // Keep explicitly selected automation CLIs ahead of global Node binaries.
            PATH: [process.env.PATH, toolchain.PATH]
              .filter(Boolean)
              .join(delimiter),
            HOME: process.env.HOME,
            AGENT_DEVICE_STATE_DIR: join(directory, 'device-state'),
          },
        }),
      );
      const implementationWorkspace = own(
        new Workspace({
          filesystem: new LocalFilesystem({ basePath: repository.path }),
          sandbox: implementationSandbox,
        }),
      );
      // Workspace.destroy owns its static sandbox from this point on.
      resources.delete(implementationSandbox);
      const reviewSandbox = own(new LocalSandbox(projectSandboxOptions));
      const reviewFiles = new LocalFilesystem({
        basePath: repository.path,
      });
      const reviewWorkspace = own(
        new Workspace({ filesystem: reviewFiles, sandbox: reviewSandbox }),
      );
      resources.delete(reviewSandbox);
      const browserConfig = join(directory, 'browser.json');
      await writeFile(browserConfig, '{}', { mode: 0o600 });
      signal.throwIfAborted();
      const prepared: RunResources = {
        runId: options.runId,
        project,
        directory,
        artifacts,
        repository,
        implementationWorkspace,
        implementationSandbox,
        projectSandboxOptions,
        reviewWorkspace,
        reviewFiles,
        projectSandbox,
        automationSandbox,
        browserConfig,
      };
      signal.throwIfAborted();
      run = prepared;
      return base;
    },
    close: (): Promise<void> => {
      if (!closing) {
        lifetime.abort(new Error('Delivery environment closed.'));
        closing = (async () => {
          try {
            await round?.qaSession.close();
          } finally {
            await Promise.allSettled(
              [...resources].map((resource) => resource.destroy()),
            );
            resources.clear();
          }
        })();
      }
      return closing;
    },
  };
}

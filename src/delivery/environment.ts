import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  LocalFilesystem,
  LocalSandbox,
  Workspace,
} from '@mastra/core/workspace';
import type { DeliveryRound } from '../contracts/delivery.js';
import type { IssueBrief } from '../contracts/issue.js';
import { createRunRepository } from '../integrations/git/repository.js';
import { createRunArtifacts } from './artifacts.js';
import { executeProjectCommand } from './checks.js';
import type {
  DeliveryOptions,
  RoundResources,
  RunResources,
} from './context.js';
import { createEvidence } from './evidence.js';
import { createQaSession } from './qa-session.js';
import { approveProject } from './preparation.js';

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
      const evidence = createEvidence(
        join(run.directory, `round-${candidate.round}`),
        candidate.revision,
        candidate.round,
      );
      run.verificationFiles.setAllowedPaths([evidence.directory]);
      round = {
        round: candidate.round,
        revision: candidate.revision,
        evidence,
        qaSession: createQaSession(run, candidate.round),
      };
      return round;
    },
    prepare: async (
      brief: IssueBrief,
      requestedSignal: AbortSignal,
      maxRepairRounds: number,
    ) => {
      if (preparing || run)
        throw new Error('Delivery environment can only be prepared once.');
      preparing = true;
      const signal = AbortSignal.any([
        requestedSignal,
        options.signal,
        lifetime.signal,
      ]);
      signal.throwIfAborted();
      const { project, base, isolation } = await approveProject(
        options,
        brief,
        signal,
        maxRepairRounds,
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
        baseRevision: base,
        implementationApproved: true,
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
      signal.throwIfAborted();
      const projectSandboxOptions = {
        workingDirectory: repository.path,
        isolation,
        env: { HOME: home, CI: '1' },
        nativeSandbox: {
          allowNetwork: project.allowNetwork,
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
          env: {
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
      const verificationFiles = new LocalFilesystem({
        basePath: repository.path,
        readOnly: true,
      });
      const verificationWorkspace = own(
        new Workspace({ filesystem: verificationFiles }),
      );
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
        verificationWorkspace,
        verificationFiles,
        projectSandbox,
        automationSandbox,
        browserConfig,
      };
      for (const [index, setup] of project.setup.entries()) {
        options.progress('Preparing dependencies');
        const result = await executeProjectCommand(
          projectSandbox,
          setup,
          signal,
        );
        await artifacts.setup(index, result);
        if (result.exitCode !== 0)
          throw new Error(`Repository setup failed. See ${directory}.`);
      }
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

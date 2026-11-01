import { Mastra } from '@mastra/core/mastra';
import { createExploration } from '../agents/exploration.js';
import { createProjectInspection } from '../agents/project.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Ask } from '../contracts/interaction.js';
import { inspectRepository } from '../integrations/git/inspect.js';
import { startRouter } from '../integrations/router/process.js';
import { createDefaultWorkflow } from '../workflows/default.js';
import { createDeliveryRuntime } from './delivery-runtime.js';
import { runDefault } from './run.js';

export async function startFactory(
  config: FactoryConfig,
  directory: string,
  apiKey: string,
  signal: AbortSignal,
  repositoryDirectory = process.cwd(),
) {
  const controller = new AbortController();
  const factorySignal = AbortSignal.any([signal, controller.signal]);
  const repository = await inspectRepository(
    repositoryDirectory,
    factorySignal,
  );
  const router = await startRouter(config, apiKey, directory, factorySignal);
  const explore = createExploration(config.model, apiKey);
  const mastra = new Mastra({
    logger: false,
    workflows: {
      default: createDefaultWorkflow({ explore }),
    },
  });
  let closing: Promise<void> | undefined;
  void router.exited.then((message) => {
    if (!closing) controller.abort(new Error(message));
  });
  return {
    signal: factorySignal,
    run: (issue: unknown, ask: Ask, progress: (message: string) => void) =>
      runDefault({
        issue,
        ask,
        progress,
        workflow: mastra.getWorkflow('default'),
        signal: factorySignal,
        timeoutMs: config.sessionTimeoutMs,
        runtime: (runId, signal) =>
          createDeliveryRuntime({
            inspect: createProjectInspection(
              config.model,
              apiKey,
              repository,
              ask,
            ),
            model: config.model,
            apiKey,
            runId,
            ask,
            signal,
            progress,
          }),
      }),
    close: (): Promise<void> => {
      if (!closing) {
        controller.abort(new Error('The factory stopped.'));
        closing = Promise.all([mastra.shutdown(), router.stop()]).then(
          () => {},
        );
      }
      return closing;
    },
  };
}

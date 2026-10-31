import { resolve } from 'node:path';
import { Mastra } from '@mastra/core/mastra';
import { createExploration } from '../agents/exploration.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Ask } from '../contracts/interaction.js';
import { startRouter } from '../integrations/router/process.js';
import { createExplorationWorkflow } from '../workflows/exploration.js';
import { runExploration } from './explore.js';
import { createOutputWriter } from './output.js';

export async function startFactory(
  config: FactoryConfig,
  directory: string,
  apiKey: string,
  print: (json: string) => void,
  signal: AbortSignal,
) {
  const controller = new AbortController();
  const factorySignal = AbortSignal.any([signal, controller.signal]);
  const router = await startRouter(config, apiKey, directory, factorySignal);
  const explore = createExploration(config.model, apiKey);
  const save = createOutputWriter(resolve(directory, config.outputDir), print);
  const mastra = new Mastra({
    logger: false,
    workflows: { exploration: createExplorationWorkflow({ explore, save }) },
  });
  let closing: Promise<void> | undefined;
  void router.exited.then((message) => {
    if (!closing) controller.abort(new Error(message));
  });
  return {
    signal: factorySignal,
    explore: (issue: unknown, ask: Ask) =>
      runExploration({
        issue,
        ask,
        workflow: mastra.getWorkflow('exploration'),
        signal: factorySignal,
        timeoutMs: config.sessionTimeoutMs,
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

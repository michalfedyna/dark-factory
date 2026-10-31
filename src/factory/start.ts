import { resolve } from 'node:path';
import { createExploration } from '../agents/exploration.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Ask } from '../contracts/interaction.js';
import { startRouter } from '../integrations/router/process.js';
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
        explore,
        save,
        signal: factorySignal,
        timeoutMs: config.sessionTimeoutMs,
      }),
    close: (): Promise<void> => {
      if (!closing) {
        controller.abort(new Error('The factory stopped.'));
        closing = router.stop();
      }
      return closing;
    },
  };
}

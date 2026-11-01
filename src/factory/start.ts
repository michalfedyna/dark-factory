import { Mastra } from '@mastra/core/mastra';
import { createExploration } from '../agents/exploration.js';
import { createObserver } from '../agents/observer.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Ask } from '../contracts/interaction.js';
import type { Observe } from '../contracts/progress.js';
import { inspectRepository } from '../integrations/git/inspect.js';
import { startRouter } from '../integrations/router/process.js';
import { createDefaultWorkflow } from '../workflows/default.js';
import { createDeliveryRuntime } from '../delivery/runtime.js';
import { runDefault } from './run.js';
import { createProgressObserver } from './observer.js';

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
  try {
    const explore = createExploration(config.model, apiKey);
    const observerAgent = config.observer.enabled
      ? createObserver(config.model, config.observer, apiKey)
      : undefined;
    const mastra = new Mastra({
      logger: false,
      ...(observerAgent ? { agents: { observer: observerAgent.agent } } : {}),
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
      run: async (
        issue: unknown,
        ask: Ask,
        progress: (message: string) => void,
        summary: (message: string) => void = progress,
      ) => {
        let observer: ReturnType<typeof createProgressObserver> | undefined;
        const observe: Observe = (activity) => observer?.observe(activity);
        const report = (message: string) => {
          observe({ kind: 'stage', message });
          progress(message);
        };
        try {
          return await runDefault({
            issue,
            ask,
            progress: report,
            observe,
            workflow: mastra.getWorkflow('default'),
            signal: factorySignal,
            timeoutMs: config.sessionTimeoutMs,
            onDeliveryStart: (signal) => {
              observer = observerAgent
                ? createProgressObserver({
                    summarize: observerAgent.summarize,
                    emit: summary,
                    intervalMs: config.observer.intervalMs,
                    timeoutMs: config.observer.timeoutMs,
                    signal,
                  })
                : undefined;
            },
            runtime: (runId, signal) =>
              createDeliveryRuntime({
                repository,
                model: config.model,
                sandbox: config.sandbox,
                apiKey,
                runId,
                signal,
                progress: report,
                observe,
              }),
          });
        } finally {
          // Abort without waiting for a slow observer; final output is authoritative.
          observer?.close();
        }
      },
      close: (): Promise<void> => {
        if (!closing) {
          controller.abort(new Error('The factory stopped.'));
          closing = Promise.allSettled([router.stop(), mastra.shutdown()]).then(
            (results) => {
              for (const result of results)
                if (result.status === 'rejected') throw result.reason;
            },
          );
        }
        return closing;
      },
    };
  } catch (error) {
    await router.stop();
    throw error;
  }
}

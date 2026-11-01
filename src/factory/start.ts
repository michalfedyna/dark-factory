import { Mastra } from '@mastra/core/mastra';
import { createExploration } from '../agents/exploration.js';
import { createObserver } from '../agents/observer.js';
import type { FactoryConfig } from '../config/schema.js';
import type { Debug } from '../contracts/debug.js';
import type { Ask } from '../contracts/interaction.js';
import type { Observe } from '../contracts/progress.js';
import { inspectRepository } from '../integrations/git/inspect.js';
import { startRouter } from '../integrations/router/process.js';
import { createDefaultWorkflow } from '../workflows/default.js';
import { createDeliveryRuntime } from '../delivery/runtime.js';
import { runDefault } from './run.js';
import { createProgressObserver } from './observer.js';
import { cleanupAll, withCleanup } from '../diagnostics/cleanup.js';
import type { DeliveryOperations } from '../delivery/operations.js';
import { RunFailure } from '../contracts/diagnostics.js';

export async function startFactory(
  config: FactoryConfig,
  directory: string,
  apiKey: string,
  signal: AbortSignal,
  repositoryDirectory = process.cwd(),
  options: { debug?: Debug; onCleanupError?: (error: unknown) => void } = {},
) {
  const reportStartupCleanup = (error: unknown) => {
    options.debug?.({
      kind: 'detail',
      agent: 'factory',
      label: 'Startup cleanup failed',
      value: error,
    });
    options.onCleanupError?.(error);
  };
  const controller = new AbortController();
  const factorySignal = AbortSignal.any([signal, controller.signal]);
  const repository = await inspectRepository(
    repositoryDirectory,
    factorySignal,
  );
  const router = await startRouter(
    config,
    apiKey,
    directory,
    factorySignal,
    reportStartupCleanup,
  );
  try {
    const figmaToken = process.env[config.figma.tokenEnv];
    const explore = createExploration(config.model, apiKey, {
      figma: config.figma,
      ...(figmaToken ? { figmaToken } : {}),
      ...(options.debug ? { debug: options.debug } : {}),
    });
    const observerAgent =
      config.observer.enabled && !options.debug
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
    const cleanupReports = new Set<DeliveryOperations['recordCleanup']>();
    void router.exited.then((message) => {
      if (!closing) controller.abort(new RunFailure(message));
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
        const observe: Observe = (activity) => {
          observer?.observe(activity);
          // Agent chunks carry tools and reasoning; stages use progress.
          if (
            activity.kind !== 'tool' &&
            activity.kind !== 'reasoning' &&
            activity.kind !== 'stage'
          )
            options.debug?.({ kind: 'activity', activity });
        };
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
            onDeliveryStart: (signal) => {
              observer = observerAgent
                ? createProgressObserver({
                    summarize: observerAgent.summarize,
                    emit: summary,
                    intervalMs: config.observer.intervalMs,
                    timeoutMs: config.observer.timeoutMs,
                    secrets: [apiKey, figmaToken ?? ''],
                    signal,
                  })
                : undefined;
            },
            runtime: (runId, signal) => {
              const runtime = createDeliveryRuntime({
                repository,
                model: config.model,
                sandbox: config.sandbox,
                apiKey,
                figma: config.figma,
                ...(figmaToken ? { figmaToken } : {}),
                runId,
                signal,
                progress: report,
                observe,
                ...(options.debug ? { debug: options.debug } : {}),
              });
              cleanupReports.add(runtime.operations.recordCleanup);
              return runtime;
            },
          });
        } finally {
          // Abort without waiting for a slow observer; final output is authoritative.
          observer?.close();
        }
      },
      close: (): Promise<void> => {
        if (!closing) {
          controller.abort(new Error('The factory stopped.'));
          closing = cleanupAll([
            () => router.stop(),
            () => mastra.shutdown(),
          ]).catch(async (error: unknown) => {
            await Promise.allSettled(
              [...cleanupReports].map((report) =>
                report('factory router/Mastra', error),
              ),
            );
            throw new Error(
              'Factory cleanup failed. See cleanup.jsonl in the run artifacts.',
              { cause: error },
            );
          });
        }
        return closing;
      },
    };
  } catch (error) {
    return withCleanup(
      () =>
        Promise.reject(
          error instanceof Error
            ? error
            : new Error('Factory initialization failed.', { cause: error }),
        ),
      () => router.stop(),
      reportStartupCleanup,
    );
  }
}

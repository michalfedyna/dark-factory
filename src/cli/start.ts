import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prompts from '@clack/prompts';
import { loadConfig } from '../config/load.js';
import { issueInputSchema } from '../contracts/interaction.js';
import { startFactory } from '../factory/start.js';
import { createDebugWriter } from './debug.js';
import { writeObserver } from './observer.js';
import { createProgressSpinner } from './progress.js';
import { CancelledError, createTerminal } from './terminal.js';
import { cleanupAll, withCleanup } from '../diagnostics/cleanup.js';
import { RunFailure } from '../contracts/diagnostics.js';

export async function startCommand(options: {
  config: string;
  issue?: string;
  debug?: boolean;
}): Promise<void> {
  const suppliedIssue =
    options.issue === undefined
      ? undefined
      : issueInputSchema.parse(options.issue);
  // npm runs scripts from the package root, not the caller's directory.
  const workingDirectory =
    process.env.INIT_CWD &&
    process.env.npm_package_json ===
      fileURLToPath(new URL('../../package.json', import.meta.url)) &&
    ['dev', 'start'].includes(process.env.npm_lifecycle_event ?? '')
      ? process.env.INIT_CWD
      : process.cwd();
  const { config, directory } = await loadConfig(
    resolve(workingDirectory, options.config),
  );
  try {
    loadEnvFile(resolve(directory, '.env'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  const apiKey = process.env[config.model.apiKeyEnv];
  if (!apiKey?.trim())
    throw new Error(
      `Set ${config.model.apiKeyEnv} in your environment or .env. It must match the router client key. See .env.example.`,
    );

  const controller = new AbortController();
  const cancel = (): never => {
    const error = new CancelledError();
    controller.abort(error);
    throw error;
  };
  const terminal = createTerminal({ cancel });
  const output = process.stderr;
  const progress = createProgressSpinner(output);
  const debug = options.debug
    ? createDebugWriter(output, [
        apiKey,
        process.env[config.figma.tokenEnv] ?? '',
      ])
    : undefined;
  const startProgress = (message: string) => {
    if (!debug) progress.start(message);
  };
  const onSignal = () => {
    progress.close();
    debug?.close();
    controller.abort(new CancelledError());
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let factory: Awaited<ReturnType<typeof startFactory>> | undefined;
  try {
    const result = await withCleanup(
      async () => {
        progress.start('Starting router');
        factory = await startFactory(
          config,
          directory,
          apiKey,
          controller.signal,
          workingDirectory,
          {
            ...(debug ? { debug: debug.write } : {}),
            onCleanupError: () => {
              output.write('Router cleanup failed during startup.\n');
            },
          },
        );
        progress.clear();
        const issue = suppliedIssue ?? (await terminal.issue(factory.signal));
        let stage = 'Exploring';
        return factory.run(
          issue,
          async (question, signal) => {
            progress.clear();
            debug?.pause();
            try {
              const answer = await terminal.ask(question, signal);
              startProgress(stage);
              return answer;
            } catch (error) {
              controller.abort(
                error instanceof CancelledError
                  ? error
                  : new RunFailure(
                      error instanceof Error
                        ? error.message
                        : 'Terminal input failed.',
                      { cause: error },
                    ),
              );
              throw error;
            } finally {
              debug?.resume();
            }
          },
          (message) => {
            stage = message;
            debug?.flush();
            startProgress(message);
            if (debug && output.isTTY)
              prompts.log.step(message, { output, withGuide: false });
            else if (!output.isTTY) output.write(`${message}\n`);
          },
          (message) => {
            progress.clear();
            writeObserver(message, output);
            startProgress(stage);
          },
        );
      },
      async () => {
        progress.close();
        await cleanupAll([
          () => terminal.close(),
          async () => {
            await factory?.close();
          },
        ]);
      },
      () => {
        output.write(
          'Cleanup failed; see cleanup.jsonl in the run artifacts.\n',
        );
      },
    );
    progress.close();
    debug?.close();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    prompts.log.success(
      result.pullRequestUrl ??
        `Workflow ${result.status}: ${result.runDirectory}`,
      { output, withGuide: false },
    );
    if (result.status === 'blocked') process.exitCode = 1;
  } catch (error) {
    progress.close();
    debug?.close();
    if (
      error instanceof CancelledError ||
      controller.signal.reason instanceof CancelledError
    ) {
      prompts.cancel('Cancelled.', { output, withGuide: false });
      process.exitCode = 130;
    } else {
      throw error;
    }
  } finally {
    progress.close();
    debug?.close();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

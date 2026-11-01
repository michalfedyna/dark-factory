import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prompts from '@clack/prompts';
import { loadConfig } from '../config/load.js';
import { issueInputSchema } from '../contracts/interaction.js';
import { startFactory } from '../factory/start.js';
import { writeObserver } from './observer.js';
import { createProgressSpinner } from './progress.js';
import { CancelledError, createTerminal } from './terminal.js';

export async function startCommand(options: {
  config: string;
  issue?: string;
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
  const onSignal = () => {
    progress.close();
    controller.abort(new CancelledError());
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let factory: Awaited<ReturnType<typeof startFactory>> | undefined;
  try {
    progress.start('Starting router');
    factory = await startFactory(
      config,
      directory,
      apiKey,
      controller.signal,
      workingDirectory,
    );
    progress.clear();
    const issue = suppliedIssue ?? (await terminal.issue(factory.signal));
    let stage = 'Exploring';
    const result = await factory.run(
      issue,
      async (question, signal) => {
        progress.clear();
        try {
          const answer = await terminal.ask(question, signal);
          progress.start(stage);
          return answer;
        } catch (error) {
          controller.abort(
            error instanceof Error
              ? error
              : new Error('Terminal input failed.'),
          );
          throw error;
        }
      },
      (message) => {
        stage = message;
        progress.start(message);
        if (!output.isTTY) output.write(`${message}\n`);
      },
      (message) => {
        progress.clear();
        writeObserver(message, output);
        progress.start(stage);
      },
    );
    progress.close();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    prompts.log.success(
      result.pullRequestUrl ??
        `Workflow ${result.status}: ${result.runDirectory}`,
      { output, withGuide: false },
    );
    if (result.status === 'blocked') process.exitCode = 1;
  } catch (error) {
    progress.close();
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
    try {
      terminal.close();
    } finally {
      try {
        await factory?.close();
      } finally {
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
      }
    }
  }
}

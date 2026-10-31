import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import * as prompts from '@clack/prompts';
import { loadConfig } from '../config/load.js';
import { issueInputSchema } from '../contracts/interaction.js';
import { startFactory } from '../factory/start.js';
import { CancelledError, createTerminal } from './terminal.js';

export async function startCommand(options: {
  config: string;
  issue?: string;
}): Promise<void> {
  const suppliedIssue =
    options.issue === undefined
      ? undefined
      : issueInputSchema.parse(options.issue);
  const { config, directory } = await loadConfig(options.config);
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
  const progress = output.isTTY
    ? prompts.spinner({ output, withGuide: false })
    : undefined;
  const onSignal = () => {
    progress?.clear();
    controller.abort(new CancelledError());
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  let factory: Awaited<ReturnType<typeof startFactory>> | undefined;
  try {
    progress?.start('Starting router');
    factory = await startFactory(
      config,
      directory,
      apiKey,
      (json) => {
        process.stdout.write(`${json}\n`);
      },
      controller.signal,
    );
    progress?.clear();
    const issue = suppliedIssue ?? (await terminal.issue(factory.signal));
    progress?.start('Exploring');
    const result = await factory.explore(issue, async (question, signal) => {
      progress?.clear();
      try {
        const answer = await terminal.ask(question, signal);
        progress?.start('Exploring');
        return answer;
      } catch (error) {
        controller.abort(
          error instanceof Error ? error : new Error('Terminal input failed.'),
        );
        throw error;
      }
    });
    progress?.clear();
    prompts.log.success(`Saved ${result.outputFile}`, {
      output,
      withGuide: false,
    });
  } catch (error) {
    progress?.clear();
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
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    terminal.close();
    await factory?.close();
  }
}

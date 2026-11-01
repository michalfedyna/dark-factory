import { fork } from 'node:child_process';
import type { FactoryConfig } from '../../config/schema.js';

export function startManagedRouter(
  config: FactoryConfig['router'],
  directory: string,
) {
  // Node's native TypeScript support also runs the supervisor during development.
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
  const supervisor = fork(
    new URL(`./supervisor.${extension}`, import.meta.url),
    [config.command, ...config.args],
    {
      cwd: directory,
      detached: process.platform !== 'win32',
      execArgv: [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  const exited = new Promise<string>((resolve) => {
    supervisor.on('message', (message: unknown) => {
      if (typeof message === 'string') resolve(message);
    });
    supervisor.once('error', (error) => {
      resolve(`Cannot supervise CLIProxyAPI: ${error.message}.`);
    });
    supervisor.once('exit', (code, signal) => {
      resolve(`CLIProxyAPI supervisor exited (${signal ?? String(code)}).`);
    });
  });
  const terminated = new Promise<void>((resolve) => {
    supervisor.once('exit', () => {
      resolve();
    });
    supervisor.once('error', () => {
      resolve();
    });
  });
  let stopping: Promise<void> | undefined;
  return {
    exited,
    stop: (): Promise<void> => {
      stopping ??= (async () => {
        if (supervisor.connected)
          supervisor.send('stop', (error) => {
            if (error && supervisor.connected) supervisor.disconnect();
          });
        await terminated;
      })();
      return stopping;
    },
  };
}

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

// This process owns the proxy. Losing the factory's IPC connection always stops it.
const [command, ...args] = process.argv.slice(2);
if (!command || !process.connected)
  throw new Error('The router supervisor requires a factory connection.');

const proxy = spawn(command, args, {
  detached: process.platform !== 'win32',
  stdio: 'ignore',
  shell: false,
});

function notify(message: string): void {
  if (process.connected) process.send?.(message, () => {});
}

function killProxy(signal: NodeJS.Signals): void {
  if (!proxy.pid) return;
  try {
    if (process.platform === 'win32') proxy.kill(signal);
    else process.kill(-proxy.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
      throw error;
  }
}

const exited = new Promise<void>((resolve) => {
  proxy.once('error', (error) => {
    notify(
      `Cannot start ${command}: ${error.message}. Install CLIProxyAPI and check router.command.`,
    );
    resolve();
  });
  proxy.once('exit', (code, signal) => {
    notify(
      `CLIProxyAPI exited (${signal ?? String(code)}). Check config/router.yaml and run the router command directly for details.`,
    );
    resolve();
  });
});

let stopping: Promise<void> | undefined;
function stop(): Promise<void> {
  stopping ??= (async () => {
    const deadline = new AbortController();
    try {
      killProxy('SIGTERM');
      await Promise.race([
        exited,
        delay(3_000, undefined, { signal: deadline.signal }),
      ]);
      // A wrapper can exit before its descendants. Kill the remaining group too.
      killProxy('SIGKILL');
      await exited;
    } finally {
      deadline.abort();
      if (process.connected) process.disconnect?.();
    }
  })();
  return stopping;
}

process.on('disconnect', () => {
  void stop();
});
process.on('message', (message: unknown) => {
  if (message === 'stop') void stop();
});
process.on('SIGINT', () => {
  void stop();
});
process.on('SIGTERM', () => {
  void stop();
});
process.on('SIGHUP', () => {
  void stop();
});
void exited.then(stop);
// The factory may have disconnected while this process was starting.
if (!process.connected) void stop();

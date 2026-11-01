import type { LocalSandbox } from '@mastra/core/workspace';
import type { QaSession, RunResources } from './context.js';

export function createQaSession(run: RunResources, round: number): QaSession {
  const { project, projectSandbox, automationSandbox, runId, browserConfig } =
    run;
  const servers: Awaited<ReturnType<LocalSandbox['processes']['spawn']>>[] = [];
  let active = false;
  let closing: Promise<void> | undefined;
  const lifetime = new AbortController();
  return {
    start: async (requestedSignal) => {
      const signal = AbortSignal.any([requestedSignal, lifetime.signal]);
      signal.throwIfAborted();
      if (active || closing)
        throw new Error('QA session cannot be started again.');
      // Mark ownership before spawning so partial startup is also cleaned up.
      active = true;
      for (const target of project.targets) {
        signal.throwIfAborted();
        if (!target.start) continue;
        const line = [target.start.command, ...target.start.args]
          .map((value) => `'${value.replace(/'/g, `'\\''`)}'`)
          .join(' ');
        const server = await projectSandbox.processes.spawn(line, {
          abortSignal: signal,
          stdinMode: 'ignore',
        });
        servers.push(server);
        if (signal.aborted) await server.kill();
        signal.throwIfAborted();
      }
    },
    assertRunning: () => {
      if (!active) throw new Error('QA session is not active.');
      if (servers.some((process) => process.exitCode !== undefined))
        throw new Error(
          'A configured QA server exited. Verification cannot be trusted.',
        );
    },
    close: () => {
      if (closing) return closing;
      lifetime.abort(new Error('QA session closed.'));
      if (!active) {
        closing = Promise.resolve();
        return closing;
      }
      closing = (async () => {
        // Cleanup has its own short deadline, independent of run cancellation.
        const signal = AbortSignal.timeout(10_000);
        try {
          await Promise.allSettled(
            project.targets.map(async (target) => {
              const session = `${runId}-r${round}-${target.id}`;
              if (!automationSandbox.executeCommand)
                throw new Error(
                  'The automation sandbox must support command execution.',
                );
              await automationSandbox.executeCommand(
                target.kind === 'web'
                  ? project.browserCommand
                  : project.deviceCommand,
                target.kind === 'web'
                  ? ['--config', browserConfig, '--session', session, 'close']
                  : [
                      'close',
                      '--session',
                      session,
                      '--platform',
                      target.platform,
                    ],
                { timeout: 8_000, abortSignal: signal },
              );
            }),
          );
        } finally {
          active = false;
          await projectSandbox.stop();
        }
      })();
      return closing;
    },
  };
}

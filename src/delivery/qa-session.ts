import { setTimeout as delay } from 'node:timers/promises';
import type { LocalSandbox } from '@mastra/core/workspace';
import type { Evidence } from '../contracts/delivery.js';
import type { VerificationProject } from '../contracts/project.js';
import type { QaSession, RunResources } from './context.js';
import type { EvidenceRecorder } from './evidence.js';

type QaTarget = VerificationProject['targets'][number];
type QaServer = Awaited<ReturnType<LocalSandbox['processes']['spawn']>>;

/** A candidate's QA server failed, rather than an agent or provider call. */
export class QaTargetFailure extends Error {
  constructor(
    message: string,
    readonly evidence: Evidence,
  ) {
    super(message);
  }
}

async function waitForWebTarget(
  target: Extract<QaTarget, { kind: 'web' }>,
  server: QaServer,
  signal: AbortSignal,
) {
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(
      new Error(
        `QA target ${target.id} did not respond within ${target.start.timeoutMs}ms.`,
      ),
    );
  }, target.start.timeoutMs);
  const readinessSignal = AbortSignal.any([signal, deadline.signal]);
  try {
    while (true) {
      readinessSignal.throwIfAborted();
      if (server.exitCode !== undefined)
        throw new Error(
          `QA target ${target.id} exited with code ${server.exitCode}.`,
        );
      try {
        const response = await fetch(target.url, {
          signal: AbortSignal.any([
            readinessSignal,
            AbortSignal.timeout(1_000),
          ]),
          redirect: 'manual',
        });
        await response.body?.cancel();
        if (response.status >= 200 && response.status < 400) {
          readinessSignal.throwIfAborted();
          if (server.exitCode === undefined) return;
        }
      } catch {
        readinessSignal.throwIfAborted();
      }
      await delay(100, undefined, { signal: readinessSignal });
    }
  } catch (error) {
    readinessSignal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function createQaSession(
  run: RunResources,
  project: VerificationProject,
  round: number,
  evidence: EvidenceRecorder,
): QaSession {
  const { projectSandbox, automationSandbox, runId, browserConfig } = run;
  const servers: { target: QaTarget; server: QaServer }[] = [];
  let active = false;
  let closing: Promise<void> | undefined;
  const lifetime = new AbortController();
  const failure = async (
    target: QaTarget,
    error: unknown,
    server?: QaServer,
  ) => {
    const record = await evidence.record(
      {
        kind: 'check',
        targetId: target.id,
        operation: `qa-server-${target.id}`,
        exitCode: server?.exitCode || 1,
      },
      {
        start: target.start,
        error: error instanceof Error ? error.message : String(error),
        exitCode: server?.exitCode ?? null,
        stdout: server?.stdout ?? '',
        stderr: server?.stderr ?? '',
      },
    );
    return new QaTargetFailure(
      `QA server ${target.id} failed. See ${record.path}.`,
      record,
    );
  };
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
        let server: QaServer | undefined;
        try {
          server = await projectSandbox.processes.spawn(line, {
            abortSignal: signal,
            stdinMode: 'ignore',
          });
          servers.push({ target, server });
          if (signal.aborted) await server.kill();
          signal.throwIfAborted();
          if (target.kind === 'web')
            await waitForWebTarget(target, server, signal);
        } catch (error) {
          signal.throwIfAborted();
          throw await failure(target, error, server);
        }
      }
    },
    assertRunning: async () => {
      if (!active) throw new Error('QA session is not active.');
      for (const { target, server } of servers)
        if (server.exitCode !== undefined)
          throw await failure(
            target,
            new Error(
              `QA server exited with code ${server.exitCode}. Verification cannot be trusted.`,
            ),
            server,
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

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Mastra } from '@mastra/core/mastra';
import { LocalSandbox } from '@mastra/core/workspace';
import { createProgressTester } from '../agents/progress-test.js';
import type {
  ProgressTestRequest,
  ProgressTestResult,
} from '../contracts/progress-test.js';
import { progressTestReportSchema } from '../contracts/progress-test.js';
import type { VerificationProject } from '../contracts/project.js';
import { cleanupAll, withCleanup } from '../diagnostics/cleanup.js';
import { errorDetails } from '../diagnostics/errors.js';
import { createQaTools } from '../tools/qa.js';
import { createProgressTestWorkflow } from '../workflows/progress-test.js';
import type { DeliveryOptions, QaSession, RunResources } from './context.js';
import {
  createEvidence,
  validateScreenshot,
  type EvidenceRecorder,
} from './evidence.js';
import { createQaSession, QaTargetFailure } from './qa-session.js';

async function targetFailureDescription(error: QaTargetFailure) {
  return `${error.message}\n${(await readFile(error.evidence.path, 'utf8')).slice(-24_000)}`;
}

async function prepareProgressTarget(
  target: ProgressTestRequest['target'],
  projectSandbox: LocalSandbox,
  session: QaSession,
  evidence: EvidenceRecorder,
  signal: AbortSignal,
): Promise<string | null> {
  signal.throwIfAborted();
  if (target.kind === 'mobile') {
    let result;
    try {
      if (!projectSandbox.executeCommand)
        throw new Error('The project sandbox must support command execution.');
      result = await projectSandbox.executeCommand(
        target.prepare.command,
        target.prepare.args,
        { abortSignal: signal, timeout: 0 },
      );
    } catch (error) {
      signal.throwIfAborted();
      result = {
        exitCode: -1,
        stdout: '',
        stderr: JSON.stringify(errorDetails(error)),
      };
    }
    signal.throwIfAborted();
    await evidence.record(
      {
        kind: 'check',
        targetId: target.id,
        operation: 'prepare',
        exitCode: result.exitCode,
      },
      { command: target.prepare, ...result },
    );
    if (result.exitCode !== 0)
      return `Target preparation failed (exit ${result.exitCode}).\n${result.stdout.slice(-16_000)}\n${result.stderr.slice(-8_000)}`;
  }
  try {
    await session.start(signal);
    return null;
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof QaTargetFailure)) throw error;
    return targetFailureDescription(error);
  }
}

/** Each call owns its servers and automation sessions, outside candidate QA state. */
export function createProgressTestRunner(
  run: Pick<
    RunResources,
    | 'runId'
    | 'directory'
    | 'project'
    | 'projectSandboxOptions'
    | 'automationSandbox'
    | 'browserConfig'
    | 'artifacts'
  >,
  options: Pick<DeliveryOptions, 'model' | 'apiKey' | 'observe' | 'debug'>,
) {
  const test = createProgressTester(options.model, options.apiKey);
  return async (
    request: ProgressTestRequest,
    signal: AbortSignal,
  ): Promise<ProgressTestResult> => {
    signal.throwIfAborted();
    const id = randomUUID();
    const sessionPrefix = `${run.runId}-test-${id}`;
    const evidence = createEvidence(
      join(run.directory, 'progress-tests', id),
      'work-in-progress',
      0,
    );
    const project: VerificationProject = {
      ...run.project,
      checks: [],
      targets: [request.target],
    };
    const projectSandbox = new LocalSandbox(run.projectSandboxOptions);
    const session = createQaSession(
      { ...run, projectSandbox },
      project,
      sessionPrefix,
      evidence,
    );
    const tools = createQaTools({
      project,
      automationSandbox: run.automationSandbox,
      evidence,
      session: sessionPrefix,
      browserConfig: run.browserConfig,
      signal,
    });
    const reportCleanup = (error: unknown) =>
      run.artifacts.cleanup('progress test', error);
    let mastra: Mastra | undefined;
    return withCleanup(
      async () => {
        const workflow = createProgressTestWorkflow({
          prepare: ({ target }) =>
            prepareProgressTarget(
              target,
              projectSandbox,
              session,
              evidence,
              signal,
            ),
          test: async (context) => {
            signal.throwIfAborted();
            const report = await test({
              context,
              tools,
              signal,
              ...(options.observe ? { observe: options.observe } : {}),
              ...(options.debug ? { debug: options.debug } : {}),
            });
            try {
              await session.assertRunning();
            } catch (error) {
              signal.throwIfAborted();
              if (!(error instanceof QaTargetFailure)) throw error;
              return {
                status: 'blocked',
                description: await targetFailureDescription(error),
              };
            }
            return report;
          },
        });
        mastra = new Mastra({
          logger: false,
          workflows: { progressTest: workflow },
        });
        const workflowRun = await mastra
          .getWorkflow('progressTest')
          .createRun();
        const result = await workflowRun.start({ inputData: request });
        signal.throwIfAborted();
        if (result.status !== 'success')
          throw new Error('Progress testing failed.', {
            cause: result.status === 'failed' ? result.error : undefined,
          });
        const captures = request.target.screenshots
          ? evidence.records
              .filter(
                (record) =>
                  record.kind === 'screenshot' && record.exitCode === 0,
              )
              .slice(-4)
          : [];
        const screenshots = await Promise.all(
          captures.map(async ({ path }) => {
            await validateScreenshot(path);
            return {
              data: (await readFile(path)).toString('base64'),
              mediaType: 'image/png' as const,
            };
          }),
        );
        signal.throwIfAborted();
        return {
          ...progressTestReportSchema.parse(result.result),
          screenshots,
        };
      },
      () =>
        withCleanup(
          () => session.close(),
          () =>
            cleanupAll([
              () => projectSandbox.destroy(),
              async () => {
                await mastra?.shutdown();
              },
            ]),
          reportCleanup,
        ),
      reportCleanup,
    );
  };
}

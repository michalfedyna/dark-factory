import { createImplementation } from '../agents/implementation.js';
import type { Workspace } from '@mastra/core/workspace';
import { createFigma } from '../agents/figma.js';
import { createIssueTask } from '../agents/task.js';
import { createFigmaTools } from '../tools/figma.js';
import { createQa } from '../agents/qa.js';
import { createSandboxQa } from '../agents/sandbox-qa.js';
import { createReview } from '../agents/review.js';
import { createSummary } from '../agents/summary.js';
import type { DeliveryState } from '../contracts/delivery.js';
import { createQaTools } from '../tools/qa.js';
import { createQaEvidenceTool } from '../tools/qa-evidence.js';
import { createTestTool } from '../tools/test.js';
import { createProgressTestRunner } from './progress-test.js';
import {
  implementationContext,
  qaContext,
  sandboxQaContext,
  reviewContext,
  summaryContext,
} from './agent-context.js';
import { readFailedCheckLogs } from './artifacts.js';
import type {
  DeliveryOptions,
  RoundResources,
  RunResources,
} from './context.js';
import { currentRound } from './state.js';
import { QaTargetFailure } from './qa-session.js';
import { withCleanup } from '../diagnostics/cleanup.js';
import type { DeliveryOperations } from './operations.js';

/** Builds role-specific agent inputs and bounds each live agent session. */
export function createDeliveryAgents(
  options: DeliveryOptions,
  recordCleanup: DeliveryOperations['recordCleanup'],
) {
  const implement = createImplementation(options.model, options.apiKey);
  const figma = createFigma(options.model, options.apiKey);
  const qa = createQa(options.model, options.apiKey);
  const sandboxQa = createSandboxQa(options.model, options.apiKey);
  const review = createReview(options.model, options.apiKey);
  const summarize = createSummary(options.model, options.apiKey);
  const observation = {
    ...(options.observe ? { observe: options.observe } : {}),
    ...(options.debug ? { debug: options.debug } : {}),
  };
  return {
    figma: async (
      run: RunResources,
      state: DeliveryState,
      workspace: Workspace,
      signal: AbortSignal,
    ) => {
      if (!state.figma)
        throw new Error('Figma scaffolding requires design sources.');
      const sources = state.figma.sources;
      options.progress('Scaffolding UI from Figma');
      return withCleanup(
        async () => {
          signal.throwIfAborted();
          if (!options.figmaToken?.trim())
            return {
              summary:
                'UI scaffolding is blocked by missing Figma credentials.',
              components: [],
              designSystem: [],
              implementationNotes: [],
              limitations: [],
              blockers: [
                `Set ${options.figma?.tokenEnv ?? 'FIGMA_ACCESS_TOKEN'} in your environment or .env to read the linked Figma designs.`,
              ],
            };
          const tools = createFigmaTools({
            sources,
            token: options.figmaToken,
            auth: options.figma?.auth ?? 'personal',
            signal,
          });
          const result = await figma({
            context: {
              task: createIssueTask(state.brief),
              allowedPaths: run.project.allowedPaths,
              sources,
            },
            workspace,
            tools: {
              figma: tools.figma,
              test: createTestTool({
                run: createProgressTestRunner(run, options),
                signal,
              }),
            },
            signal,
            ...observation,
          });
          signal.throwIfAborted();
          return {
            ...result,
            blockers: [
              ...result.blockers,
              ...tools
                .unreadSources()
                .map(
                  ({ url }) =>
                    `Required Figma source was not inspected: ${url}`,
                ),
            ],
          };
        },
        () => workspace.stop(),
        (error) => recordCleanup('figma workspace', error),
      );
    },
    implement: async (
      run: RunResources,
      state: DeliveryState,
      signal: AbortSignal,
    ) => {
      options.progress(
        `Implementing (attempt ${state.implementationAttempts.length + 1})`,
      );
      return withCleanup(
        async () => {
          const previous = state.round === 0 ? null : currentRound(state);
          return await implement({
            context: implementationContext(
              state,
              run.project,
              await readFailedCheckLogs(
                previous?.evidence.filter(
                  (record) => record.revision === previous.revision,
                ) ?? [],
              ),
            ),
            workspace: run.implementationWorkspace,
            tools: {
              test: createTestTool({
                run: createProgressTestRunner(run, options),
                signal,
              }),
            },
            signal,
            ...observation,
          });
        },
        () => run.implementationSandbox.stop(),
        (error) => recordCleanup('implementation sandbox', error),
      );
    },
    qa: async (
      run: RunResources,
      round: RoundResources,
      state: DeliveryState,
      signal: AbortSignal,
      phase: 'initial' | 'follow-up' = 'initial',
    ) => {
      const followUp = phase === 'follow-up';
      options.progress(
        followUp
          ? 'Verifying remaining visual criteria (browser/mobile)'
          : 'Verifying acceptance criteria (browser/mobile)',
      );
      const qaSession = followUp ? round.followUpQaSession : round.qaSession;
      if (!qaSession)
        throw new Error('UI follow-up requires a fresh QA session.');
      const context = qaContext(
        state,
        round.project,
        round.evidence.records,
        round.references,
        phase,
      );
      return withCleanup(
        async () => {
          try {
            await qaSession.start(signal);
            const tools = createQaTools({
              project: round.project,
              automationSandbox: run.automationSandbox,
              evidence: round.evidence,
              session: `${run.runId}-r${round.round}${followUp ? '-follow-up' : ''}`,
              browserConfig: run.browserConfig,
              signal,
              references: round.references,
              phase,
            });
            const report = await qa({
              context,
              tools,
              signal,
              ...observation,
            });
            await qaSession.assertRunning();
            return report;
          } catch (error) {
            signal.throwIfAborted();
            if (!(error instanceof QaTargetFailure)) throw error;
            return {
              verdict: 'changes-requested',
              criteria: context.acceptanceCriteria.map(({ id }) => ({
                id,
                status: 'blocked',
                evidenceIds: [error.evidence.id],
                notes:
                  'The configured QA server failed. Acceptance behavior was not verified.',
              })),
              findings: [
                {
                  source: 'qa',
                  kind: 'defect',
                  severity: 'blocking',
                  description: error.message,
                  criterionId: null,
                  evidenceIds: [error.evidence.id],
                },
              ],
            };
          }
        },
        () => qaSession.close(),
        (error) => recordCleanup('browser/mobile QA session', error),
      );
    },
    sandboxQa: async (
      round: RoundResources,
      state: DeliveryState,
      signal: AbortSignal,
    ) => {
      options.progress('Verifying remaining acceptance criteria (sandbox)');
      return withCleanup(
        async () => {
          return await sandboxQa({
            context: sandboxQaContext(
              state,
              round.project,
              round.evidence.records,
              round.references,
            ),
            workspace: round.sandboxQaWorkspace,
            evidenceTool: createQaEvidenceTool(round.evidence),
            signal,
            ...observation,
          });
        },
        () => round.sandboxQaWorkspace.stop(),
        (error) => recordCleanup('sandbox QA workspace', error),
      );
    },
    review: async (
      run: RunResources,
      state: DeliveryState,
      signal: AbortSignal,
    ) => {
      const round = currentRound(state);
      options.progress('Reviewing code');
      return withCleanup(
        async () => {
          const patch = await run.repository.git(
            [
              'diff',
              '--no-ext-diff',
              '--no-textconv',
              '--no-renames',
              state.baseRevision,
              round.revision,
            ],
            signal,
          );
          return await review({
            context: reviewContext(state, run.project, patch),
            workspace: run.reviewWorkspace,
            signal,
            ...observation,
          });
        },
        () => run.reviewWorkspace.stop(),
        (error) => recordCleanup('review workspace', error),
      );
    },
    summarize: (
      _run: RunResources,
      state: DeliveryState,
      signal: AbortSignal,
    ) => {
      options.progress('Writing PR summary');
      return summarize({
        context: summaryContext(state),
        signal,
        ...observation,
      });
    },
  };
}

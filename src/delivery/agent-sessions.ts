import { createImplementation } from '../agents/implementation.js';
import { createQa } from '../agents/qa.js';
import { createReview } from '../agents/review.js';
import { createSummary } from '../agents/summary.js';
import type { DeliveryState } from '../contracts/delivery.js';
import { createQaTools } from '../tools/qa.js';
import {
  implementationContext,
  qaContext,
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

/** Builds role-specific agent inputs and bounds each live agent session. */
export function createDeliveryAgents(options: DeliveryOptions) {
  const implement = createImplementation(options.model, options.apiKey);
  const qa = createQa(options.model, options.apiKey);
  const review = createReview(options.model, options.apiKey);
  const summarize = createSummary(options.model, options.apiKey);
  const observation = options.observe ? { observe: options.observe } : {};
  return {
    implement: async (
      run: RunResources,
      state: DeliveryState,
      signal: AbortSignal,
    ) => {
      options.progress(`Implementing (round ${state.round + 1})`);
      try {
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
          signal,
          ...observation,
        });
      } finally {
        await run.implementationSandbox.stop();
      }
    },
    qa: async (
      run: RunResources,
      round: RoundResources,
      state: DeliveryState,
      signal: AbortSignal,
    ) => {
      options.progress('Verifying acceptance criteria');
      try {
        await round.qaSession.start(signal);
        const tools = createQaTools({
          project: round.project,
          automationSandbox: run.automationSandbox,
          evidence: round.evidence,
          session: `${run.runId}-r${round.round}`,
          browserConfig: run.browserConfig,
          signal,
        });
        const report = await qa({
          context: qaContext(state, round.project, round.evidence.records),
          tools,
          signal,
          ...observation,
        });
        round.qaSession.assertRunning();
        return report;
      } finally {
        await round.qaSession.close();
      }
    },
    review: async (
      run: RunResources,
      state: DeliveryState,
      signal: AbortSignal,
    ) => {
      const round = currentRound(state);
      options.progress('Reviewing code');
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
      if (patch.length > 160_000)
        throw new Error(
          'Patch is too large for the initial review workflow. Split the issue.',
        );
      return review({
        context: reviewContext(state, run.project, patch),
        workspace: run.verificationWorkspace,
        signal,
        ...observation,
      });
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

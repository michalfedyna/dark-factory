import { createDeliveryAgents } from './agent-sessions.js';
import { runChecks } from './checks.js';
import type { DeliveryOptions } from './context.js';
import { createDeliveryEnvironment } from './environment.js';
import { finishDelivery } from './finish.js';
import type { DeliveryOperations } from './operations.js';
import { validateQa } from './qa-policy.js';
import { currentRound } from './state.js';

export function createDeliveryRuntime(options: DeliveryOptions) {
  const environment = createDeliveryEnvironment(options);
  const agents = createDeliveryAgents(options, environment.artifacts.cleanup);
  const operations: DeliveryOperations = {
    prepare: environment.prepare,
    figma: (state, signal) =>
      agents.figma(
        environment.requireRun(),
        state,
        environment.createFigmaWorkspace(),
        signal,
      ),
    implement: (state, signal) =>
      agents.implement(environment.requireRun(), state, signal),
    capture: (signal) => environment.requireRun().repository.capture(signal),
    checks: async (round, signal) => {
      const run = environment.requireRun();
      options.progress('Running checks');
      return runChecks(
        run,
        await environment.beginRound(round),
        round,
        signal,
        options.observe,
      );
    },
    qa: (state, signal) =>
      agents.qa(
        environment.requireRun(),
        environment.requireRound(currentRound(state)),
        state,
        signal,
      ),
    sandboxQa: (state, signal) =>
      agents.sandboxQa(
        environment.requireRound(currentRound(state)),
        state,
        signal,
      ),
    followUpQa: (state, signal) => {
      environment.createFollowUpQaSession(currentRound(state));
      return agents.qa(
        environment.requireRun(),
        environment.requireRound(currentRound(state)),
        state,
        signal,
        'follow-up',
      );
    },
    validateQa: (state, _signal, phase) => {
      const round = currentRound(state);
      const resources = environment.requireRound(round);
      return Promise.resolve(
        validateQa(
          state.brief,
          {
            ...round,
            evidence: [...resources.evidence.records],
          },
          resources.project.targets,
          phase,
        ),
      );
    },
    review: (state, signal) =>
      agents.review(environment.requireRun(), state, signal),
    assertUnchanged: (revision, signal) =>
      environment.requireRun().repository.assertUnchanged(revision, signal),
    summarize: (state, signal) =>
      agents.summarize(environment.requireRun(), state, signal),
    finish: (state, signal) =>
      finishDelivery(environment.requireRun(), options, state, signal),
    record: (state) => environment.artifacts.record(state, options.observe),
    recordFailure: environment.recordFailure,
    recordStep: environment.artifacts.step,
    recordCleanup: environment.artifacts.cleanup,
    endDiagnostics: environment.artifacts.end,
  };
  return { operations, close: environment.close };
}

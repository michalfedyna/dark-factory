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
  const agents = createDeliveryAgents(options);
  const operations: DeliveryOperations = {
    maxRepairRounds: 3,
    prepare: environment.prepare,
    implement: (state, signal) =>
      agents.implement(environment.requireRun(), state, signal),
    capture: (signal) => environment.requireRun().repository.capture(signal),
    checks: (round, signal) => {
      const run = environment.requireRun();
      options.progress('Running checks');
      return runChecks(
        run,
        environment.beginRound(round),
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
    validateQa: (state) => {
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
    record: (state) =>
      environment.requireRun().artifacts.record(state, options.observe),
  };
  return { operations, close: environment.close };
}

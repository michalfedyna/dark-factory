import { createWorkflow } from '@mastra/core/workflows';
import type { Explore } from '../agents/exploration.js';
import {
  deliveryResultSchema,
  deliveryStateSchema,
} from '../contracts/delivery.js';
import { deliveryGate } from '../delivery/policy.js';
import {
  checkCandidate,
  implementCandidate,
  reviewCandidate,
  summarizeCandidate,
  verifyCandidate,
  verifySandboxCandidate,
} from '../delivery/steps.js';
import {
  createExploreStep,
  deliveryStep,
  finish,
  inputSchema,
  prepare,
  requestContextSchema,
} from './steps.js';

export function createDefaultWorkflow(dependencies: { explore: Explore }) {
  const cycle = createWorkflow({
    id: 'delivery-cycle',
    inputSchema: deliveryStateSchema,
    outputSchema: deliveryStateSchema,
    requestContextSchema,
    retryConfig: { attempts: 0 },
  })
    .then(deliveryStep('implement', implementCandidate))
    .then(deliveryStep('run-checks', checkCandidate))
    .then(deliveryStep('qa', verifyCandidate))
    .then(deliveryStep('sandbox-qa', verifySandboxCandidate))
    .then(deliveryStep('review', reviewCandidate))
    .then(
      deliveryStep('delivery-gate', (state) =>
        Promise.resolve(deliveryGate(state)),
      ),
    )
    .commit();

  // Populate optional Workflow metadata to satisfy Step's exact optional types.
  const loop = Object.assign(cycle, {
    description: 'Implement, verify, and review a candidate.',
    metadata: {},
  });
  return createWorkflow({
    id: 'default',
    inputSchema,
    outputSchema: deliveryResultSchema,
    requestContextSchema,
    retryConfig: { attempts: 0 },
    options: { validateInputs: true, autoRestartActiveRuns: false },
  })
    .then(createExploreStep(dependencies.explore))
    .then(prepare)
    .dountil(loop, ({ inputData }) =>
      Promise.resolve(deliveryStateSchema.parse(inputData).status !== 'repair'),
    )
    .then(deliveryStep('summarize', summarizeCandidate))
    .then(finish)
    .commit();
}

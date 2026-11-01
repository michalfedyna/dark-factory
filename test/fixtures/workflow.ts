import { Mastra } from '@mastra/core/mastra';
import { RequestContext } from '@mastra/core/request-context';
import { afterEach, vi } from 'vitest';
import type { Explore } from '../../src/agents/exploration.js';
import type { Ask } from '../../src/contracts/interaction.js';
import { runDefault } from '../../src/factory/run.js';
import { validateQa } from '../../src/delivery/qa-policy.js';
import type { DeliveryOperations } from '../../src/delivery/operations.js';
import { createDefaultWorkflow } from '../../src/workflows/default.js';
import { brief } from './brief.js';
import { verificationPlan } from './delivery.js';

const factories: Mastra[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(factories.splice(0).map((mastra) => mastra.shutdown()));
});

export const qaPass = {
  verdict: 'pass',
  criteria: [
    {
      id: 'AC1',
      status: 'pass',
      evidenceIds: ['test'],
      notes: 'Verified the CSV journey.',
    },
  ],
  findings: [],
};
export const reviewPass = {
  verdict: 'pass',
  summary: 'Reviewed the diff and tests.',
  findings: [],
};
export const summary = {
  title: 'feat: export filtered issues',
  changes: ['Add CSV export.'],
  testing: ['CSV checks and independent QA passed.'],
  limitations: [],
};

export function createWorkflowSetup(
  explore: Explore = () => Promise.resolve(brief),
) {
  let captureCount = 0;
  const operations = {
    maxRepairRounds: 3,
    prepare: vi.fn<DeliveryOperations['prepare']>().mockResolvedValue('base'),
    implement: vi.fn<DeliveryOperations['implement']>().mockResolvedValue({
      summary: 'Implemented CSV export and tests.',
      blockers: [],
      verification: verificationPlan,
    }),
    capture: vi.fn<DeliveryOperations['capture']>().mockImplementation(() => {
      captureCount++;
      return Promise.resolve({
        revision: `revision-${captureCount}`,
        tree: `tree-${captureCount}`,
      });
    }),
    checks: vi.fn<DeliveryOperations['checks']>().mockImplementation((round) =>
      Promise.resolve({
        ...round,
        evidence: [
          {
            id: 'test',
            revision: round.revision,
            kind: 'check',
            targetId: null,
            operation: 'test',
            exitCode: 0,
            path: 'test.json',
          },
        ],
      }),
    ),
    qa: vi.fn<DeliveryOperations['qa']>().mockResolvedValue(qaPass),
    validateQa: vi
      .fn<DeliveryOperations['validateQa']>()
      .mockImplementation((state) =>
        Promise.resolve(validateQa(state.brief, state.history.at(-1)!, [])),
      ),
    review: vi.fn<DeliveryOperations['review']>().mockResolvedValue(reviewPass),
    assertUnchanged: vi
      .fn<DeliveryOperations['assertUnchanged']>()
      .mockResolvedValue(),
    summarize: vi
      .fn<DeliveryOperations['summarize']>()
      .mockResolvedValue(summary),
    finish: vi.fn<DeliveryOperations['finish']>().mockImplementation((state) =>
      Promise.resolve({
        schemaVersion: '1.0',
        runId: 'run',
        status: state.status === 'blocked' ? 'blocked' : 'ready',
        reason: state.reason,
        baseRevision: state.baseRevision,
        revision: state.history.at(-1)?.revision ?? null,
        rounds: state.round,
        runDirectory: 'runs/run',
        summary: state.summary,
        pullRequestUrl: null,
      }),
    ),
    record: vi.fn<DeliveryOperations['record']>().mockResolvedValue(),
  } satisfies DeliveryOperations;
  const mastra = new Mastra({
    logger: false,
    workflows: { default: createDefaultWorkflow({ explore }) },
  });
  factories.push(mastra);
  const close = vi.fn<() => Promise<void>>().mockResolvedValue();
  const runtime = vi.fn((runId: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    return {
      operations: {
        ...operations,
        get maxRepairRounds() {
          return operations.maxRepairRounds;
        },
        finish: async (...args: Parameters<DeliveryOperations['finish']>) => ({
          ...(await operations.finish(...args)),
          runId,
          runDirectory: `runs/${runId}`,
        }),
      },
      close,
    };
  });
  const options = {
    issue: 'Export issues',
    ask: vi.fn<Ask>().mockResolvedValue(' CSV '),
    progress: vi.fn<(message: string) => void>(),
    onDeliveryStart: vi.fn<(signal: AbortSignal) => void>(),
    workflow: mastra.getWorkflow('default'),
    runtime,
    signal: new AbortController().signal,
    timeoutMs: 30_000,
  };
  return {
    ...options,
    options,
    operations,
    explore,
    close,
    run: () => runDefault(options),
    requestContext: (runId: string) => {
      const nativeRuntime = runtime(runId, options.signal);
      return new RequestContext<{
        ask: Ask;
        progress: (message: string) => void;
        onDeliveryStart?: (() => void) | undefined;
        operations: DeliveryOperations;
        signal: AbortSignal;
      }>([
        ['ask', options.ask],
        ['progress', options.progress],
        ['onDeliveryStart', () => options.onDeliveryStart(options.signal)],
        ['operations', nativeRuntime.operations],
        ['signal', options.signal],
      ]);
    },
  };
}

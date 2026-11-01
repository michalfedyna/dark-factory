import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSandbox } from '@mastra/core/workspace';
import { afterEach, expect, test, vi } from 'vitest';
import { qaSchema, type DeliveryRound } from '../src/contracts/delivery.js';
import { createEvidence } from '../src/delivery/evidence.js';
import {
  combineQaReports,
  needsSandboxQa,
} from '../src/delivery/qa-handoff.js';
import { validateQa } from '../src/delivery/qa-policy.js';
import { recordSandboxQaCommands } from '../src/delivery/sandbox-qa-evidence.js';
import { createQaEvidenceTool } from '../src/tools/qa-evidence.js';
import { candidateState } from './fixtures/delivery.js';
import { createWorkflowSetup, qaPass } from './fixtures/workflow.js';

const blocked = qaSchema.parse({
  verdict: 'blocked',
  criteria: [
    {
      id: 'AC1',
      status: 'blocked',
      evidenceIds: [],
      notes: 'Needs CLI access.',
    },
  ],
  findings: [
    {
      source: 'qa',
      kind: 'question',
      severity: 'blocking',
      criterionId: 'AC1',
      description: 'Cannot check the CLI from browser/mobile.',
      evidenceIds: [],
    },
  ],
});
const sandboxPass = qaSchema.parse({
  ...qaPass,
  criteria: [{ ...qaPass.criteria[0], evidenceIds: ['sandbox-command'] }],
});

function sandboxWorkflow() {
  const setup = createWorkflowSetup();
  setup.operations.qa.mockResolvedValue(blocked);
  setup.operations.sandboxQa.mockResolvedValue(sandboxPass);
  setup.operations.validateQa.mockImplementation((state, _signal, phase) => {
    const round = state.history.at(-1)!;
    return Promise.resolve(
      validateQa(
        state.brief,
        {
          ...round,
          evidence: round.sandboxQa
            ? [
                ...round.evidence,
                {
                  id: 'sandbox-command',
                  revision: round.revision,
                  kind: 'sandbox',
                  targetId: null,
                  operation: 'execute-command',
                  exitCode: 0,
                  path: 'sandbox.json',
                },
              ]
            : round.evidence,
        },
        [],
        phase,
      ),
    );
  });
  return setup;
}

test('browser/mobile QA completes before sandbox QA, which resolves only untestable criteria', async () => {
  const { run, operations } = sandboxWorkflow();
  await expect(run()).resolves.toMatchObject({ status: 'ready', rounds: 1 });
  expect(operations.qa).toHaveBeenCalledOnce();
  expect(operations.sandboxQa).toHaveBeenCalledOnce();
  expect(operations.qa.mock.invocationCallOrder[0]).toBeLessThan(
    operations.sandboxQa.mock.invocationCallOrder[0]!,
  );
  expect(operations.sandboxQa.mock.calls[0]?.[0].history[0]?.qa).toEqual(
    blocked,
  );
  const round = operations.review.mock.calls[0]?.[0].history[0];
  expect(round).toMatchObject({
    browserQa: blocked,
    sandboxQa: sandboxPass,
    qa: { verdict: 'pass' },
    findings: [],
  });
});

test.each(['pass', 'fail'] as const)(
  'sandbox QA is skipped when primary QA has only %s criteria',
  async (status) => {
    const { run, operations } = createWorkflowSetup();
    if (status === 'fail')
      operations.qa.mockResolvedValueOnce({
        ...qaPass,
        verdict: 'changes-requested',
        criteria: [{ ...qaPass.criteria[0], status }],
      });
    await run();
    expect(operations.sandboxQa).not.toHaveBeenCalled();
  },
);

test('sandbox failures return to implementation and both QA stages rerun on the repaired candidate', async () => {
  const { run, operations } = sandboxWorkflow();
  operations.sandboxQa.mockResolvedValueOnce({
    ...sandboxPass,
    verdict: 'changes-requested',
    criteria: [{ ...sandboxPass.criteria[0], status: 'fail' }],
  });
  await expect(run()).resolves.toMatchObject({ status: 'ready', rounds: 2 });
  expect(operations.implement).toHaveBeenCalledTimes(2);
  expect(operations.qa).toHaveBeenCalledTimes(2);
  expect(operations.sandboxQa).toHaveBeenCalledTimes(2);
  expect(operations.review).toHaveBeenCalledOnce();
});

test('unresolved sandbox QA remains blocked and cannot reach review or summary', async () => {
  const { run, operations } = sandboxWorkflow();
  operations.sandboxQa.mockResolvedValue(blocked);
  await expect(run()).resolves.toMatchObject({ status: 'blocked', rounds: 1 });
  expect(operations.review).not.toHaveBeenCalled();
  expect(operations.summarize).not.toHaveBeenCalled();
});

test.each([
  { ...sandboxPass, criteria: [{ ...sandboxPass.criteria[0], id: 'unknown' }] },
  {
    ...sandboxPass,
    criteria: [{ ...sandboxPass.criteria[0], evidenceIds: ['invented'] }],
  },
  {
    ...sandboxPass,
    criteria: [{ ...sandboxPass.criteria[0], evidenceIds: ['test'] }],
  },
  {
    ...sandboxPass,
    criteria: [{ ...sandboxPass.criteria[0], status: 'blocked' }],
  },
])('invalid fallback cannot authorize delivery: %j', async (report) => {
  const { run, operations, close } = sandboxWorkflow();
  operations.sandboxQa.mockResolvedValue(report);
  await expect(run()).rejects.toThrow('Workflow failed');
  expect(operations.review).not.toHaveBeenCalled();
  expect(operations.finish).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

test('candidate mutations during sandbox QA invalidate verification', async () => {
  const { run, operations } = sandboxWorkflow();
  operations.assertUnchanged
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error('Candidate changed.'));
  await expect(run()).rejects.toThrow('Workflow failed');
  expect(operations.sandboxQa).toHaveBeenCalledOnce();
  expect(operations.review).not.toHaveBeenCalled();
});

test('cancelling pending sandbox QA closes the run and prevents late results reaching review', async () => {
  const { run, options, operations, close } = sandboxWorkflow();
  const controller = new AbortController();
  options.signal = controller.signal;
  let started = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let complete: (value: unknown) => void = () => {};
  operations.sandboxQa.mockImplementation(() => {
    started();
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  const running = run();
  await ready;
  controller.abort(new Error('Stopped by user.'));
  await expect(running).rejects.toThrow('Stopped by user.');
  complete(sandboxPass);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(operations.review).not.toHaveBeenCalled();
  expect(operations.finish).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

test('handoff preserves UI passes, failures, defects, and unrelated global blockers', () => {
  const browserQa = qaSchema.parse({
    ...blocked,
    criteria: [
      ...blocked.criteria,
      { ...qaPass.criteria[0], id: 'AC2' },
      { ...qaPass.criteria[0], id: 'AC3', status: 'fail' },
    ],
    findings: [
      ...blocked.findings,
      {
        source: 'qa',
        kind: 'defect',
        severity: 'blocking',
        criterionId: 'AC3',
        description: 'Observed a broken UI.',
        evidenceIds: ['test'],
      },
    ],
  });
  expect(needsSandboxQa(browserQa, [])).toBe(true);
  const result = combineQaReports(browserQa, sandboxPass);
  expect(result.criteria.map(({ status }) => status)).toEqual([
    'pass',
    'pass',
    'fail',
  ]);
  expect(result.criteria.slice(1)).toEqual(browserQa.criteria.slice(1));
  expect(result.findings).toEqual(browserQa.findings.slice(1));
  expect(result.verdict).toBe('changes-requested');
  browserQa.findings.push({ ...blocked.findings[0]!, criterionId: null });
  expect(combineQaReports(browserQa, sandboxPass).verdict).toBe('blocked');
  expect(() =>
    combineQaReports(
      browserQa,
      qaSchema.parse({
        ...sandboxPass,
        criteria: [...sandboxPass.criteria, browserQa.criteria[1]],
      }),
    ),
  ).toThrow('only blocked');
});

test('a crashed candidate server returns to implementation instead of sandbox escalation', () => {
  expect(
    needsSandboxQa(
      {
        ...blocked,
        verdict: 'changes-requested',
        findings: [
          { ...blocked.findings[0]!, kind: 'defect', criterionId: null },
        ],
      },
      [
        {
          id: 'server-failure',
          revision: 'revision',
          kind: 'check',
          targetId: 'web',
          operation: 'qa-server-web',
          exitCode: 1,
          path: 'server.json',
        },
      ],
    ),
  ).toBe(false);
});

test('sandbox QA cannot replace required UI captures or cite stale or failed commands', () => {
  const state = candidateState();
  const round: DeliveryRound = {
    ...state.history[0]!,
    browserQa: blocked,
    sandboxQa: sandboxPass,
    qa: combineQaReports(blocked, sandboxPass),
  };
  const record = {
    id: 'sandbox-command',
    revision: round.revision,
    kind: 'sandbox' as const,
    targetId: null,
    operation: 'execute-command',
    exitCode: 0,
    path: 'sandbox.json',
  };
  round.evidence.push(record);
  const web = {
    id: 'web',
    kind: 'web' as const,
    url: 'http://localhost:3000',
    start: { command: 'node', args: ['server.js'] },
    screenshots: true,
  };
  expect(() => validateQa(state.brief, round, [web])).toThrow('open evidence');
  record.revision = 'old';
  expect(() => validateQa(state.brief, round, [])).toThrow('stale');
  record.revision = round.revision;
  record.exitCode = 1;
  expect(() => validateQa(state.brief, round, [])).toThrow('failed');
});

const resources: { directory: string; sandbox: LocalSandbox }[] = [];
afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async ({ directory, sandbox }) => {
      await sandbox.destroy();
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function sandboxSetup() {
  const directory = await mkdtemp(join(tmpdir(), 'darkfactory-sandbox-qa-'));
  const sandbox = new LocalSandbox({ workingDirectory: directory, timeout: 0 });
  resources.push({ directory, sandbox });
  const evidence = createEvidence(join(directory, 'evidence'), 'candidate', 2);
  return { sandbox, evidence };
}

test.each([0, 7])(
  'native command exit %s is captured as revision-bound sandbox evidence',
  async (exitCode) => {
    const { sandbox, evidence } = await sandboxSetup();
    recordSandboxQaCommands(sandbox, evidence);
    const result = await sandbox.executeCommand?.(process.execPath, [
      '-e',
      `console.log('observed behavior'); process.exit(${exitCode});`,
    ]);
    expect(result?.exitCode).toBe(exitCode);
    expect(evidence.records).toEqual([
      expect.objectContaining({
        id: 'r2-e1',
        revision: 'candidate',
        kind: 'sandbox',
        exitCode,
      }),
    ]);
    expect(
      JSON.parse(await readFile(evidence.records[0]!.path, 'utf8')),
    ).toMatchObject({
      output: {
        command: process.execPath,
        stdout: 'observed behavior\n',
        exitCode,
      },
    });
    const tool = createQaEvidenceTool(evidence);
    await expect(tool.execute?.({}, {})).resolves.toEqual([
      expect.objectContaining({
        id: 'r2-e1',
        exitCode,
      }),
    ]);
  },
);

test('thrown command errors are recorded without turning them into successful evidence', async () => {
  const { sandbox, evidence } = await sandboxSetup();
  vi.spyOn(sandbox, 'executeCommand').mockRejectedValueOnce(
    new Error('Unavailable'),
  );
  recordSandboxQaCommands(sandbox, evidence);
  await expect(sandbox.executeCommand?.('unavailable')).rejects.toThrow(
    'Unavailable',
  );
  expect(evidence.records[0]?.exitCode).toBe(1);
});

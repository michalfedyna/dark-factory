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
                ...(round.followUpQa
                  ? [
                      {
                        id: 'ui-follow-up',
                        revision: round.revision,
                        kind: 'device' as const,
                        qaPhase: 'follow-up' as const,
                        targetId: 'ios',
                        operation: 'snapshot',
                        exitCode: 0,
                        path: 'follow-up.json',
                      },
                    ]
                  : []),
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
  expect(operations.sandboxQa.mock.calls[0]?.[0].history[0]?.qa).toMatchObject(
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
  expect(operations.followUpQa).not.toHaveBeenCalled();
});

function visualHandoff(observedDefect = false) {
  const setup = sandboxWorkflow();
  const initial = qaSchema.parse({
    ...blocked,
    criteria: observedDefect
      ? [{ ...blocked.criteria[0]!, status: 'fail', evidenceIds: ['test'] }]
      : blocked.criteria,
    findings: [
      {
        ...blocked.findings[0],
        description: 'Network calls are not observable.',
      },
      {
        ...blocked.findings[0],
        description: 'Native design comparison needs the reference.',
      },
      ...(observedDefect
        ? [
            {
              source: 'qa',
              kind: 'defect',
              severity: 'blocking',
              criterionId: 'AC1',
              evidenceIds: ['test'],
              description: 'Checkout control is visibly clipped.',
            },
          ]
        : []),
    ],
  });
  setup.operations.qa.mockResolvedValue(qaPass).mockResolvedValueOnce(initial);
  setup.operations.sandboxQa.mockResolvedValue({
    ...blocked,
    findings: [],
    resolvedQuestions: [
      {
        questionId: 'ui-1',
        evidenceIds: ['sandbox-command'],
        notes: 'Observed no service calls in the independent harness.',
      },
    ],
    uiFollowUp: {
      criterionIds: ['AC1'],
      notes:
        'Compare the native screen with design-1. The runtime harness cannot establish native appearance.',
    },
  });
  setup.operations.followUpQa.mockResolvedValue({
    ...qaPass,
    criteria: [{ ...qaPass.criteria[0], evidenceIds: ['ui-follow-up'] }],
    resolvedQuestions: [
      {
        questionId: 'ui-2',
        evidenceIds: ['ui-follow-up'],
        notes: 'Compared the candidate on-device with the supplied reference.',
      },
    ],
  });
  return { ...setup, initial };
}

test('targeted UI follow-up uses sandbox discoveries before the gate without losing an observed defect', async () => {
  const { run, operations } = visualHandoff(true);
  await expect(run()).resolves.toMatchObject({ status: 'ready', rounds: 2 });
  expect(operations.followUpQa).toHaveBeenCalledOnce();
  expect(operations.sandboxQa.mock.invocationCallOrder[0]).toBeLessThan(
    operations.followUpQa.mock.invocationCallOrder[0]!,
  );
  expect(operations.followUpQa.mock.invocationCallOrder[0]).toBeLessThan(
    operations.implement.mock.invocationCallOrder[1]!,
  );
  const repair = operations.implement.mock.calls[1]?.[0].history[0];
  expect(repair?.qa).toMatchObject({
    verdict: 'changes-requested',
    criteria: [{ id: 'AC1', status: 'fail' }],
    findings: [{ kind: 'defect' }],
  });
  expect(operations.review).toHaveBeenCalledOnce();
});

test('unresolved targeted UI follow-up remains blocked without repeating QA or authorizing review', async () => {
  const { run, operations } = visualHandoff();
  operations.followUpQa.mockResolvedValue({ ...blocked, findings: [] });
  await expect(run()).resolves.toMatchObject({ status: 'blocked', rounds: 1 });
  expect(operations.followUpQa).toHaveBeenCalledOnce();
  expect(operations.implement).toHaveBeenCalledOnce();
  expect(operations.review).not.toHaveBeenCalled();
});

test.each(['old-evidence', 'unknown-criterion', 'mutation'] as const)(
  'unsafe UI follow-up cannot reach review (%s)',
  async (scenario) => {
    const { run, operations } = visualHandoff();
    if (scenario === 'old-evidence')
      operations.followUpQa.mockResolvedValue({
        ...qaPass,
        criteria: [{ ...qaPass.criteria[0], evidenceIds: ['test'] }],
      });
    if (scenario === 'unknown-criterion')
      operations.sandboxQa.mockResolvedValue({
        ...blocked,
        uiFollowUp: { criterionIds: ['unknown'], notes: 'Invalid handoff.' },
      });
    if (scenario === 'mutation')
      operations.assertUnchanged.mockImplementation(() =>
        operations.followUpQa.mock.calls.length
          ? Promise.reject(new Error('Candidate changed.'))
          : Promise.resolve(),
      );
    await expect(run()).rejects.toThrow('Workflow failed');
    expect(operations.review).not.toHaveBeenCalled();
    expect(operations.finish).not.toHaveBeenCalled();
    if (scenario === 'unknown-criterion')
      expect(operations.followUpQa).not.toHaveBeenCalled();
  },
);

test('question resolution removes only the verified portion of a still-blocked criterion', () => {
  const initial = qaSchema.parse({
    ...blocked,
    findings: [
      { ...blocked.findings[0], id: 'network' },
      { ...blocked.findings[0], id: 'visual' },
    ],
  });
  const fallback = qaSchema.parse({
    ...blocked,
    findings: [],
    resolvedQuestions: [
      {
        questionId: 'network',
        evidenceIds: ['sandbox-command'],
        notes: 'Observed the network behavior.',
      },
    ],
  });
  const result = combineQaReports(initial, fallback);
  expect(result).toMatchObject({
    verdict: 'blocked',
    findings: [{ id: 'visual' }],
  });
  const state = candidateState();
  const round = state.history[0]!;
  round.browserQa = initial;
  round.sandboxQa = fallback;
  round.qa = result;
  const evidence = {
    id: 'sandbox-command',
    revision: round.revision,
    kind: 'sandbox' as const,
    targetId: null,
    operation: 'execute-command',
    exitCode: 0,
    path: 'sandbox.json',
  };
  round.evidence.push(evidence);
  expect(() => validateQa(state.brief, round, [])).not.toThrow();
  evidence.exitCode = 1;
  expect(() => validateQa(state.brief, round, [])).toThrow(
    'successful current tester evidence',
  );
  evidence.exitCode = 0;
  evidence.revision = 'old';
  expect(() => validateQa(state.brief, round, [])).toThrow(
    'successful current tester evidence',
  );
  expect(() =>
    combineQaReports(initial, {
      ...fallback,
      resolvedQuestions: [
        { ...fallback.resolvedQuestions![0]!, questionId: 'unknown' },
      ],
    }),
  ).toThrow('only supplied');
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

test.each(['sandboxQa', 'followUpQa'] as const)(
  'cancelling pending %s closes the run and prevents late results reaching review',
  async (stage) => {
    const { run, options, operations, close } =
      stage === 'sandboxQa' ? sandboxWorkflow() : visualHandoff();
    const controller = new AbortController();
    options.signal = controller.signal;
    let started = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let complete: (value: unknown) => void = () => {};
    operations[stage].mockImplementation(() => {
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
  },
);

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
      { ...blocked.findings[0], id: 'ui-question', criterionId: 'AC3' },
    ],
  });
  expect(needsSandboxQa(browserQa, [])).toBe(true);
  const partialPass = qaSchema.parse({
    ...sandboxPass,
    criteria: [
      ...sandboxPass.criteria,
      { ...sandboxPass.criteria[0], id: 'AC3' },
    ],
  });
  const result = combineQaReports(browserQa, partialPass);
  expect(result.criteria.map(({ status }) => status)).toEqual([
    'pass',
    'pass',
    'fail',
  ]);
  expect(result.criteria[1]).toEqual(browserQa.criteria[1]);
  expect(result.criteria[2]).toMatchObject({
    id: 'AC3',
    status: 'fail',
    evidenceIds: ['test', 'sandbox-command'],
  });
  expect(result.findings).toEqual([browserQa.findings[1]]);
  expect(result.verdict).toBe('changes-requested');
  const scopeChange = {
    ...blocked.findings[0]!,
    id: 'scope-change',
    kind: 'scope-change' as const,
  };
  browserQa.findings.push(scopeChange);
  const scoped = combineQaReports(browserQa, partialPass);
  expect(scoped.verdict).toBe('blocked');
  expect(scoped.findings).toContainEqual(scopeChange);
  expect(() =>
    combineQaReports(browserQa, {
      ...partialPass,
      resolvedQuestions: [
        {
          questionId: 'scope-change',
          evidenceIds: ['sandbox-command'],
          notes: 'Cannot authorize scope changes.',
        },
      ],
    }),
  ).toThrow('only supplied');
  browserQa.findings.push({ ...blocked.findings[0]!, criterionId: null });
  expect(combineQaReports(browserQa, partialPass).verdict).toBe('blocked');
  expect(() =>
    combineQaReports(
      browserQa,
      qaSchema.parse({
        ...partialPass,
        criteria: [...partialPass.criteria, browserQa.criteria[1]],
      }),
    ),
  ).toThrow('only pending');
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

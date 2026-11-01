import { describe, expect, test, vi } from 'vitest';
import { runDefault } from '../src/factory/run.js';
import type { DeliveryRound, Finding } from '../src/contracts/delivery.js';
import { validateQa } from '../src/delivery/qa-policy.js';
import { PublicationError } from '../src/integrations/github/publish.js';
import { brief } from './fixtures/brief.js';
import { implementation, uiProjectPlan } from './fixtures/delivery.js';
import {
  createWorkflowSetup as setup,
  qaPass,
  reviewPass,
  summary,
} from './fixtures/workflow.js';

const finding = (source: Finding['source'] = 'qa'): Finding => ({
  source,
  kind: 'defect',
  severity: 'blocking',
  description: 'Expected CSV escaping; actual CSV is malformed.',
  criterionId: 'AC1',
  evidenceIds: ['test'],
});
describe('default workflow delivery stages', () => {
  test('runs implementation, trusted checks, QA, review and summary before finishing', async () => {
    const { run, operations, close } = setup();
    await expect(run()).resolves.toMatchObject({
      status: 'ready',
      rounds: 1,
      summary,
    });
    expect(operations.implement).toHaveBeenCalledOnce();
    expect(operations.qa).toHaveBeenCalledOnce();
    expect(operations.review).toHaveBeenCalledOnce();
    expect(operations.summarize).toHaveBeenCalledOnce();
    expect(operations.finish.mock.calls[0]?.[0].status).toBe('approved');
    expect(close).toHaveBeenCalledOnce();
  });
  test('routes QA defects back to implementation and reruns checks and QA', async () => {
    const { run, operations } = setup();
    operations.qa.mockResolvedValueOnce({
      ...qaPass,
      verdict: 'changes-requested',
      criteria: [{ ...qaPass.criteria[0], status: 'fail' }],
      findings: [finding()],
    });
    await expect(run()).resolves.toMatchObject({ status: 'ready', rounds: 2 });
    expect(operations.implement).toHaveBeenCalledTimes(2);
    expect(operations.checks).toHaveBeenCalledTimes(2);
    expect(operations.qa).toHaveBeenCalledTimes(2);
    expect(operations.review).toHaveBeenCalledOnce();
    expect(
      operations.implement.mock.calls[1]?.[0].history[0]?.findings,
    ).toContainEqual(finding());
  });
  test('routes review defects back to implementation and invalidates prior QA and review', async () => {
    const { run, operations } = setup();
    operations.review.mockResolvedValueOnce({
      verdict: 'changes-requested',
      summary: 'Fix escaping.',
      findings: [finding('review')],
    });
    await expect(run()).resolves.toMatchObject({ status: 'ready', rounds: 2 });
    expect(operations.implement).toHaveBeenCalledTimes(2);
    expect(operations.qa).toHaveBeenCalledTimes(2);
    expect(operations.review).toHaveBeenCalledTimes(2);
    expect(operations.assertUnchanged).toHaveBeenCalledWith(
      'revision-2',
      expect.any(AbortSignal),
    );
  });
  test('failed checks return to implementation before QA and review', async () => {
    const { run, operations } = setup();
    operations.checks.mockImplementationOnce((round) =>
      Promise.resolve({ ...round, findings: [finding('checks')] }),
    );
    await expect(run()).resolves.toMatchObject({
      status: 'ready',
      rounds: 2,
    });
    expect(operations.implement).toHaveBeenCalledTimes(2);
    expect(operations.checks).toHaveBeenCalledTimes(2);
    expect(operations.qa).toHaveBeenCalledOnce();
    expect(operations.review).toHaveBeenCalledOnce();
  });
  test('QA and review repairs continue beyond the former shared repair limit', async () => {
    const { run, operations } = setup();
    for (let round = 0; round < 5; round++)
      operations.qa.mockResolvedValueOnce({
        ...qaPass,
        verdict: 'changes-requested',
        findings: [finding()],
      });
    operations.review.mockResolvedValueOnce({
      verdict: 'changes-requested',
      summary: 'Still incorrect.',
      findings: [finding('review')],
    });
    await expect(run()).resolves.toMatchObject({
      status: 'ready',
      rounds: 7,
    });
    expect(operations.implement).toHaveBeenCalledTimes(7);
    expect(operations.qa).toHaveBeenCalledTimes(7);
    expect(operations.review).toHaveBeenCalledTimes(2);
    expect(operations.summarize).toHaveBeenCalledOnce();
  });
  test.each(['qa', 'review'] as const)(
    'an unavailable %s target/context blocks without repair',
    async (role) => {
      const { run, operations } = setup();
      if (role === 'qa')
        operations.qa.mockResolvedValue({
          ...qaPass,
          verdict: 'blocked',
          criteria: [{ ...qaPass.criteria[0], status: 'blocked' }],
        });
      else
        operations.review.mockResolvedValue({
          ...reviewPass,
          verdict: 'blocked',
        });
      await expect(run()).resolves.toMatchObject({
        status: 'blocked',
        rounds: 1,
      });
      expect(operations.implement).toHaveBeenCalledOnce();
      expect(operations.summarize).not.toHaveBeenCalled();
    },
  );
  test('scope changes require human input instead of an automatic repair', async () => {
    const { run, operations } = setup();
    operations.review.mockResolvedValue({
      ...reviewPass,
      verdict: 'changes-requested',
      findings: [{ ...finding('review'), kind: 'scope-change' }],
    });
    await expect(run()).resolves.toMatchObject({
      status: 'blocked',
      rounds: 1,
      reason: finding('review').description,
    });
    expect(operations.implement).toHaveBeenCalledOnce();
  });
  test.each(['qa', 'review'] as const)(
    'blocked %s exposes actual blocking findings in the final result',
    async (role) => {
      const { run, operations } = setup();
      const blockers: Finding[] = [
        {
          ...finding(role),
          kind: 'question',
          description:
            'Mobile layout cannot be checked: viewport resizing is unavailable.',
        },
        {
          ...finding(role),
          kind: 'question',
          description: 'Provide a usable mobile viewport.',
        },
      ];
      const findings = [
        ...blockers,
        {
          ...finding(role),
          severity: 'advisory',
          description: 'Not a blocker.',
        },
      ];
      if (role === 'qa')
        operations.qa.mockResolvedValue({
          ...qaPass,
          verdict: 'blocked',
          criteria: [{ ...qaPass.criteria[0], status: 'blocked' }],
          findings,
        });
      else
        operations.review.mockResolvedValue({
          ...reviewPass,
          verdict: 'blocked',
          findings,
        });
      await expect(run()).resolves.toMatchObject({
        status: 'blocked',
        rounds: 1,
        reason: blockers.map((blocker) => blocker.description).join('\n'),
      });
      expect(operations.implement).toHaveBeenCalledOnce();
      expect(operations.summarize).not.toHaveBeenCalled();
    },
  );
  test('repeated source trees can be reverified instead of stopping a supervised repair', async () => {
    const { run, operations } = setup();
    operations.capture.mockResolvedValue({
      revision: 'same-revision',
      tree: 'same-tree',
    });
    operations.qa.mockResolvedValueOnce({
      ...qaPass,
      verdict: 'changes-requested',
      findings: [finding()],
    });
    const result = await run();
    expect(result).toMatchObject({ status: 'ready', rounds: 2 });
    expect(operations.checks).toHaveBeenCalledTimes(2);
    expect(operations.qa).toHaveBeenCalledTimes(2);
    expect(operations.implement).toHaveBeenCalledTimes(2);
  });
  test.each([null, uiProjectPlan])(
    'implementation blockers stop before capture or verification even with a plan: %j',
    async (verification) => {
      const { run, operations, close } = setup();
      operations.implement.mockResolvedValue({
        summary: 'Cannot proceed.',
        blockers: ['A required API contract is missing.'],
        verification,
      });
      await expect(run()).resolves.toMatchObject({
        status: 'blocked',
        rounds: 1,
        reason: 'A required API contract is missing.',
        revision: null,
        summary: null,
        pullRequestUrl: null,
      });
      expect(operations.capture).not.toHaveBeenCalled();
      expect(operations.checks).not.toHaveBeenCalled();
      expect(operations.qa).not.toHaveBeenCalled();
      expect(operations.review).not.toHaveBeenCalled();
      expect(operations.summarize).not.toHaveBeenCalled();
      expect(operations.finish.mock.calls[0]?.[0].status).toBe('blocked');
      expect(close).toHaveBeenCalledOnce();
    },
  );
  test.each([null, { checks: [], targets: [] }])(
    'successful implementation cannot skip verification: %j',
    async (verification) => {
      const { run, operations } = setup();
      operations.implement.mockResolvedValue({
        ...implementation,
        verification,
      });
      await expect(run()).rejects.toThrow('Workflow failed');
      expect(operations.capture).not.toHaveBeenCalled();
      expect(operations.qa).not.toHaveBeenCalled();
      expect(operations.finish).not.toHaveBeenCalled();
    },
  );
  test('an unchanged candidate still reruns checks, QA and review before approval', async () => {
    const { run, operations } = setup();
    operations.capture.mockResolvedValue({
      revision: 'same-revision',
      tree: 'same-tree',
    });
    operations.review.mockResolvedValueOnce({
      verdict: 'changes-requested',
      summary: 'Fix the defect.',
      findings: [finding('review')],
    });
    const result = await run();
    expect(result.status).toBe('ready');
    expect(operations.checks).toHaveBeenCalledTimes(2);
    expect(operations.qa).toHaveBeenCalledTimes(2);
    expect(operations.review).toHaveBeenCalledTimes(2);
  });
  test('an implementation blocker during repair retains the previous candidate without validating it as the new round', async () => {
    const { run, operations } = setup();
    operations.review.mockResolvedValueOnce({
      verdict: 'changes-requested',
      summary: 'Fix the defect.',
      findings: [finding('review')],
    });
    operations.implement
      .mockResolvedValueOnce({ ...implementation, summary: 'First candidate.' })
      .mockResolvedValueOnce({
        summary: 'Cannot repair within scope.',
        blockers: ['The API contract is missing.'],
        verification: null,
      });
    await expect(run()).resolves.toMatchObject({
      status: 'blocked',
      rounds: 2,
      revision: 'revision-1',
      reason: 'The API contract is missing.',
      summary: null,
    });
    expect(operations.capture).toHaveBeenCalledOnce();
    expect(operations.qa).toHaveBeenCalledOnce();
    expect(operations.review).toHaveBeenCalledOnce();
    expect(operations.summarize).not.toHaveBeenCalled();
  });
  test.each([
    {
      ...qaPass,
      criteria: [
        {
          id: 'made-up',
          status: 'pass',
          evidenceIds: ['test'],
          notes: 'Not a real criterion.',
        },
      ],
    },
    {
      ...qaPass,
      criteria: [{ ...qaPass.criteria[0], evidenceIds: ['invented'] }],
    },
    { ...qaPass, criteria: [{ ...qaPass.criteria[0], status: 'fail' }] },
    { ...qaPass, findings: [finding()] },
    { unexpected: true },
  ])(
    'invalid QA cannot reach review, summary, or publication: %j',
    async (report) => {
      const { run, operations, close } = setup();
      operations.qa.mockResolvedValue(report);
      await expect(run()).rejects.toThrow('Workflow failed');
      expect(operations.review).not.toHaveBeenCalled();
      expect(operations.summarize).not.toHaveBeenCalled();
      expect(operations.finish).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    },
  );
  test('stale check evidence cannot authorize QA', async () => {
    const { run, operations } = setup();
    operations.checks.mockImplementation((round) =>
      Promise.resolve({
        ...round,
        evidence: [
          {
            id: 'test',
            revision: 'old-revision',
            kind: 'check',
            targetId: null,
            operation: 'test',
            exitCode: 0,
            path: 'old.json',
          },
        ],
      }),
    );
    await expect(run()).rejects.toThrow('Workflow failed');
    expect(operations.finish).not.toHaveBeenCalled();
  });
  test('candidate modifications during verification prevent publication', async () => {
    const { run, operations } = setup();
    operations.assertUnchanged.mockRejectedValue(
      new Error('Candidate changed.'),
    );
    await expect(run()).rejects.toThrow('Workflow failed');
    expect(operations.finish).not.toHaveBeenCalled();
  });
  test('rejects an unconfirmed brief before preparing the repository', async () => {
    const unconfirmed = {
      ...brief,
      readiness: 'needs-clarification' as const,
      confirmedByUser: false,
    };
    const { run, operations } = setup(() => Promise.resolve(unconfirmed));
    await expect(run()).rejects.toThrow('Workflow failed');
    expect(operations.prepare).not.toHaveBeenCalled();
  });
  test('cancellation prevents late results from advancing and always closes the runtime', async () => {
    const { options, operations, close } = setup();
    const controller = new AbortController();
    options.signal = controller.signal;
    let started = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let complete: (value: unknown) => void = () => {};
    operations.implement.mockImplementation(() => {
      started();
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    const running = runDefault(options);
    await ready;
    controller.abort(new Error('Stopped by user.'));
    await expect(running).rejects.toThrow('Stopped by user.');
    complete({ summary: 'Late output.', blockers: [] });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(operations.capture).not.toHaveBeenCalled();
    expect(operations.finish).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
  test('a pending agent has no workflow deadline and can still be cancelled', async () => {
    vi.useFakeTimers();
    const { options, operations, close } = setup();
    const controller = new AbortController();
    options.signal = controller.signal;
    operations.implement.mockImplementation(() => new Promise(() => {}));
    const running = expect(runDefault(options)).rejects.toThrow(
      'Stopped by user.',
    );
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(close).not.toHaveBeenCalled();
    controller.abort(new Error('Stopped by user.'));
    await running;
    expect(close).toHaveBeenCalledOnce();
    expect(operations.finish).not.toHaveBeenCalled();
  });
  test('exploration and implementation may each outlive the former workflow deadline', async () => {
    vi.useFakeTimers();
    let finishExploration: (value: unknown) => void = () => {};
    const { options, operations, close } = setup(
      () =>
        new Promise((resolve) => {
          finishExploration = resolve;
        }),
    );
    let finishImplementation: (value: unknown) => void = () => {};
    operations.implement.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishImplementation = resolve;
        }),
    );
    const running = runDefault(options);
    await vi.advanceTimersByTimeAsync(3_600_000);
    finishExploration(brief);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(operations.implement).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    finishImplementation(implementation);
    await expect(running).resolves.toMatchObject({ status: 'ready' });
    expect(close).toHaveBeenCalledOnce();
    expect(operations.finish).toHaveBeenCalledOnce();
  });
  test('unexpected workflow rejections do not expose provider credentials', async () => {
    const { options, close } = setup();
    const nativeRun = await options.workflow.createRun();
    vi.spyOn(options.workflow, 'createRun').mockResolvedValueOnce(nativeRun);
    vi.spyOn(nativeRun, 'start').mockRejectedValue(
      new Error('Authorization: Bearer private-key'),
    );
    await expect(runDefault(options)).rejects.toThrow('Workflow failed');
    expect(close).toHaveBeenCalledOnce();
  });
  test('publication recovery details survive a failed Mastra step without exposing its cause', async () => {
    const { run, operations, close } = setup();
    const journal = '/private/run/publication.json';
    operations.finish.mockRejectedValue(
      new PublicationError(
        'push',
        journal,
        new Error('Authorization: Bearer private-key'),
      ),
    );
    const failed = run();
    await expect(failed).rejects.toBeInstanceOf(PublicationError);
    await expect(failed).rejects.toThrow('Git push');
    await expect(failed).rejects.toThrow(journal);
    await expect(failed).rejects.not.toThrow('private-key');
    expect(operations.finish).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
  test('unexpected finish errors remain private', async () => {
    const { run, operations, close } = setup();
    operations.finish.mockRejectedValue(
      new Error('Authorization: Bearer private-key'),
    );
    const failed = run();
    await expect(failed).rejects.toThrow('Workflow failed');
    await expect(failed).rejects.not.toThrow('private-key');
    expect(close).toHaveBeenCalledOnce();
  });
});

function passingRound(): DeliveryRound {
  return {
    round: 1,
    revision: 'revision',
    tree: 'tree',
    implementation,
    evidence: [
      {
        id: 'test',
        revision: 'revision',
        kind: 'check',
        targetId: null,
        operation: 'test',
        exitCode: 0,
        path: 'check.json',
      },
    ],
    qa: structuredClone(qaPass) as DeliveryRound['qa'],
    review: null,
    findings: [],
  };
}

describe('QA evidence gates', () => {
  const web = {
    id: 'web',
    kind: 'web' as const,
    url: 'http://localhost:3000',
    start: { command: 'node', args: ['server.js'] },
    screenshots: true,
  };
  test('a passing report cannot skip required browser or screenshot evidence', () => {
    const round = passingRound();
    expect(() => validateQa(brief, round, [web])).toThrow('open evidence');
    for (const operation of ['open', 'snapshot'])
      round.evidence.push({
        id: operation,
        revision: round.revision,
        kind: 'browser',
        operation,
        targetId: 'web',
        exitCode: 0,
        path: 'action.json',
      });
    expect(() => validateQa(brief, round, [web])).toThrow(
      'screenshot evidence',
    );
    round.evidence.push({
      id: 'image',
      revision: round.revision,
      kind: 'screenshot',
      operation: 'screenshot',
      targetId: 'web',
      exitCode: 0,
      path: 'image.png',
    });
    expect(validateQa(brief, round, [web]).qa?.verdict).toBe('pass');
  });
  test('failed checks cannot be cited as passing acceptance evidence', () => {
    const round = passingRound();
    round.evidence[0]!.exitCode = 1;
    expect(() => validateQa(brief, round, [])).toThrow('failed');
  });
  test('duplicate criterion IDs are rejected', () => {
    const round = passingRound();
    round.qa!.criteria.push(round.qa!.criteria[0]!);
    expect(() => validateQa(brief, round, [])).toThrow('exactly once');
  });
});

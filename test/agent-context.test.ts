import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createIssueTask } from '../src/agents/task.js';
import {
  qaSchema,
  reviewSchema,
  type Finding,
} from '../src/contracts/delivery.js';
import {
  implementationContext,
  qaContext,
  reviewContext,
  summaryContext,
} from '../src/delivery/agent-context.js';
import { readFailedCheckLogs } from '../src/delivery/artifacts.js';
import { currentRound } from '../src/delivery/state.js';
import { brief } from './fixtures/brief.js';
import {
  candidateState,
  projectPlan,
  uiProjectPlan,
} from './fixtures/delivery.js';
import { qaPass, reviewPass } from './fixtures/workflow.js';

function verifiedState() {
  const state = candidateState();
  state.status = 'approved';
  const round = currentRound(state);
  round.qa = qaSchema.parse(qaPass);
  round.review = reviewSchema.parse(reviewPass);
  return state;
}

function finding(
  description: string,
  source: Finding['source'] = 'qa',
): Finding {
  return {
    source,
    kind: 'defect',
    severity: 'blocking',
    description,
    criterionId: 'AC1',
    evidenceIds: ['stale-evidence-id'],
  };
}

test('issue tasks keep approved work and constraints, not exploration bookkeeping', () => {
  const issue = {
    ...brief,
    constraints: ['Do not send data outside the local machine.'],
    assumptions: ['The exporter supports filtered queries.'],
    risks: ['CSV formula injection.'],
  };
  expect(createIssueTask(issue)).toEqual({
    problem: issue.problem,
    desiredOutcome: issue.desiredOutcome,
    users: issue.users,
    scope: issue.scope,
    requirements: issue.requirements,
    acceptanceCriteria: issue.acceptanceCriteria,
    constraints: issue.constraints,
    assumptions: issue.assumptions,
    decisions: issue.decisions,
    risks: issue.risks,
  });
});

test('initial implementation receives only its task, allowed paths and check commands', () => {
  const state = { ...candidateState(), round: 0, history: [] };
  expect(implementationContext(state, projectPlan, [])).toEqual({
    task: createIssueTask(state.brief),
    allowedPaths: projectPlan.allowedPaths,
    checks: projectPlan.checks,
    repair: null,
  });
});

test('repairs receive latest findings and failed criterion notes, never historical reports', () => {
  const state = verifiedState();
  const latest = currentRound(state);
  const old = structuredClone(latest);
  old.implementation.summary = 'Old implementation narrative.';
  old.findings = [finding('Old resolved defect.')];
  latest.round = 2;
  state.round = 2;
  state.history.unshift(old);
  latest.findings = [finding('Escape CSV formulas.')];
  latest.qa!.criteria = [
    {
      id: 'AC1',
      status: 'fail',
      evidenceIds: ['test'],
      notes: 'A formula cell executes when the CSV is opened.',
    },
    {
      id: 'AC2',
      status: 'pass',
      evidenceIds: ['test'],
      notes: 'Already passing criterion notes.',
    },
  ];
  const checkLogs = [
    { checkId: 'test', exitCode: 1, excerpt: 'Failure tail.' },
  ];
  const context = implementationContext(state, projectPlan, checkLogs);
  expect(context.repair).toEqual({
    findings: [
      {
        source: 'qa',
        kind: 'defect',
        severity: 'blocking',
        description: 'Escape CSV formulas.',
        criterionId: 'AC1',
      },
    ],
    failedCriteria: [
      { id: 'AC1', notes: 'A formula cell executes when the CSV is opened.' },
    ],
    checkLogs,
  });
  const prompt = JSON.stringify(context);
  for (const excluded of [
    'Old implementation narrative.',
    'Old resolved defect.',
    'Already passing criterion notes.',
    'stale-evidence-id',
    'baseRevision',
    'history',
  ])
    expect(prompt).not.toContain(excluded);
});

test('QA receives criteria, constraints, target addresses and current evidence references only', () => {
  const state = candidateState();
  state.brief.constraints = ['Use local test accounts.'];
  const evidence = currentRound(state).evidence;
  const project = { ...projectPlan, ...uiProjectPlan };
  const context = qaContext(state, project, [
    ...evidence,
    { ...evidence[0]!, id: 'old', revision: 'old-revision' },
  ]);
  expect(context).toEqual({
    acceptanceCriteria: state.brief.acceptanceCriteria,
    constraints: ['Use local test accounts.'],
    targets: [
      {
        id: 'web',
        kind: 'web',
        url: 'http://localhost:3000',
        screenshots: true,
      },
      {
        id: 'ios',
        kind: 'mobile',
        platform: 'ios',
        app: 'com.example.app',
        screenshots: true,
      },
    ],
    evidence: [
      {
        id: 'test',
        kind: 'check',
        targetId: null,
        operation: 'test',
        exitCode: 0,
        path: 'test.json',
      },
    ],
  });
  const mobile = project.targets[1]!;
  if (mobile.kind !== 'mobile') throw new Error('Expected a mobile fixture.');
  mobile.device = 'test-device';
  expect(qaContext(state, project, evidence).targets[1]).toMatchObject({
    device: 'test-device',
  });
});

test('review receives the patch, current evidence and only the last relevant review feedback', () => {
  const state = verifiedState();
  const current = currentRound(state);
  const reviewed = structuredClone(current);
  reviewed.findings = [
    finding('Prior reviewer defect.', 'review'),
    finding('Unrelated prior QA narrative.'),
  ];
  const skipped = { ...structuredClone(current), round: 2, review: null };
  current.round = 3;
  state.round = 3;
  state.history = [reviewed, skipped, current];
  const context = reviewContext(state, projectPlan, 'Current patch.');
  expect(context).toEqual({
    task: createIssueTask(state.brief),
    allowedPaths: projectPlan.allowedPaths,
    patch: 'Current patch.',
    evidence: [
      {
        id: 'test',
        kind: 'check',
        targetId: null,
        operation: 'test',
        exitCode: 0,
        path: 'test.json',
      },
    ],
    acceptanceResults: [{ id: 'AC1', status: 'pass', evidenceIds: ['test'] }],
    previousFindings: [
      {
        source: 'review',
        kind: 'defect',
        severity: 'blocking',
        description: 'Prior reviewer defect.',
        criterionId: 'AC1',
      },
    ],
  });
  const prompt = JSON.stringify(context);
  expect(prompt).not.toContain('Implemented.');
  expect(prompt).not.toContain(qaPass.criteria[0]!.notes);
  expect(prompt).not.toContain('Unrelated prior QA narrative.');
  expect(prompt).not.toContain('stale-evidence-id');
});

test('summary receives final outcomes without task details, target setup, paths or old rounds', () => {
  const state = verifiedState();
  expect(summaryContext(state)).toEqual({
    issue: {
      title: brief.title,
      kind: brief.kind,
      desiredOutcome: brief.desiredOutcome,
    },
    implementation: 'Implemented.',
    checks: [{ id: 'test', exitCode: 0 }],
    qa: {
      verdict: 'pass',
      criteria: [
        { id: 'AC1', status: 'pass', notes: qaPass.criteria[0]!.notes },
      ],
    },
    review: { verdict: 'pass', summary: reviewPass.summary },
    findings: [],
  });
});

test('unrelated older rounds do not enlarge any delivery agent prompt', () => {
  const state = verifiedState();
  const project = { ...projectPlan, ...uiProjectPlan };
  const contexts = () => [
    implementationContext(state, project, []),
    qaContext(state, project, currentRound(state).evidence),
    reviewContext(state, project, 'Patch.'),
    summaryContext(state),
  ];
  const before = JSON.stringify(contexts());
  const old = structuredClone(currentRound(state));
  old.qa = null;
  old.review = null;
  old.implementation.summary = 'Unrelated history.'.repeat(1_000);
  old.findings = [finding('Old resolved defect.')];
  currentRound(state).round = 2;
  state.round = 2;
  state.history.unshift(old);
  expect(JSON.stringify(contexts())).toBe(before);
  expect(state.history).toHaveLength(2);
});

test('context builders reject missing current rounds or verification reports', () => {
  const state = candidateState();
  expect(() => reviewContext(state, projectPlan, '')).toThrow('QA report');
  expect(() => summaryContext(state)).toThrow('QA and review reports');
  const missing = { ...state, history: [] };
  expect(() => implementationContext(missing, projectPlan, [])).toThrow(
    'current round',
  );
  expect(() => qaContext(missing, projectPlan, [])).toThrow('current round');
});

test('repair log loading skips successful checks and bounds each failed log excerpt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'darkfactory-context-'));
  try {
    const path = join(directory, 'failed.json');
    const log = `${'x'.repeat(15_000)}Failure details.`;
    await writeFile(path, log);
    const record = currentRound(candidateState()).evidence[0]!;
    expect(
      await readFailedCheckLogs([
        { ...record, path: 'nonexistent-success.json' },
        { ...record, exitCode: 1, path },
        {
          ...record,
          kind: 'browser',
          exitCode: 1,
          path: 'nonexistent-ui.json',
        },
      ]),
    ).toEqual([{ checkId: 'test', exitCode: 1, excerpt: log.slice(-12_000) }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

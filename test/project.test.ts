import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  projectInspectionSchema,
  projectPlanSchema,
} from '../src/contracts/project.js';
import { hostCommand } from '../src/integrations/git/command.js';
import { inspectRepository } from '../src/integrations/git/inspect.js';
import { projectPlan } from './fixtures/delivery.js';

const directories: string[] = [];
const signal = new AbortController().signal;
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'darkfactory-inspect-'));
  directories.push(directory);
  const repository = await realpath(directory);
  const git = (args: string[]) =>
    hostCommand(
      'git',
      [
        '-C',
        repository,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      signal,
    );
  await git(['init', '-b', 'feature/current']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.com']);
  await writeFile(
    join(repository, 'package.json'),
    JSON.stringify({ scripts: { test: 'node test.cjs' } }),
  );
  await git(['add', '.']);
  await git(['commit', '-m', 'initial']);
  await mkdir(join(repository, 'nested'));
  return { repository, git };
}

test.each([
  'git@github.com:example/project.git',
  'https://github.com/example/project.git',
  'ssh://git@github.com/example/project.git',
])(
  'infers the Git root, current branch, pinned revision and GitHub remote from a nested cwd (%s)',
  async (remote) => {
    const { repository, git } = await setup();
    await git(['remote', 'add', 'origin', remote]);
    const result = await inspectRepository(join(repository, 'nested'), signal);
    expect(result).toEqual({
      repository,
      baseBranch: 'feature/current',
      baseRevision: (await git(['rev-parse', 'HEAD'])).trim(),
      githubRepo: 'example/project',
    });
  },
);

test('inspection returns either an executable plan or explicit blockers', () => {
  const plan = projectPlanSchema.parse({
    allowedPaths: projectPlan.allowedPaths,
    checks: projectPlan.checks,
  });
  expect(
    projectInspectionSchema.safeParse({ plan, blockers: [] }).success,
  ).toBe(true);
  expect(
    projectInspectionSchema.safeParse({
      plan: null,
      blockers: ['Missing app identifier.'],
    }).success,
  ).toBe(true);
  for (const result of [
    { plan: null, blockers: [] },
    { plan, blockers: ['Missing app identifier.'] },
    { plan: null, blockers: [' '] },
    { plan: { ...plan, checks: [] }, blockers: [] },
  ])
    expect(projectInspectionSchema.safeParse(result).success).toBe(false);
});

test('does not invent a publication target for a repository without a remote', async () => {
  const { repository } = await setup();
  expect((await inspectRepository(repository, signal)).githubRepo).toBeNull();
});

test('does not choose between conflicting GitHub remotes when origin is absent', async () => {
  const { repository, git } = await setup();
  await git(['remote', 'add', 'first', 'git@github.com:example/first.git']);
  await git(['remote', 'add', 'second', 'git@github.com:example/second.git']);
  expect((await inspectRepository(repository, signal)).githubRepo).toBeNull();
});

test('rejects a detached checkout instead of guessing its base branch', async () => {
  const { repository, git } = await setup();
  await git(['checkout', '--detach']);
  await expect(inspectRepository(repository, signal)).rejects.toThrow(
    'on a local branch',
  );
});

test.each([
  { checks: [] },
  { checks: [projectPlan.checks[0], projectPlan.checks[0]] },
  { allowedPaths: ['../outside'] },
  { allowedPaths: ['.git'] },
  {
    targets: [
      { id: 'ios', kind: 'mobile', platform: 'ios', app: 'com.example.app' },
    ],
  },
])(
  'rejects an inferred plan with unsafe scope or missing verification: %j',
  (override) => {
    expect(
      projectPlanSchema.safeParse({
        allowedPaths: ['feature.txt'],
        checks: projectPlan.checks,
        ...override,
      }).success,
    ).toBe(false);
  },
);

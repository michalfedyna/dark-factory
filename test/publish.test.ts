import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { hostCommand } from '../src/integrations/git/command.js';
import {
  createRunRepository,
  readBase,
} from '../src/integrations/git/repository.js';
import { publishPullRequest } from '../src/integrations/github/publish.js';
import type { DeliveryState } from '../src/contracts/delivery.js';
import { brief } from './fixtures/brief.js';
import { deliveryConfig, png } from './fixtures/delivery.js';

const external = vi.hoisted(() => ({ fail: false, base: '' }));
vi.mock('../src/integrations/git/command.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/integrations/git/command.js')>();
  return {
    hostCommand: vi
      .fn<typeof actual.hostCommand>()
      .mockImplementation((command, args, signal, cwd) => {
        if (command === 'gh' && args[0] === 'api')
          return Promise.resolve(external.base);
        if (command === 'gh')
          return external.fail
            ? Promise.reject(new Error('private provider error'))
            : Promise.resolve('https://github.com/example/project/pull/12\n');
        if (args.includes('push')) return Promise.resolve('');
        return actual.hostCommand(command, args, signal, cwd);
      }),
  };
});
const directories: string[] = [];
afterEach(async () => {
  external.fail = false;
  vi.clearAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'darkfactory-publish-'));
  directories.push(directory);
  const source = join(directory, 'source');
  await mkdir(source);
  const signal = new AbortController().signal;
  const git = (args: string[]) =>
    hostCommand(
      'git',
      [
        '-C',
        source,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      signal,
    );
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.com']);
  await writeFile(join(source, 'original.txt'), 'original');
  await git(['add', '.']);
  await git(['commit', '-m', 'initial']);
  const base = await readBase(source, 'main', signal);
  external.base = base;
  const runDirectory = join(directory, 'run');
  const repository = await createRunRepository(
    source,
    runDirectory,
    base,
    ['feature.txt'],
    signal,
  );
  await writeFile(join(repository.path, 'feature.txt'), 'implemented');
  const candidate = await repository.capture(signal);
  const screenshot = join(runDirectory, 'screen.png');
  await writeFile(screenshot, png);
  const state: DeliveryState = {
    brief,
    baseRevision: base,
    round: 1,
    status: 'approved',
    reason: '',
    summary: {
      title: 'feat: CSV export',
      changes: ['Add CSV export.'],
      testing: ['Tests passed.'],
      limitations: [],
    },
    history: [
      {
        round: 1,
        ...candidate,
        implementation: { summary: 'Implemented.', blockers: [] },
        evidence: [
          {
            id: 'r1-e1',
            revision: candidate.revision,
            kind: 'screenshot',
            targetId: 'web',
            operation: 'screenshot',
            exitCode: 0,
            path: screenshot,
          },
        ],
        qa: {
          verdict: 'pass',
          criteria: [
            {
              id: 'AC1',
              status: 'pass',
              evidenceIds: ['r1-e1'],
              notes: 'Private QA notes must not be published.',
            },
          ],
          findings: [],
        },
        review: {
          verdict: 'pass',
          summary: 'Private review text.',
          findings: [],
        },
        findings: [],
      },
    ],
  };
  return {
    config: deliveryConfig,
    repository,
    state,
    runId: 'test-run',
    directory: runDirectory,
    signal,
  };
}

test('publishes only verified code and evidence, links screenshots, and creates a draft PR', async () => {
  const options = await setup();
  await expect(publishPullRequest(options)).resolves.toBe(
    'https://github.com/example/project/pull/12',
  );
  const gh = vi
    .mocked(hostCommand)
    .mock.calls.find(([command, args]) => command === 'gh' && args[0] === 'pr');
  expect(gh?.[1]).toContain('--draft');
  expect(gh?.[1]).toContain('--head');
  expect(gh?.[1]).toContain('darkfactory/test-run');
  const push = vi
    .mocked(hostCommand)
    .mock.calls.find(([, args]) => args.includes('push'));
  expect(push?.[1]).toContain('HEAD:refs/heads/darkfactory/test-run');
  expect(push?.[1]).not.toContain('--force');
  const head = await options.repository.git(['rev-parse', 'HEAD']);
  const body = await readFile(
    join(options.directory, 'pull-request.md'),
    'utf8',
  );
  expect(body).toContain(
    `https://github.com/example/project/raw/${head}/.darkfactory/evidence/test-run/r1-e1.png`,
  );
  expect(body).toContain(options.state.history[0]!.revision);
  expect(body).not.toContain(options.directory);
  expect(
    await readFile(
      join(options.repository.path, '.darkfactory/evidence/test-run/r1-e1.png'),
    ),
  ).toEqual(png);
  const manifest = await readFile(
    join(
      options.repository.path,
      '.darkfactory/evidence/test-run/verification.json',
    ),
    'utf8',
  );
  expect(manifest).not.toContain('Private QA notes');
  expect(manifest).not.toContain('Private review text');
  expect(manifest).not.toContain(options.directory);
  expect(
    await options.repository.git([
      'diff',
      '--name-only',
      options.state.history[0]!.revision,
      'HEAD',
      '--',
      '.',
      ':(exclude).darkfactory/evidence',
    ]),
  ).toBe('');
});
test('failed gates cannot call push or GitHub even when invoked directly', async () => {
  const options = await setup();
  options.state.status = 'blocked';
  await expect(publishPullRequest(options)).rejects.toThrow('passing gates');
  expect(
    vi
      .mocked(hostCommand)
      .mock.calls.some(
        ([command, args]) => command === 'gh' || args.includes('push'),
      ),
  ).toBe(false);
});
test('an uncertain GitHub response is journaled and is never automatically retried', async () => {
  const options = await setup();
  external.fail = true;
  await expect(publishPullRequest(options)).rejects.toThrow(
    'outcome is uncertain',
  );
  const publication = JSON.parse(
    await readFile(join(options.directory, 'publication.json'), 'utf8'),
  ) as { status: string };
  expect(publication.status).toBe('uncertain');
  expect(
    vi
      .mocked(hostCommand)
      .mock.calls.filter(
        ([command, args]) => command === 'gh' && args[0] === 'pr',
      ),
  ).toHaveLength(1);
});

test('base branch drift blocks publication before any push or PR write', async () => {
  const options = await setup();
  external.base = 'different-base';
  await expect(publishPullRequest(options)).rejects.toThrow(
    'differs from the approved local base',
  );
  expect(
    vi
      .mocked(hostCommand)
      .mock.calls.some(
        ([command, args]) =>
          args.includes('push') || (command === 'gh' && args[0] === 'pr'),
      ),
  ).toBe(false);
});

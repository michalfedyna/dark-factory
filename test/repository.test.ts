import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { factoryConfigSchema } from '../src/config/schema.js';
import type { Ask } from '../src/contracts/interaction.js';
import { createDeliveryRuntime } from '../src/delivery/runtime.js';
import { hostCommand } from '../src/integrations/git/command.js';
import {
  createRunRepository,
  readBase,
} from '../src/integrations/git/repository.js';
import { brief } from './fixtures/brief.js';
import { projectPlan } from './fixtures/delivery.js';

const directories: string[] = [];
const signal = new AbortController().signal;
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup(allowedPaths = ['feature.txt']) {
  const directory = await mkdtemp(join(tmpdir(), 'darkfactory-repository-'));
  directories.push(directory);
  const source = join(directory, 'source');
  await mkdir(source);
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
  await writeFile(join(source, '.gitignore'), 'node_modules/\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'initial']);
  const base = await readBase(source, 'main', signal);
  const repository = await createRunRepository(
    source,
    join(directory, 'run'),
    base,
    allowedPaths,
    signal,
  );
  return { directory, source, git, repository, base };
}

test('uses a committed base in a private checkout and leaves user changes untouched', async () => {
  const { source, git, repository, base } = await setup();
  await writeFile(join(source, 'original.txt'), 'uncommitted user work');
  await writeFile(join(source, 'untracked.txt'), 'user data');
  await writeFile(join(repository.path, 'feature.txt'), 'implemented');
  const candidate = await repository.capture(signal);
  expect(candidate.revision).not.toBe(base);
  await expect(readFile(join(repository.path, '.git'))).rejects.toThrow();
  expect(await readFile(join(source, 'original.txt'), 'utf8')).toBe(
    'uncommitted user work',
  );
  expect((await git(['status', '--short'])).trim()).toBe(
    'M original.txt\n?? untracked.txt',
  );
  expect((await git(['rev-parse', 'HEAD'])).trim()).toBe(base);
  await repository.assertUnchanged(candidate.revision, signal);
});
test.each(['original.txt', '.env', '.darkfactory/policy.json'])(
  'rejects changes outside allowed paths or protected files: %s',
  async (file) => {
    const { repository } = await setup(['.']);
    if (file === 'original.txt') {
      const scoped = await setup(['feature.txt']);
      await writeFile(join(scoped.repository.path, file), 'out of scope');
      await expect(scoped.repository.capture(signal)).rejects.toThrow(
        'unapproved path',
      );
      return;
    }
    if (file.includes('/')) await mkdir(join(repository.path, '.darkfactory'));
    await writeFile(join(repository.path, file), 'do not publish');
    await expect(repository.capture(signal)).rejects.toThrow('protected');
  },
);
test('verification mutations, including new untracked files, invalidate the candidate', async () => {
  const { repository } = await setup();
  await writeFile(join(repository.path, 'feature.txt'), 'implemented');
  const { revision } = await repository.capture(signal);
  await writeFile(
    join(repository.path, 'new-test.txt'),
    'QA cannot write source',
  );
  await expect(repository.assertUnchanged(revision, signal)).rejects.toThrow(
    'changed the candidate',
  );
});
test('ignored build artifacts do not change the source candidate', async () => {
  const { repository } = await setup();
  await writeFile(join(repository.path, 'feature.txt'), 'implemented');
  const { revision } = await repository.capture(signal);
  await mkdir(join(repository.path, 'node_modules'));
  await writeFile(join(repository.path, 'node_modules/cache'), 'ignored');
  await repository.assertUnchanged(revision, signal);
});

test('run repositories do not inherit a Git hook index or repository environment', async () => {
  const caller = await mkdtemp(join(tmpdir(), 'darkfactory-caller-'));
  directories.push(caller);
  const index = join(caller, 'index');
  await writeFile(index, 'caller index must remain untouched');
  vi.stubEnv('GIT_INDEX_FILE', index);
  vi.stubEnv('GIT_DIR', join(caller, '.git'));
  vi.stubEnv('GIT_COMMON_DIR', join(caller, 'common'));
  vi.stubEnv('GIT_WORK_TREE', caller);
  vi.stubEnv('GIT_OBJECT_DIRECTORY', join(caller, 'objects'));
  vi.stubEnv('GIT_CONFIG_COUNT', '1');
  vi.stubEnv('GIT_CONFIG_KEY_0', 'core.bare');
  vi.stubEnv('GIT_CONFIG_VALUE_0', 'true');
  const { repository, base, git } = await setup();
  await writeFile(join(repository.path, 'feature.txt'), 'implemented');
  const { revision } = await repository.capture(signal);
  expect(revision).not.toBe(base);
  await repository.assertUnchanged(revision, signal);
  expect((await git(['rev-parse', 'HEAD'])).trim()).toBe(base);
  expect(await readFile(index, 'utf8')).toBe(
    'caller index must remain untouched',
  );
});

test.each(['Stop', 'yes', ''])(
  'only exact implementation approval permits preparation (answer: %j)',
  async (answer) => {
    const { source, base } = await setup();
    const ask = vi.fn<Ask>().mockResolvedValue(answer);
    const runtime = createDeliveryRuntime({
      inspect: () =>
        Promise.resolve({
          ...projectPlan,
          repository: source,
          baseRevision: base,
        }),
      model: factoryConfigSchema.parse({}).model,
      apiKey: 'not-for-project-commands',
      runId: 'denied',
      ask,
      signal,
      progress: () => {},
    });
    try {
      await expect(runtime.operations.prepare(brief, signal)).rejects.toThrow(
        'not approved',
      );
      expect(ask).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          contextTitle: 'Implementation plan',
          options: ['Implement', 'Stop'],
        }),
        expect.any(AbortSignal),
      );
      const context: unknown = JSON.parse(ask.mock.calls[0]![0].context);
      expect(context).toMatchObject({
        brief,
        repository: source,
        baseRevision: base,
        project: { ...projectPlan, repository: source, baseRevision: base },
        maxRepairRounds: 3,
      });
      expect(context).toHaveProperty(
        'warning',
        expect.stringContaining('Publication requires a separate approval.'),
      );
      await expect(
        readFile(join(source, '.darkfactory/runs/denied/input.json')),
      ).rejects.toThrow();
    } finally {
      await runtime.close();
    }
  },
);

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { loadQaReferences } from '../src/delivery/qa-references.js';
import { createQaReferenceTool } from '../src/tools/qa-reference.js';
import { png } from './fixtures/delivery.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function setup() {
  const repository = await mkdtemp(join(tmpdir(), 'darkfactory-references-'));
  directories.push(repository);
  const directory = join(repository, 'docs/design');
  return { repository, directory };
}

test('QA snapshots only design PNGs and exposes immutable images by ID, not paths or URLs', async () => {
  const { repository, directory } = await setup();
  expect(await loadQaReferences(repository)).toEqual([]);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'shipping.png'), png);
  await writeFile(join(directory, 'HANDOFF.md'), 'Private handoff text');
  const references = await loadQaReferences(repository);
  expect(references.map(({ id, name, path }) => ({ id, name, path }))).toEqual([
    { id: 'design-1', name: 'shipping.png', path: 'docs/design/shipping.png' },
  ]);
  await writeFile(join(directory, 'shipping.png'), 'changed after capture');
  const controller = new AbortController();
  const tool = createQaReferenceTool(references, controller.signal);
  const execute = async (referenceId: string) =>
    await tool.execute!({ referenceId }, {});
  await expect(execute('design-1')).resolves.toEqual({
    name: 'shipping.png',
    image: png.toString('base64'),
  });
  for (const id of [
    '../.env',
    join(directory, 'shipping.png'),
    'https://example.com/private.png',
  ])
    await expect(execute(id)).rejects.toThrow('Unknown QA design reference');
  controller.abort(new Error('Cancelled'));
  await expect(execute('design-1')).rejects.toThrow('Cancelled');
});

test.each(['docs-link', 'design-link', 'image-link', 'invalid-image'] as const)(
  'QA rejects unsafe design references (%s)',
  async (scenario) => {
    const { repository, directory } = await setup();
    const external = await mkdtemp(
      join(tmpdir(), 'darkfactory-external-reference-'),
    );
    directories.push(external);
    await writeFile(join(external, 'secret.png'), png);
    if (scenario === 'docs-link')
      await symlink(external, join(repository, 'docs'));
    else if (scenario === 'design-link') {
      await mkdir(join(repository, 'docs'));
      await symlink(external, directory);
    } else {
      await mkdir(directory, { recursive: true });
      if (scenario === 'image-link')
        await symlink(
          join(external, 'secret.png'),
          join(directory, 'shipping.png'),
        );
      else await writeFile(join(directory, 'shipping.png'), 'not a PNG');
    }
    await expect(loadQaReferences(repository)).rejects.toThrow(/reference|PNG/);
  },
);

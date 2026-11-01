import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateScreenshot } from './evidence.js';

export interface QaReference {
  id: string;
  name: string;
  path: string;
  image: string;
}

/** Snapshot only regular PNGs in the design handoff, never arbitrary agent paths. */
export async function loadQaReferences(
  repository: string,
): Promise<QaReference[]> {
  const directory = join(repository, 'docs', 'design');
  for (const path of [join(repository, 'docs'), directory]) {
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return [];
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(
        'QA design references must use real repository directories.',
      );
  }
  const names = (await readdir(directory))
    .filter((name) => name.endsWith('.png'))
    .sort();
  if (names.length > 20)
    throw new Error('QA supports at most 20 design reference PNGs.');
  const references: QaReference[] = [];
  for (const name of names) {
    const path = join(directory, name);
    await validateScreenshot(path);
    references.push({
      id: `design-${references.length + 1}`,
      name,
      path: `docs/design/${name}`,
      image: (await readFile(path)).toString('base64'),
    });
  }
  return references;
}

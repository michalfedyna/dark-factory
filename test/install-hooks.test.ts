import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

test.each([
  {
    name: 'installs in a checkout',
    git: 'directory',
    dependency: true,
    exit: 0,
  },
  { name: 'supports worktrees', git: 'file', dependency: true, exit: 0 },
  {
    name: 'skips outside a checkout',
    git: 'absent',
    dependency: true,
    exit: 0,
  },
  {
    name: 'skips without dev dependencies',
    git: 'directory',
    dependency: false,
    exit: 0,
  },
  {
    name: 'propagates install failures',
    git: 'directory',
    dependency: true,
    exit: 7,
  },
])('postinstall $name', ({ git, dependency, exit }) => {
  const root = mkdtempSync(join(tmpdir(), 'darkfactory-hooks-'));

  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(
      new URL('../scripts/install-hooks.mjs', import.meta.url),
      join(root, 'scripts/install-hooks.mjs'),
    );

    if (git === 'directory') mkdirSync(join(root, '.git'));
    if (git === 'file')
      writeFileSync(join(root, '.git'), 'gitdir: elsewhere\n');

    if (dependency) {
      const bin = join(root, 'node_modules/lefthook/bin');
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(bin, 'index.js'),
        `require('node:fs').writeFileSync('hook-install.json', JSON.stringify(process.argv.slice(2)));\nprocess.exit(${exit});\n`,
      );
    }

    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts/install-hooks.mjs')],
      {
        encoding: 'utf8',
        timeout: 10_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(exit);

    const installed = join(root, 'hook-install.json');
    expect(existsSync(installed)).toBe(git !== 'absent' && dependency);
    if (existsSync(installed)) {
      expect(JSON.parse(readFileSync(installed, 'utf8'))).toEqual(['install']);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { hostCommand } from './command.js';

export class CandidateChangedError extends Error {
  constructor() {
    super(
      'Verification changed the candidate. QA and review cannot modify source.',
    );
  }
}

export async function readBase(
  repository: string,
  branch: string,
  signal: AbortSignal,
): Promise<string> {
  return (
    await hostCommand(
      'git',
      [
        '-C',
        repository,
        'rev-parse',
        '--verify',
        `refs/heads/${branch}^{commit}`,
      ],
      signal,
    )
  ).trim();
}

export async function createRunRepository(
  source: string,
  directory: string,
  base: string,
  allowedPaths: string[],
  signal: AbortSignal,
) {
  const path = join(directory, 'repository');
  const metadata = join(directory, 'git');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await hostCommand(
    'git',
    [
      'clone',
      '--no-local',
      '--no-hardlinks',
      '--no-checkout',
      '--',
      source,
      path,
    ],
    signal,
  );
  // Keep Git control files outside the agent's filesystem and working directory.
  await rename(join(path, '.git'), metadata);
  const git = async (args: string[], commandSignal = signal) => {
    const output = await hostCommand(
      'git',
      [
        '--git-dir',
        metadata,
        '--work-tree',
        path,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.quotePath=false',
        ...args,
      ],
      commandSignal,
    );
    return args.includes('-z') ? output : output.trim();
  };
  await git(['config', 'core.worktree', path]);
  await git(['checkout', '--detach', base]);
  await git(['config', 'user.name', 'DarkFactory']);
  await git(['config', 'user.email', 'darkfactory@users.noreply.github.com']);
  const baseTree = await git(['rev-parse', `${base}^{tree}`]);
  const stage = async (commandSignal: AbortSignal) => {
    await git(['add', '--all', '--', '.'], commandSignal);
    return git(['write-tree'], commandSignal);
  };
  return {
    path,
    git,
    capture: async (commandSignal: AbortSignal) => {
      const tree = await stage(commandSignal);
      const changed = (
        await git(
          ['diff', '--cached', '--name-only', '-z', base],
          commandSignal,
        )
      )
        .split('\0')
        .filter(Boolean);
      for (const file of changed) {
        if (
          /^\.(git|darkfactory)(\/|$)/.test(file) ||
          /(^|\/)\.env($|\.(?!example$))/.test(file) ||
          !allowedPaths.some(
            (prefix) =>
              prefix === '.' ||
              file === prefix ||
              file.startsWith(`${prefix.replace(/\/$/, '')}/`),
          )
        )
          throw new Error(
            `Implementation changed a protected or unapproved path: ${file}`,
          );
      }
      if (tree === baseTree)
        throw new Error('Implementation made no source changes.');
      const previousTree = await git(
        ['rev-parse', 'HEAD^{tree}'],
        commandSignal,
      );
      if (tree !== previousTree)
        await git(
          ['commit', '-m', 'feat: implement approved DarkFactory brief'],
          commandSignal,
        );
      return {
        revision: await git(['rev-parse', 'HEAD'], commandSignal),
        tree,
      };
    },
    assertUnchanged: async (revision: string, commandSignal: AbortSignal) => {
      const expectedTree = await git(
        ['rev-parse', `${revision}^{tree}`],
        commandSignal,
      );
      if (
        (await git(['rev-parse', 'HEAD'], commandSignal)) !== revision ||
        (await stage(commandSignal)) !== expectedTree
      )
        throw new CandidateChangedError();
    },
  };
}

export type RunRepository = Awaited<ReturnType<typeof createRunRepository>>;

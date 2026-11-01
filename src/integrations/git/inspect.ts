import { hostCommand } from './command.js';
import { readBase } from './repository.js';

function githubRepository(remote: string): string | null {
  const ssh = /^(?:git@)?github\.com:([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  if (ssh?.[1]) return ssh[1];
  if (!URL.canParse(remote)) return null;
  const url = new URL(remote);
  if (
    url.hostname !== 'github.com' ||
    !['https:', 'ssh:'].includes(url.protocol) ||
    url.search ||
    url.hash
  )
    return null;
  const repository = /^\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.pathname)?.[1];
  return repository ?? null;
}

export async function inspectRepository(
  directory: string,
  signal: AbortSignal,
) {
  const git = async (args: string[]) =>
    (await hostCommand('git', ['-C', directory, ...args], signal)).trim();
  let repository: string;
  let baseBranch: string;
  try {
    repository = await git(['rev-parse', '--show-toplevel']);
    baseBranch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(
      'Run dark start inside a Git repository on a local branch with a commit.',
      { cause: error },
    );
  }
  const baseRevision = await readBase(repository, baseBranch, signal);
  const remotes = (await git(['remote'])).split('\n').filter(Boolean);
  // Prefer origin; without it, only an unambiguous GitHub remote is usable.
  const names = remotes.includes('origin') ? ['origin'] : remotes;
  const repositories = new Set<string>();
  for (const name of names) {
    const remote = await git(['remote', 'get-url', name]);
    const githubRepo = githubRepository(remote);
    if (githubRepo) repositories.add(githubRepo);
  }
  return {
    repository,
    baseBranch,
    baseRevision,
    githubRepo: repositories.size === 1 ? [...repositories][0]! : null,
  };
}

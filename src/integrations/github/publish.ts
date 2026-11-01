import type { RunRepository } from '../git/repository.js';
import { hostCommand } from '../git/command.js';

/** External GitHub operations only; delivery owns approval and publication policy. */
export async function readGithubBase(
  githubRepo: string,
  baseBranch: string,
  signal: AbortSignal,
) {
  return (
    await hostCommand(
      'gh',
      [
        'api',
        '--hostname',
        'github.com',
        `repos/${githubRepo}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
        '--jq',
        '.object.sha',
      ],
      signal,
    )
  ).trim();
}

export async function pushBranch(
  repository: Pick<RunRepository, 'git'>,
  githubRepo: string,
  branch: string,
  signal: AbortSignal,
): Promise<void> {
  await repository.git(
    [
      // Use gh credentials without changing the user's Git config.
      '-c',
      'credential.https://github.com.helper=',
      '-c',
      'credential.https://github.com.helper=!gh auth git-credential',
      'push',
      `https://github.com/${githubRepo}.git`,
      `HEAD:refs/heads/${branch}`,
    ],
    signal,
  );
}

export async function createDraftPullRequest(options: {
  githubRepo: string;
  baseBranch: string;
  branch: string;
  title: string;
  bodyFile: string;
  directory: string;
  signal: AbortSignal;
}): Promise<string> {
  const { githubRepo, baseBranch, branch, title, bodyFile, directory, signal } =
    options;
  const url = (
    await hostCommand(
      'gh',
      [
        'pr',
        'create',
        '--repo',
        `https://github.com/${githubRepo}`,
        '--base',
        baseBranch,
        '--head',
        branch,
        '--draft',
        '--title',
        title,
        '--body-file',
        bodyFile,
      ],
      signal,
      directory,
    )
  ).trim();
  const expected = new RegExp(
    `^https://github\\.com/${githubRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pull/\\d+$`,
  );
  if (!expected.test(url))
    throw new Error('GitHub did not return a pull request URL.');
  return url;
}

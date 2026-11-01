import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Project } from '../contracts/project.js';
import type { DeliveryState } from '../contracts/delivery.js';
import type { RunRepository } from '../integrations/git/repository.js';
import {
  createDraftPullRequest,
  pushBranch,
  readGithubBase,
} from '../integrations/github/publish.js';
import { validateScreenshot } from './evidence.js';
import { renderPullRequest } from './pull-request.js';

export class PublicationError extends Error {
  constructor(
    operation: 'push' | 'create-pr',
    journal: string,
    cause: unknown,
  ) {
    const action = operation === 'push' ? 'Git push' : 'Draft PR creation';
    super(
      `${action} failed or its outcome is uncertain. Check gh auth status and repository permissions. Check ${journal} and GitHub before retrying; publication is never automatically retried.`,
      { cause },
    );
  }
}

export async function publishPullRequest(options: {
  project: Pick<Project, 'githubRepo' | 'baseBranch'>;
  repository: RunRepository;
  state: DeliveryState;
  runId: string;
  directory: string;
  signal: AbortSignal;
}): Promise<string> {
  const { project, repository, state, runId, directory, signal } = options;
  if (!project.githubRepo)
    throw new Error('A GitHub remote is required for publication.');
  if (state.brief.readiness !== 'ready' || !state.brief.confirmedByUser)
    throw new Error('Publication requires a confirmed, ready brief.');
  const round = state.history.at(-1);
  if (
    state.status !== 'approved' ||
    !state.summary ||
    !round ||
    round.qa?.verdict !== 'pass' ||
    round.review?.verdict !== 'pass' ||
    round.findings.some((finding) => finding.severity === 'blocking')
  )
    throw new Error('Publication requires passing gates and a summary.');
  await repository.assertUnchanged(round.revision, signal);
  const remoteBase = await readGithubBase(
    project.githubRepo,
    project.baseBranch,
    signal,
  );
  if (remoteBase !== state.baseRevision)
    throw new Error(
      'The GitHub base branch differs from the approved local base. Update the local branch and start a new approved run.',
    );
  const screenshots = round.evidence.filter(
    (record) => record.kind === 'screenshot' && record.exitCode === 0,
  );
  const relativeDirectory = `.darkfactory/evidence/${runId}`;
  const evidenceDirectory = join(repository.path, relativeDirectory);
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  for (const record of screenshots) {
    await validateScreenshot(record.path);
    await copyFile(record.path, join(evidenceDirectory, `${record.id}.png`));
  }
  // Publish a small manifest, not private command logs, paths, or conversation data.
  await writeFile(
    join(evidenceDirectory, 'verification.json'),
    JSON.stringify(
      {
        codeRevision: round.revision,
        baseRevision: state.baseRevision,
        rounds: state.round,
        attempts: state.implementationAttempts.length,
        summary: state.summary,
        criteria: round.qa?.criteria.map((criterion) => ({
          id: criterion.id,
          status: criterion.status,
          evidenceIds: criterion.evidenceIds,
        })),
        qaVerdict: round.qa?.verdict,
        reviewVerdict: round.review?.verdict,
        evidence: round.evidence.map((record) => ({
          id: record.id,
          revision: record.revision,
          kind: record.kind,
          targetId: record.targetId,
          operation: record.operation,
          exitCode: record.exitCode,
        })),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await repository.git(['add', '--force', '--', relativeDirectory], signal);
  await repository.git(
    ['commit', '-m', 'chore: attach DarkFactory verification evidence'],
    signal,
  );
  const revision = await repository.git(['rev-parse', 'HEAD'], signal);
  const sourceDiff = await repository.git(
    [
      'diff',
      '--name-only',
      round.revision,
      revision,
      '--',
      '.',
      ':(exclude).darkfactory/evidence',
    ],
    signal,
  );
  if (sourceDiff)
    throw new Error('Publication metadata changed verified source.');
  await repository.assertUnchanged(revision, signal);
  const branch = `darkfactory/${runId}`;
  const body = renderPullRequest(
    state,
    screenshots,
    (record) =>
      `https://github.com/${project.githubRepo}/raw/${revision}/${relativeDirectory}/${record.id}.png`,
  );
  const bodyFile = join(directory, 'pull-request.md');
  await writeFile(bodyFile, body, { mode: 0o600 });
  const journal = join(directory, 'publication.json');
  const publication = {
    branch,
    codeRevision: round.revision,
    revision,
    repository: project.githubRepo,
    bodyFile: basename(bodyFile),
  };
  let operation: 'push' | 'create-pr' = 'push';
  await writeFile(
    journal,
    JSON.stringify(
      { ...publication, status: 'publishing', operation },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  signal.throwIfAborted();
  try {
    await pushBranch(repository, project.githubRepo, branch, signal);
    operation = 'create-pr';
    await writeFile(
      journal,
      JSON.stringify(
        { ...publication, status: 'publishing', operation },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    const url = await createDraftPullRequest({
      githubRepo: project.githubRepo,
      baseBranch: project.baseBranch,
      branch,
      title: state.summary.title,
      bodyFile,
      directory: repository.path,
      signal,
    });
    await writeFile(
      journal,
      JSON.stringify({ ...publication, status: 'published', url }, null, 2),
      { mode: 0o600 },
    );
    return url;
  } catch (error) {
    let cause = error;
    try {
      await writeFile(
        journal,
        JSON.stringify(
          { ...publication, status: 'uncertain', operation },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    } catch (journalError) {
      cause = new AggregateError(
        [error, journalError],
        'Publication and its uncertainty journal failed.',
      );
    }
    signal.throwIfAborted();
    throw new PublicationError(operation, journal, cause);
  }
}

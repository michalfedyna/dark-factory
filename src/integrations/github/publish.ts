import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { DeliveryConfig } from '../../config/delivery.js';
import type { DeliveryState, Evidence } from '../../contracts/delivery.js';
import type { RunRepository } from '../git/repository.js';
import { hostCommand } from '../git/command.js';
import { validateScreenshot } from '../qa/evidence.js';

export function renderPullRequest(
  state: DeliveryState,
  screenshots: Evidence[],
  imageUrl: (record: Evidence) => string,
): string {
  if (!state.summary) throw new Error('A verified summary is required.');
  const round = state.history.at(-1)!;
  const bullets = (values: string[]) =>
    values.map((value) => `- ${value}`).join('\n');
  return `## Summary\n${bullets(state.summary.changes)}\n\n## Verification\n${bullets(state.summary.testing)}\n\nCode candidate: \`${round.revision}\`\nBase: \`${state.baseRevision}\`\nImplementation rounds: ${state.round}\nQA: ${round.qa?.verdict ?? 'not run'}; review: ${round.review?.verdict ?? 'not run'}.\n\n${round.evidence
    .filter((record) => record.kind === 'check')
    .map(
      (record) =>
        `- ${record.operation}: ${record.exitCode === 0 ? 'pass' : 'fail'} (\`${record.id}\`)`,
    )
    .join(
      '\n',
    )}\n\n## Screenshots\n${screenshots.length ? screenshots.map((record) => `### ${record.targetId ?? 'QA'} (${record.id})\n![${record.id}](${imageUrl(record)})`).join('\n\n') : 'Not required for the configured targets.'}\n\n## Limitations\n${state.summary.limitations.length ? bullets(state.summary.limitations) : '- No additional limitations reported.'}\n\nThis is a draft PR for human review. CI and GitHub reviews have not been verified. Evidence is added in a metadata-only commit after the tested code candidate.\n`;
}

export async function publishPullRequest(options: {
  config: DeliveryConfig;
  repository: RunRepository;
  state: DeliveryState;
  runId: string;
  directory: string;
  signal: AbortSignal;
}): Promise<string> {
  const { config, repository, state, runId, directory, signal } = options;
  const round = state.history.at(-1)!;
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
  const remoteBase = (
    await hostCommand(
      'gh',
      [
        'api',
        '--hostname',
        'github.com',
        `repos/${config.githubRepo}/git/ref/heads/${encodeURIComponent(config.baseBranch)}`,
        '--jq',
        '.object.sha',
      ],
      signal,
    )
  ).trim();
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
      `https://github.com/${config.githubRepo}/raw/${revision}/${relativeDirectory}/${record.id}.png`,
  );
  const bodyFile = join(directory, 'pull-request.md');
  await writeFile(bodyFile, body, { mode: 0o600 });
  const journal = join(directory, 'publication.json');
  const publication = {
    branch,
    codeRevision: round.revision,
    revision,
    repository: config.githubRepo,
    bodyFile: basename(bodyFile),
  };
  await writeFile(
    journal,
    JSON.stringify({ ...publication, status: 'publishing' }, null, 2),
    { mode: 0o600 },
  );
  signal.throwIfAborted();
  try {
    await repository.git(
      [
        'push',
        `https://github.com/${config.githubRepo}.git`,
        `HEAD:refs/heads/${branch}`,
      ],
      signal,
    );
    const url = (
      await hostCommand(
        'gh',
        [
          'pr',
          'create',
          '--repo',
          `https://github.com/${config.githubRepo}`,
          '--base',
          config.baseBranch,
          '--head',
          branch,
          '--draft',
          '--title',
          state.summary.title,
          '--body-file',
          bodyFile,
        ],
        signal,
        repository.path,
      )
    ).trim();
    if (
      !new RegExp(
        `^https://github\\.com/${config.githubRepo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pull/\\d+$`,
      ).test(url)
    )
      throw new Error('GitHub did not return a pull request URL.');
    await writeFile(
      journal,
      JSON.stringify({ ...publication, status: 'published', url }, null, 2),
      { mode: 0o600 },
    );
    return url;
  } catch (error) {
    await writeFile(
      journal,
      JSON.stringify({ ...publication, status: 'uncertain' }, null, 2),
      { mode: 0o600 },
    );
    signal.throwIfAborted();
    throw new Error(
      `Publication failed or its outcome is uncertain. Check ${journal} and GitHub before retrying; publication is never automatically retried.`,
      { cause: error },
    );
  }
}

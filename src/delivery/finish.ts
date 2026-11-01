import {
  deliveryResultSchema,
  type DeliveryState,
} from '../contracts/delivery.js';
import { publishPullRequest } from './publication.js';
import { renderPullRequest } from './pull-request.js';
import type { DeliveryOptions, RunResources } from './context.js';

export async function finishDelivery(
  run: RunResources,
  options: DeliveryOptions,
  state: DeliveryState,
  signal: AbortSignal,
) {
  const { project, repository, directory, runId, artifacts } = run;
  let pullRequestUrl: string | null = null;
  const round = state.history.at(-1);
  if (
    state.status !== 'blocked' &&
    (state.status !== 'approved' || !state.summary || !round)
  )
    throw new Error(
      'Finishing requires a blocked result or an approved candidate with a summary.',
    );
  if (state.status === 'approved' && state.summary && round) {
    const screenshots = round.evidence.filter(
      (record) => record.kind === 'screenshot' && record.exitCode === 0,
    );
    const preview = renderPullRequest(
      state,
      screenshots,
      (record) => record.path,
    );
    await artifacts.preview(preview);
    signal.throwIfAborted();
    if (project.githubRepo) {
      options.progress('Publishing draft PR');
      pullRequestUrl = await publishPullRequest({
        project,
        repository,
        state,
        runId,
        directory,
        signal,
      });
    }
  }
  const result = deliveryResultSchema.parse({
    schemaVersion: '1.1',
    runId,
    status:
      state.status === 'blocked'
        ? 'blocked'
        : pullRequestUrl
          ? 'published'
          : 'ready',
    reason:
      state.reason ||
      (!project.githubRepo
        ? 'No unambiguous GitHub remote was found; the verified candidate remains local.'
        : ''),
    baseRevision: state.baseRevision,
    revision: round?.revision ?? null,
    rounds: state.round,
    attempts: state.implementationAttempts.length,
    runDirectory: directory,
    summary: state.summary,
    pullRequestUrl,
  });
  await artifacts.result(result);
  return result;
}

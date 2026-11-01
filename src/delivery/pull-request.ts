import type { DeliveryState, Evidence } from '../contracts/delivery.js';
import { currentRound } from './state.js';

export function renderPullRequest(
  state: DeliveryState,
  screenshots: Evidence[],
  imageUrl: (record: Evidence) => string,
): string {
  if (!state.summary) throw new Error('A verified summary is required.');
  const round = currentRound(state);
  const bullets = (values: string[]) =>
    values.map((value) => `- ${value}`).join('\n');
  const summary = `## Summary\n${bullets(state.summary.changes)}`;
  const candidate = [
    `Code candidate: \`${round.revision}\``,
    `Base: \`${state.baseRevision}\``,
    `Implementation rounds: ${state.round}`,
    `QA: ${round.qa?.verdict ?? 'not run'}; review: ${round.review?.verdict ?? 'not run'}.`,
  ].join('\n');
  const checks = round.evidence
    .filter((record) => record.kind === 'check')
    .map(
      (record) =>
        `- ${record.operation}: ${record.exitCode === 0 ? 'pass' : 'fail'} (\`${record.id}\`)`,
    )
    .join('\n');
  const verification = `## Verification\n${bullets(state.summary.testing)}\n\n${candidate}\n\n${checks}`;
  const images = screenshots.length
    ? screenshots
        .map(
          (record) =>
            `### ${record.targetId ?? 'QA'} (${record.id})\n![${record.id}](${imageUrl(record)})`,
        )
        .join('\n\n')
    : 'Not required for the configured targets.';
  const screenshotSection = `## Screenshots\n${images}`;
  const limitations = state.summary.limitations.length
    ? bullets(state.summary.limitations)
    : '- No additional limitations reported.';
  const limitationsSection = `## Limitations\n${limitations}`;
  const publicationNote =
    'This is a draft PR for human review. CI and GitHub reviews have not been verified. Evidence is added in a metadata-only commit after the tested code candidate.';
  return (
    [
      summary,
      verification,
      screenshotSection,
      limitationsSection,
      publicationNote,
    ].join('\n\n') + '\n'
  );
}

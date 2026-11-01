import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandResult } from '@mastra/core/workspace';
import type { FactoryConfig } from '../config/schema.js';
import type {
  DeliveryResult,
  DeliveryState,
  Evidence,
} from '../contracts/delivery.js';
import type { IssueBrief } from '../contracts/issue.js';
import type { Observe } from '../contracts/progress.js';
import type { Project } from '../contracts/project.js';

export async function readFailedCheckLogs(evidence: Evidence[]) {
  const records = evidence.filter(
    (record) => record.kind === 'check' && record.exitCode !== 0,
  );
  return Promise.all(
    records.map(async (record) => ({
      checkId: record.operation,
      exitCode: record.exitCode,
      excerpt: (await readFile(record.path, 'utf8')).slice(-12_000),
    })),
  );
}

export function createRunArtifacts(directory: string) {
  const json = (file: string, value: unknown, exclusive = false) =>
    writeFile(join(directory, file), JSON.stringify(value, null, 2), {
      mode: 0o600,
      ...(exclusive ? { flag: 'wx' } : {}),
    });
  return {
    input: (input: {
      runId: string;
      brief: IssueBrief;
      config: Project;
      model: FactoryConfig['model'];
      baseRevision: string;
      implementationApproved: true;
    }) => json('input.json', input, true),
    setup: (index: number, result: CommandResult) =>
      json(`setup-${index}.json`, result),
    preview: (markdown: string) =>
      writeFile(join(directory, 'pull-request-preview.md'), markdown, {
        mode: 0o600,
      }),
    result: (result: DeliveryResult) => json('result.json', result),
    record: async (state: DeliveryState, observe?: Observe) => {
      const round = state.history.at(-1);
      observe?.({
        kind: 'round',
        round: state.round,
        status: state.status,
        blockingFindings:
          round?.findings.filter((finding) => finding.severity === 'blocking')
            .length ?? 0,
        qa: round?.qa?.verdict ?? null,
        review: round?.review?.verdict ?? null,
      });
      await json('state.json', state);
    },
  };
}

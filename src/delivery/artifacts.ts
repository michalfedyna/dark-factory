import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FactoryConfig } from '../config/schema.js';
import type {
  DeliveryResult,
  DeliveryState,
  Evidence,
} from '../contracts/delivery.js';
import type { IssueBrief } from '../contracts/issue.js';
import type { Observe } from '../contracts/progress.js';
import type { Project } from '../contracts/project.js';
import { failureDetails } from './failure.js';

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
      sandbox: FactoryConfig['sandbox'];
      baseRevision: string;
    }) => json('input.json', input, true),
    preview: (markdown: string) =>
      writeFile(join(directory, 'pull-request-preview.md'), markdown, {
        mode: 0o600,
      }),
    result: (result: DeliveryResult) => json('result.json', result),
    failure: async (input: {
      step: string;
      state: DeliveryState;
      evidence: Evidence[];
      error: unknown;
      secrets: string[];
    }) => {
      const { step, state, evidence, error, secrets } = input;
      const credentials = secrets.filter(Boolean);
      const content = JSON.stringify(
        {
          step,
          round: state.round,
          revision: state.history.at(-1)?.revision ?? null,
          error: failureDetails(error),
          evidence,
        },
        (_key, value: unknown) =>
          typeof value === 'string'
            ? credentials.reduce(
                (text, secret) => text.replaceAll(secret, '[redacted]'),
                value,
              )
            : value,
        2,
      );
      const path = join(directory, 'failure.json');
      await writeFile(path, content, { mode: 0o600 });
      return path;
    },
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

import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FactoryConfig } from '../config/schema.js';
import type {
  DeliveryResult,
  DeliveryState,
  Evidence,
} from '../contracts/delivery.js';
import type { IssueBrief } from '../contracts/issue.js';
import type { Observe } from '../contracts/progress.js';
import type { Project } from '../contracts/project.js';
import { errorDetails } from '../diagnostics/errors.js';
import type { RunOutcome, StepEvent } from '../contracts/diagnostics.js';

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

export function createRunArtifacts(
  directory: string,
  secrets: () => string[] = () => [],
) {
  let initializing: Promise<void> | undefined;
  let writes = Promise.resolve();
  let lastStep: StepEvent | undefined;
  let ended = false;
  const stringify = (value: unknown, space = 2) =>
    JSON.stringify(
      value,
      (_key, entry: unknown) =>
        typeof entry === 'string'
          ? secrets()
              .filter(Boolean)
              .reduce(
                (text, secret) => text.replaceAll(secret, '[redacted]'),
                entry,
              )
          : entry,
      space,
    );
  const initialize = () =>
    (initializing ??= (async () => {
      await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
      await mkdir(directory, { mode: 0o700 });
    })());
  const write = (operation: () => Promise<void>) => {
    const writing = writes.catch(() => {}).then(operation);
    writes = writing;
    return writing;
  };
  const json = (file: string, value: unknown, exclusive = false) =>
    write(async () => {
      await initialize();
      const path = join(directory, file);
      if (exclusive) {
        await writeFile(path, stringify(value), { mode: 0o600, flag: 'wx' });
      } else {
        await writeFile(`${path}.tmp`, stringify(value), { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      }
    });
  const append = (file: string, value: unknown) =>
    write(async () => {
      await initialize();
      await appendFile(join(directory, file), `${stringify(value, 0)}\n`, {
        mode: 0o600,
      });
    });
  return {
    initialize,
    input: (input: {
      runId: string;
      brief: IssueBrief;
      config: Project;
      model: FactoryConfig['model'];
      sandbox: FactoryConfig['sandbox'];
      baseRevision: string;
    }) => json('input.json', input, true),
    preview: async (markdown: string) => {
      await initialize();
      await writeFile(join(directory, 'pull-request-preview.md'), markdown, {
        mode: 0o600,
      });
    },
    result: (result: DeliveryResult) => json('result.json', result),
    failure: async (input: {
      step: string;
      state: DeliveryState | null;
      evidence: Evidence[];
      error: unknown;
    }) => {
      const { step, state, evidence, error } = input;
      await json('failure.json', {
        step: step === 'workflow' ? (lastStep?.step ?? step) : step,
        round: state?.round ?? lastStep?.round ?? 0,
        attempt: lastStep?.attempt ?? state?.implementationAttempts.length ?? 0,
        revision: state?.history.at(-1)?.revision ?? lastStep?.revision ?? null,
        error: errorDetails(error),
        evidence,
      });
      const path = join(directory, 'failure.json');
      return path;
    },
    step: async (event: StepEvent) => {
      if (ended) return;
      lastStep = event;
      await append('execution.jsonl', event);
    },
    cleanup: (resource: string, error: unknown) =>
      append('cleanup.jsonl', {
        resource,
        timestamp: new Date().toISOString(),
        error: errorDetails(error),
      }),
    end: async (outcome: RunOutcome) => {
      if (ended || !initializing) return;
      ended = true;
      if (lastStep?.status === 'started') {
        const timestamp = new Date().toISOString();
        lastStep = {
          ...lastStep,
          status: outcome === 'cancelled' ? 'cancelled' : 'failed',
          timestamp,
          durationMs: Date.parse(timestamp) - Date.parse(lastStep.timestamp),
          reason:
            outcome === 'cancelled'
              ? 'Workflow cancelled.'
              : 'Workflow ended before this step returned.',
        };
        await append('execution.jsonl', lastStep);
      }
      await writes;
      await json('execution.json', {
        outcome,
        timestamp: new Date().toISOString(),
        lastStep,
      });
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

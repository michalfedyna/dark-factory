import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanupAll, withCleanup } from '../src/diagnostics/cleanup.js';
import { errorDetails } from '../src/diagnostics/errors.js';
import { createRunArtifacts } from '../src/delivery/artifacts.js';
import { createDebugWriter } from '../src/cli/debug.js';
import { captureTerminalOutput } from './fixtures/terminal.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test('error diagnostics preserve bounded stacks, command metadata, causes and aggregate failures', () => {
  const cause = Object.assign(new Error('Permission denied'), {
    code: 'EACCES',
    command: 'agent-browser',
    args: ['open'],
    stderr: 'detail'.repeat(5000),
  });
  const error = new AggregateError([cause], 'Cleanup failed', { cause });
  const details = errorDetails(error);
  expect(details.stack).toContain('diagnostics.test.ts');
  expect(details.cause).toMatchObject({
    code: 'EACCES',
    command: 'agent-browser',
    args: ['open'],
  });
  expect(details.cause?.stderr).toHaveLength(16_000);
  expect(details.errors?.[0]?.stack).toContain('Permission denied');
  expect(
    errorDetails({
      name: 'SerializedError',
      message: 'Native step failed',
      stack: 'serialized stack',
      cause: { message: 'Root cause', code: 'ENOENT' },
    }),
  ).toMatchObject({
    name: 'SerializedError',
    stack: 'serialized stack',
    cause: { message: 'Root cause', code: 'ENOENT' },
  });
  const circular = new Error('Circular');
  circular.cause = circular;
  expect(JSON.stringify(errorDetails(circular)).length).toBeLessThan(100_000);
});

test('cleanup preserves the primary failure and reports its own failure even if reporting fails', async () => {
  const primary = new Error('Provider failed');
  const cleanup = new Error('Destroy failed');
  const report = vi.fn().mockRejectedValue(new Error('Disk full'));
  await expect(
    withCleanup(
      () => Promise.reject(primary),
      () => Promise.reject(cleanup),
      report,
    ),
  ).rejects.toBe(primary);
  expect(report).toHaveBeenCalledWith(cleanup);
  await expect(
    withCleanup(
      () => Promise.resolve('complete'),
      () => Promise.reject(cleanup),
      report,
    ),
  ).rejects.toBe(cleanup);
});

test('cleanup attempts every resource and preserves all failures', async () => {
  const first = new Error('First');
  const second = new Error('Second');
  const stop = vi.fn<() => Promise<void>>().mockResolvedValue();
  const closing = cleanupAll([
    () => Promise.reject(first),
    stop,
    () => Promise.reject(second),
  ]);
  await expect(closing).rejects.toMatchObject({ errors: [first, second] });
  expect(stop).toHaveBeenCalledOnce();
});

test('private lifecycle records survive pre-preparation cancellation and reject late completions', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'darkfactory-diagnostics-'));
  directories.push(parent);
  const directory = join(parent, 'run');
  const artifacts = createRunArtifacts(directory, () => ['private-key']);
  const started = {
    step: 'prepare-delivery',
    status: 'started' as const,
    round: 0,
    attempt: 0,
    revision: null,
    timestamp: new Date().toISOString(),
  };
  await artifacts.step(started);
  const cause = Object.assign(new Error('private-key unavailable'), {
    code: 'EACCES',
  });
  await artifacts.failure({
    step: started.step,
    state: null,
    evidence: [],
    error: cause,
  });
  await artifacts.end('cancelled');
  await artifacts.step({ ...started, status: 'completed' });
  await artifacts.cleanup('workspace', cause);
  const events = (await readFile(join(directory, 'execution.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
  expect(events).toMatchObject([
    { status: 'started' },
    { status: 'cancelled', durationMs: expect.any(Number) as unknown },
  ]);
  expect(
    JSON.parse(await readFile(join(directory, 'execution.json'), 'utf8')),
  ).toMatchObject({ outcome: 'cancelled', lastStep: { status: 'cancelled' } });
  for (const file of ['failure.json', 'cleanup.jsonl']) {
    const content = await readFile(join(directory, file), 'utf8');
    expect(content).toContain('EACCES');
    expect(content).toContain('diagnostics.test.ts');
    expect(content).toContain('[redacted]');
    expect(content).not.toContain('private-key');
    expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600);
  }
});

test('debug error output keeps causes and stacks while redacting configured secrets', () => {
  const { output, log } = captureTerminalOutput(false);
  const debug = createDebugWriter(output, ['private-key']);
  debug.write({
    kind: 'detail',
    agent: 'qa',
    label: 'Failed',
    value: new Error('Outer', {
      cause: Object.assign(new Error('private-key'), { code: 'ENOENT' }),
    }),
  });
  debug.close();
  expect(log()).toContain('ENOENT');
  expect(log()).toContain('diagnostics.test.ts');
  expect(log()).not.toContain('private-key');
});

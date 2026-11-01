import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { startCommand } from '../src/cli/start.js';
import { createTerminal, CancelledError } from '../src/cli/terminal.js';
import { loadConfig } from '../src/config/load.js';
import { factoryConfigSchema } from '../src/config/schema.js';
import { startFactory } from '../src/factory/start.js';
import type { DeliveryResult } from '../src/contracts/delivery.js';

vi.mock('../src/config/load.js');
vi.mock('../src/factory/start.js');
vi.mock('../src/cli/terminal.js', async (original) => ({
  ...(await original<typeof import('../src/cli/terminal.js')>()),
  createTerminal: vi.fn(),
}));

const directories: string[] = [];
const originalExitCode = process.exitCode;
afterEach(async () => {
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'darkfactory-cli-lifecycle-'));
  directories.push(directory);
  vi.stubEnv('DARKFACTORY_API_KEY', 'test-key');
  vi.mocked(loadConfig).mockResolvedValueOnce({
    config: factoryConfigSchema.parse({}),
    directory,
  });
  const result: DeliveryResult = {
    schemaVersion: '1.1',
    runId: 'run',
    status: 'ready',
    reason: '',
    baseRevision: 'base',
    revision: 'candidate',
    rounds: 1,
    attempts: 1,
    runDirectory: directory,
    summary: null,
    pullRequestUrl: null,
  };
  const factory = {
    signal: new AbortController().signal,
    run: vi
      .fn<Awaited<ReturnType<typeof startFactory>>['run']>()
      .mockResolvedValue(result),
    close: vi.fn<() => Promise<void>>().mockResolvedValue(),
  };
  vi.mocked(startFactory).mockResolvedValueOnce(factory);
  const closeInput = vi.fn();
  vi.mocked(createTerminal).mockReturnValueOnce({
    issue: vi.fn().mockResolvedValue('Test'),
    ask: vi.fn(),
    close: closeInput,
  });
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  let stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation(
    (chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    },
  );
  return { factory, closeInput, stdout, stderr: () => stderr, result };
}

test('stdout is not published until input and factory cleanup complete', async () => {
  const { factory, closeInput, stdout, result } = await setup();
  factory.close.mockImplementationOnce(() => {
    expect(stdout).not.toHaveBeenCalled();
    expect(closeInput).toHaveBeenCalledOnce();
    return Promise.resolve();
  });
  await startCommand({ config: 'unused', issue: 'Test' });
  expect(stdout).toHaveBeenCalledExactlyOnceWith(
    `${JSON.stringify(result, null, 2)}\n`,
  );
});

test('CLI cleanup does not hide the workflow failure or print private cleanup details', async () => {
  const { factory, stdout, stderr } = await setup();
  const primary = new Error('Workflow failed at implement');
  factory.run.mockRejectedValueOnce(primary);
  factory.close.mockRejectedValueOnce(new Error('private-cleanup-token'));
  await expect(startCommand({ config: 'unused', issue: 'Test' })).rejects.toBe(
    primary,
  );
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr()).toContain('Cleanup failed');
  expect(stderr()).not.toContain('private-cleanup-token');
});

test('CLI cancellation remains exit 130 when factory cleanup also fails', async () => {
  const { factory, stdout, stderr } = await setup();
  factory.run.mockRejectedValueOnce(new CancelledError());
  factory.close.mockRejectedValueOnce(new Error('private-cleanup-token'));
  await expect(
    startCommand({ config: 'unused', issue: 'Test' }),
  ).resolves.toBeUndefined();
  expect(process.exitCode).toBe(130);
  expect(stdout).not.toHaveBeenCalled();
  expect(stderr()).toContain('Cancelled.');
  expect(stderr()).not.toContain('private-cleanup-token');
});

import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { projectPlan } from './fixtures/delivery.js';
import {
  createTestRepository,
  startCompiledFactory,
} from './fixtures/integration.js';

async function factory(
  api = 'responses',
  issue?: string,
  mode = 'normal',
  observerEnabled = true,
) {
  const directory = await mkdtemp(join(tmpdir(), 'darkfactory-cli-'));
  const { source } = await createTestRepository(directory, {
    'original.txt': 'original',
    'package.json': JSON.stringify({ scripts: { test: 'node check.cjs' } }),
  });
  await writeFile(
    join(directory, 'project-plan.json'),
    JSON.stringify({
      allowedPaths: projectPlan.allowedPaths,
      checks: projectPlan.checks,
      targets: [],
    }),
  );
  return startCompiledFactory({
    directory,
    source,
    api,
    mode,
    observerEnabled,
    ...(issue === undefined ? {} : { issue }),
  });
}

test.each(['chat', 'responses'])(
  'background summaries use a separate model without changing prompts or stdout (%s)',
  async (api) => {
    const run = await factory(api, 'Export issues', 'observer');
    try {
      await vi.waitFor(
        () => {
          expect(run.stderr()).toContain(
            'Observer: Exploring the issue; no implementation has started.',
          );
        },
        { timeout: 10_000 },
      );
      await vi.waitFor(
        () => {
          expect(run.stderr()).toContain('Which export format?');
        },
        { timeout: 10_000 },
      );
      const beforeAnswer = run.stderr();
      await new Promise((resolve) => {
        setTimeout(resolve, 1_100);
      });
      expect(run.stderr()).toBe(beforeAnswer);
      run.child.stdin.end('CSV\nStop\n');
      expect(await run.exit, run.stderr()).toEqual([1, null]);
      expect(run.stderr()).toContain(
        'Observer: Clarification received; the brief is being prepared.',
      );
      expect(run.stderr()).toContain('Implement this brief?');
      expect(run.stderr()).not.toContain('test-key');
      expect(run.stdout()).toBe('');
      await run.assertStopped();
    } finally {
      await run.clean();
    }
  },
  20_000,
);

test.each([true, false])(
  'observer failure/disable never stops exploration or leaks credentials (enabled=%s)',
  async (enabled) => {
    const run = await factory(
      'responses',
      'Export issues',
      'observer-failure',
      enabled,
    );
    try {
      run.child.stdin.end('CSV\nStop\n');
      expect(await run.exit, run.stderr()).toEqual([1, null]);
      expect(run.stderr()).toContain('Which export format?');
      expect(run.stderr()).toContain('Implement this brief?');
      expect(run.stderr().includes('Progress summaries unavailable')).toBe(
        enabled,
      );
      expect(run.stderr()).not.toContain('test-key');
      expect(run.stdout()).toBe('');
      await run.assertStopped();
    } finally {
      await run.clean();
    }
  },
  20_000,
);

test.each(['chat', 'responses'])(
  'compiled default flow inspects the current repository but makes no changes when implementation is declined (%s API)',
  async (api) => {
    const run = await factory(
      api,
      api === 'chat' ? 'Export filtered issues' : undefined,
    );
    try {
      run.child.stdin.end(
        api === 'chat' ? 'CSV\nStop\n' : 'Export filtered issues\n1\nStop\n',
      );
      expect(await run.exit, run.stderr()).toEqual([1, null]);
      expect(run.stdout()).toBe('');
      expect(run.stderr()).toContain('Which export format?');
      expect(run.stderr()).toContain('Inspecting repository');
      expect(run.stderr()).toContain('Implement this brief?');
      await expect(readdir(join(run.source, '.darkfactory'))).rejects.toThrow();
      expect(run.stdout()).not.toContain('test-key');
      expect(run.stderr()).not.toContain('test-key');
      await run.assertStopped();
    } finally {
      await run.clean();
    }
  },
  20_000,
);

test.each(['normal', 'no-encrypted-reasoning'])(
  'stateless Responses replays tool history without stored item references (%s)',
  async (mode) => {
    const run = await factory('responses', 'Export issues', mode, false);
    try {
      run.child.stdin.end('CSV\nStop\n');
      expect(await run.exit, run.stderr()).toEqual([1, null]);
      expect(run.stderr()).toContain('Which export format?');
      expect(run.stderr()).toContain('Implement this brief?');
      expect(run.stderr()).not.toContain('Offline reasoning summary.');
      expect(run.stderr()).not.toContain('encrypted-test-');
      expect(run.stdout()).toBe('');
      await run.assertStopped();
    } finally {
      await run.clean();
    }
  },
  20_000,
);

test('EOF fails without inventing an answer or preparing a repository', async () => {
  const run = await factory('responses', 'Export issues');
  try {
    run.child.stdin.end();
    expect(await run.exit).toEqual([1, null]);
    expect(run.stdout()).toBe('');
    expect(run.stderr()).toContain('Input ended before the workflow finished');
    await expect(readdir(join(run.source, '.darkfactory'))).rejects.toThrow();
    await run.assertStopped();
  } finally {
    await run.clean();
  }
}, 20_000);

test('unexpected router exit aborts a pending issue prompt', async () => {
  const run = await factory('responses', undefined, 'exit-after-models');
  try {
    expect(await run.exit).toEqual([1, null]);
    expect(run.stderr()).toContain('CLIProxyAPI exited');
    expect(run.stdout()).toBe('');
    await run.assertStopped();
  } finally {
    await run.clean();
  }
}, 20_000);

test.each(['issue', 'exploration', 'implementation'])(
  'cancellation stops the router and pending terminal input during %s',
  async (stage) => {
    const run = await factory(
      'responses',
      stage === 'issue' ? undefined : 'Export issues',
    );
    try {
      if (stage === 'implementation') run.child.stdin.write('CSV\n');
      await vi.waitFor(
        () => {
          expect(run.stderr()).toContain(
            stage === 'issue'
              ? 'Issue\n'
              : stage === 'exploration'
                ? 'Which export format?'
                : 'Implement this brief?',
          );
        },
        { timeout: 10_000 },
      );
      run.child.kill('SIGINT');
      expect(await run.exit, run.stderr()).toEqual([130, null]);
      expect(run.stdout()).toBe('');
      await expect(readdir(join(run.source, '.darkfactory'))).rejects.toThrow();
      await run.assertStopped();
    } finally {
      await run.clean();
    }
  },
  20_000,
);

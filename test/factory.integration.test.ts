import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { projectPlan } from './fixtures/delivery.js';
import { deliveryResultSchema } from '../src/contracts/delivery.js';
import type { SummarizeProgress } from '../src/contracts/progress.js';
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
  'background summaries start only after exploration, using a separate model (%s)',
  async (api) => {
    const run = await factory(api, 'Export issues', 'observer');
    try {
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
      expect(run.stderr()).not.toContain('Observer:');
      expect(
        await readFile(join(run.directory, 'agent-contexts.jsonl'), 'utf8'),
      ).not.toContain('"role":"observer"');
      run.child.stdin.write('CSV\n');
      await vi.waitFor(
        () => {
          expect(run.stderr()).toContain('Start implementation?');
        },
        { timeout: 10_000 },
      );
      expect(run.stderr()).not.toContain('Observer:');
      expect(
        await readFile(join(run.directory, 'agent-contexts.jsonl'), 'utf8'),
      ).not.toContain('"role":"observer"');
      run.child.stdin.end('Start\n');
      expect(await run.exit, run.stderr()).toEqual([0, null]);
      expect(run.stderr()).toContain(
        'Observer: Current delivery stage: Inspecting repository.',
      );
      const contexts = (
        await readFile(join(run.directory, 'agent-contexts.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              role: string;
              payload: Parameters<SummarizeProgress>[0];
            },
        );
      const observations = contexts.filter(({ role }) => role === 'observer');
      expect(observations.length).toBeGreaterThan(0);
      expect(
        contexts.findIndex(({ role }) => role === 'observer'),
      ).toBeGreaterThan(
        contexts.findIndex(({ role }) => role === 'inspection'),
      );
      for (const { payload } of observations) {
        expect(payload.stage).not.toBe('Exploring');
        expect(payload.events).not.toContainEqual({
          kind: 'stage',
          message: 'Exploring',
        });
        expect(payload.events).not.toContainEqual(
          expect.objectContaining({ kind: 'tool', agent: 'exploration' }),
        );
      }
      expect(run.stderr()).not.toContain('Implement this brief?');
      expect(run.stderr()).not.toContain('test-key');
      expect(deliveryResultSchema.parse(JSON.parse(run.stdout())).status).toBe(
        'ready',
      );
      await run.assertStopped();
    } finally {
      await run.clean();
    }
  },
  20_000,
);

test.each([true, false])(
  'observer failure/disable never stops delivery or leaks credentials (enabled=%s)',
  async (enabled) => {
    const run = await factory(
      'responses',
      'Export issues',
      'observer-failure',
      enabled,
    );
    try {
      run.child.stdin.end('CSV\nStart\n');
      expect(await run.exit, run.stderr()).toEqual([0, null]);
      expect(run.stderr()).toContain('Which export format?');
      expect(run.stderr()).not.toContain('Implement this brief?');
      expect(run.stderr().includes('Progress summaries unavailable')).toBe(
        enabled,
      );
      expect(run.stderr()).not.toContain('test-key');
      expect(deliveryResultSchema.parse(JSON.parse(run.stdout())).status).toBe(
        'ready',
      );
      await run.assertStopped();
    } finally {
      await run.clean();
    }
  },
  20_000,
);

test.each(['chat', 'responses'])(
  'EOF at plan confirmation cannot authorize repository preparation (%s API)',
  async (api) => {
    const run = await factory(
      api,
      api === 'chat' ? 'Export filtered issues' : undefined,
    );
    try {
      run.child.stdin.end(
        api === 'chat' ? 'CSV\n' : 'Export filtered issues\n1\n',
      );
      expect(await run.exit, run.stderr()).toEqual([1, null]);
      expect(run.stdout()).toBe('');
      expect(run.stderr()).toContain('Which export format?');
      expect(run.stderr()).toContain('Start implementation?');
      expect(run.stderr()).not.toContain('Inspecting repository');
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
      run.child.stdin.end('CSV\nStart\n');
      expect(await run.exit, run.stderr()).toEqual([0, null]);
      expect(run.stderr()).toContain('Which export format?');
      expect(run.stderr()).not.toContain('Implement this brief?');
      expect(run.stderr()).not.toContain('Offline reasoning summary.');
      expect(run.stderr()).not.toContain('encrypted-test-');
      expect(deliveryResultSchema.parse(JSON.parse(run.stdout())).status).toBe(
        'ready',
      );
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

test.each(['chat', 'responses'])(
  'inspection reports a blocker without prompting after plan confirmation (%s)',
  async (api) => {
    const run = await factory(api, 'Export issues', 'inspection-blocked');
    try {
      run.child.stdin.end('CSV\nStart\n');
      expect(await run.exit, run.stderr()).toEqual([1, null]);
      expect(run.stderr()).toContain(
        'Repository inspection blocked: Missing native app identifier.',
      );
      expect(run.stderr()).not.toContain('Input ended');
      expect(run.stderr()).not.toContain('Implement this brief?');
      expect(run.stdout()).toBe('');
      await expect(readdir(join(run.source, '.darkfactory'))).rejects.toThrow();
      await run.assertStopped();
    } finally {
      await run.clean();
    }
  },
  20_000,
);

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

test.each(['SIGTERM', 'SIGHUP', 'SIGKILL'] as const)(
  'factory termination with %s leaves no owned proxy behind',
  async (signal) => {
    const run = await factory('responses', undefined, 'ignore-term');
    try {
      await vi.waitFor(
        () => {
          expect(run.stderr()).toContain('Issue\n');
        },
        { timeout: 10_000 },
      );
      run.child.kill(signal);
      expect(await run.exit, run.stderr()).toEqual(
        signal === 'SIGTERM' ? [130, null] : [null, signal],
      );
      expect(run.stdout()).toBe('');
      await vi.waitFor(() => run.assertStopped(), { timeout: 5_000 });
    } finally {
      await run.clean();
    }
  },
  20_000,
);

test.each(['issue', 'exploration', 'implementation'])(
  'cancellation stops the router and pending terminal input during %s',
  async (stage) => {
    const run = await factory(
      'responses',
      stage === 'issue' ? undefined : 'Export issues',
      stage === 'implementation' ? 'slow-implementation' : 'normal',
    );
    try {
      if (stage === 'implementation') run.child.stdin.write('CSV\nStart\n');
      await vi.waitFor(
        () => {
          expect(run.stderr()).toContain(
            stage === 'issue'
              ? 'Issue\n'
              : stage === 'exploration'
                ? 'Which export format?'
                : 'Implementing',
          );
        },
        { timeout: 10_000 },
      );
      run.child.kill('SIGINT');
      expect(await run.exit, run.stderr()).toEqual([130, null]);
      expect(run.stdout()).toBe('');
      if (stage !== 'implementation')
        await expect(
          readdir(join(run.source, '.darkfactory')),
        ).rejects.toThrow();
      await run.assertStopped();
    } finally {
      await run.clean();
    }
  },
  20_000,
);

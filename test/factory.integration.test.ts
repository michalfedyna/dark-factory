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
  findRunDirectory,
} from './fixtures/integration.js';

async function factory(
  api = 'responses',
  issue?: string,
  mode = 'normal',
  observerEnabled = true,
  debug = false,
) {
  const directory = await mkdtemp(join(tmpdir(), 'darkfactory-cli-'));
  const { source } = await createTestRepository(directory, {
    'original.txt': 'original',
    'package.json': JSON.stringify({ scripts: { test: 'node check.cjs' } }),
  });
  await writeFile(
    join(directory, 'verification-plan.json'),
    JSON.stringify({
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
    debug,
    ...(issue === undefined ? {} : { issue }),
  });
}

test.each(['chat', 'responses'])(
  'debug streams exploration and delivery instead of invoking the Observer (%s)',
  async (api) => {
    const run = await factory(api, 'Export issues', 'normal', true, true);
    try {
      await vi.waitFor(
        () => {
          expect(run.stderr()).toContain('Which export format?');
        },
        { timeout: 10_000 },
      );
      expect(run.stderr()).toContain('exploration · Started');
      expect(run.stderr()).toContain('exploration · Tool call · ask');
      expect(run.stdout()).toBe('');
      run.child.stdin.end('CSV\nStart\n');
      expect(await run.exit, run.stderr()).toEqual([0, null]);
      expect(run.stderr()).toContain(
        'implementation · Tool call · mastra_workspace_write_file',
      );
      expect(run.stderr()).toContain(
        'implementation · Tool result · mastra_workspace_write_file',
      );
      expect(run.stderr()).toContain('feature.txt');
      for (const role of [
        'exploration',
        'implementation',
        'qa',
        'review',
        'summary',
      ])
        expect(run.stderr()).toContain(`${role} · Completed`);
      expect(run.stderr()).toContain('Check · test · passed');
      expect(run.stderr()).not.toContain('Observer:');
      expect(run.stderr()).not.toContain('test-key');
      expect(run.stderr()).not.toContain('encrypted-test-');
      if (api === 'responses')
        expect(run.stderr()).toContain(
          'exploration · Thinking\nOffline reasoning summary.',
        );
      const contexts = await readFile(
        join(run.directory, 'agent-contexts.jsonl'),
        'utf8',
      );
      expect(contexts).not.toContain('"role":"observer"');
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

test('background summaries start only after exploration, using a separate model', async () => {
  const run = await factory('responses', 'Export issues', 'observer');
  try {
    await vi.waitFor(
      () => {
        expect(run.stderr()).toMatch(/Which export format\?[\s\S]*\n>\n$/);
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
      'Observer: Current delivery stage: Implementing (attempt 1).',
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
      contexts.findIndex(({ role }) => role === 'implementation'),
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
      expect(payload.events).not.toContainEqual(
        expect.objectContaining({ kind: 'reasoning', agent: 'exploration' }),
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
}, 20_000);

test.each([
  ['observer-thinking', true],
  ['observer-no-reasoning', false],
] as const)(
  'Observer reports provider thinking during generation and tolerates unavailable reasoning (%s)',
  async (mode, hasReasoning) => {
    const run = await factory('responses', 'Export issues', mode);
    try {
      run.child.stdin.end('CSV\nStart\n');
      expect(await run.exit, run.stderr()).toEqual([0, null]);
      const observations = (
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
        )
        .filter(({ role }) => role === 'observer');
      expect(observations.length).toBeGreaterThan(0);
      const firstThinking = observations.find(({ payload }) =>
        payload.events.some((event) => event.kind === 'reasoning'),
      );
      expect(Boolean(firstThinking)).toBe(hasReasoning);
      if (hasReasoning) {
        expect(firstThinking!.payload.events).not.toContainEqual(
          expect.objectContaining({ kind: 'tool', agent: 'implementation' }),
        );
        expect(run.stderr()).toContain(
          'Observer: implementation is considering: Offline reasoning summary.',
        );
      } else {
        expect(run.stderr()).toContain(
          'Observer: Current delivery stage: Implementing (attempt 1).',
        );
        expect(run.stderr()).not.toContain('Offline reasoning summary.');
      }
      expect(JSON.stringify(observations)).not.toContain('encrypted-test-');
      expect(JSON.stringify(observations)).not.toContain('test-key');
      expect(deliveryResultSchema.parse(JSON.parse(run.stdout())).status).toBe(
        'ready',
      );
      expect(run.stdout()).not.toContain('Offline reasoning summary.');
      await run.assertStopped();
    } finally {
      await run.clean();
    }
  },
  20_000,
);

test('debug cancellation closes streaming output and stops the owned router', async () => {
  const run = await factory(
    'responses',
    'Export issues',
    'slow-implementation',
    true,
    true,
  );
  try {
    run.child.stdin.write('CSV\nStart\n');
    await vi.waitFor(
      () => {
        expect(run.stderr()).toContain('implementation · Started');
      },
      { timeout: 10_000 },
    );
    run.child.kill('SIGINT');
    expect(await run.exit, run.stderr()).toEqual([130, null]);
    expect(run.stdout()).toBe('');
    expect(run.stderr()).toContain('Cancelled.');
    expect(run.stderr()).not.toContain('implementation · Completed');
    expect(run.stderr()).not.toContain('test-key');
    await run.assertStopped();
  } finally {
    await run.clean();
  }
}, 20_000);

test('empty observer summaries stay silent without disabling delivery', async () => {
  const run = await factory('responses', 'Export issues', 'observer-silent');
  try {
    run.child.stdin.end('CSV\nStart\n');
    expect(await run.exit, run.stderr()).toEqual([0, null]);
    expect(
      await readFile(join(run.directory, 'agent-contexts.jsonl'), 'utf8'),
    ).toContain('"role":"observer"');
    expect(run.stderr()).not.toContain('Observer:');
    expect(deliveryResultSchema.parse(JSON.parse(run.stdout())).status).toBe(
      'ready',
    );
    await run.assertStopped();
  } finally {
    await run.clean();
  }
}, 20_000);

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
      expect(run.stderr()).not.toContain('Preparing delivery');
      const artifacts = await findRunDirectory(run.source);
      await expect(readdir(join(artifacts, 'repository'))).rejects.toThrow();
      await expect(readFile(join(artifacts, 'input.json'))).rejects.toThrow();
      expect(
        JSON.parse(await readFile(join(artifacts, 'execution.json'), 'utf8')),
      ).toMatchObject({
        outcome: 'failed',
        lastStep: { step: 'explore-issue', status: 'failed' },
      });
      expect(run.stdout()).not.toContain('test-key');
      expect(run.stderr()).not.toContain('test-key');
      await run.assertStopped();
    } finally {
      await run.clean();
    }
  },
  20_000,
);

test('stateless Responses replays tool history when encrypted reasoning is unavailable', async () => {
  const run = await factory(
    'responses',
    'Export issues',
    'no-encrypted-reasoning',
    false,
  );
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
}, 20_000);

test('EOF fails without inventing an answer or preparing a repository', async () => {
  const run = await factory('responses', 'Export issues');
  try {
    run.child.stdin.end();
    expect(await run.exit).toEqual([1, null]);
    expect(run.stdout()).toBe('');
    expect(run.stderr()).toContain('Input ended before the workflow finished');
    const artifacts = await findRunDirectory(run.source);
    await expect(readdir(join(artifacts, 'repository'))).rejects.toThrow();
    await expect(readFile(join(artifacts, 'input.json'))).rejects.toThrow();
    expect(
      JSON.parse(await readFile(join(artifacts, 'execution.json'), 'utf8')),
    ).toMatchObject({
      outcome: 'failed',
      lastStep: { step: 'explore-issue', status: 'failed' },
    });
    await run.assertStopped();
  } finally {
    await run.clean();
  }
}, 20_000);

test.each([
  ['chat', 'implementation-blocked'],
  ['responses', 'implementation-blocked-with-plan'],
])(
  'implementation reports genuine blockers without prompting after plan confirmation (%s, %s)',
  async (api, mode) => {
    const run = await factory(api, 'Export issues', mode);
    try {
      run.child.stdin.end('CSV\nStart\n');
      expect(await run.exit, run.stderr()).toEqual([1, null]);
      expect(
        deliveryResultSchema.parse(JSON.parse(run.stdout())),
      ).toMatchObject({
        status: 'blocked',
        reason: 'Missing external API contract.',
        rounds: 0,
        attempts: 1,
        revision: null,
        summary: null,
        pullRequestUrl: null,
      });
      expect(run.stderr()).not.toContain('Input ended');
      expect(run.stderr()).not.toContain('Implement this brief?');
      expect(run.stderr()).not.toContain(
        'STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED',
      );
      expect(run.stderr()).toContain('Implementing');
      const contexts = await readFile(
        join(run.directory, 'agent-contexts.jsonl'),
        'utf8',
      );
      expect(contexts).not.toContain('"role":"inspection"');
      expect(contexts).not.toContain('"role":"qa"');
      expect(contexts).not.toContain('"role":"review"');
      expect(contexts).not.toContain('"role":"summary"');
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
      if (stage === 'issue')
        await expect(
          readdir(join(run.source, '.darkfactory')),
        ).rejects.toThrow();
      else {
        const artifacts = await findRunDirectory(run.source);
        expect(
          JSON.parse(await readFile(join(artifacts, 'execution.json'), 'utf8')),
        ).toMatchObject({
          outcome: 'cancelled',
          lastStep: {
            step: stage === 'exploration' ? 'explore-issue' : 'implement',
            status: 'cancelled',
          },
        });
        if (stage === 'exploration') {
          await expect(
            readdir(join(artifacts, 'repository')),
          ).rejects.toThrow();
          await expect(
            readFile(join(artifacts, 'input.json')),
          ).rejects.toThrow();
        }
      }
      await run.assertStopped();
    } finally {
      await run.clean();
    }
  },
  20_000,
);

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';
import { hostCommand } from '../src/integrations/git/command.js';
import { brief } from './fixtures/brief.js';
import { deliveryConfig } from './fixtures/delivery.js';

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No port.');
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return address.port;
}

async function factory(
  api = 'responses',
  issue?: string,
  mode = 'normal',
  observerEnabled = true,
) {
  const directory = await mkdtemp(join(tmpdir(), 'darkfactory-cli-'));
  const source = join(directory, 'source');
  await mkdir(source);
  const git = (args: string[]) =>
    hostCommand(
      'git',
      [
        '-C',
        source,
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      new AbortController().signal,
    );
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Test']);
  await git(['config', 'user.email', 'test@example.com']);
  await writeFile(join(source, 'original.txt'), 'original');
  await writeFile(
    join(source, 'package.json'),
    JSON.stringify({ scripts: { test: 'node check.cjs' } }),
  );
  await git(['add', '.']);
  await git(['commit', '-m', 'initial']);
  const routerPort = await port();
  await writeFile(join(directory, 'result.json'), JSON.stringify(brief));
  await writeFile(
    join(directory, 'project-plan.json'),
    JSON.stringify({
      allowedPaths: deliveryConfig.allowedPaths,
      checks: deliveryConfig.checks,
      targets: [],
    }),
  );
  const configPath = join(directory, 'factory.json');
  await writeFile(
    configPath,
    JSON.stringify({
      model: { api, baseUrl: `http://127.0.0.1:${routerPort}/v1` },
      observer: {
        enabled: observerEnabled,
        intervalMs: 1_000,
        ...(mode.startsWith('observer') ? { modelId: 'observer-model' } : {}),
      },
      router: {
        command: process.execPath,
        args: [
          fileURLToPath(new URL('./fixtures/router.mjs', import.meta.url)),
          String(routerPort),
          join(directory, 'result.json'),
          mode,
        ],
      },
    }),
  );
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../dist/cli/index.js', import.meta.url)),
      'start',
      '--config',
      configPath,
      ...(issue === undefined ? [] : ['--issue', issue]),
    ],
    {
      cwd: source,
      env: {
        ...process.env,
        DARKFACTORY_API_KEY: 'test-key',
        MASTRA_AUTO_REFRESH_PROVIDERS: 'false',
        NO_COLOR: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
    },
  );
  const exit = once(child, 'close');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return {
    child,
    directory,
    source,
    exit,
    stdout: () => stdout,
    stderr: () => stderr,
    assertStopped: async () => {
      await expect(
        fetch(`http://127.0.0.1:${routerPort}/v1/models`),
      ).rejects.toThrow();
    },
    clean: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await exit;
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
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

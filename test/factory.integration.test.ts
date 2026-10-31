import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';
import { issueBriefSchema } from '../src/contracts/issue.js';
import { brief } from './fixtures/brief.js';

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

async function factory(api = 'responses', issue?: string, mode = 'normal') {
  const directory = await mkdtemp(join(tmpdir(), 'darkfactory-cli-'));
  const routerPort = await port();
  await writeFile(join(directory, 'result.json'), JSON.stringify(brief));
  const configPath = join(directory, 'factory.json');
  await writeFile(
    configPath,
    JSON.stringify({
      model: { api, baseUrl: `http://127.0.0.1:${routerPort}/v1` },
      router: {
        command: process.execPath,
        args: [
          fileURLToPath(new URL('./fixtures/router.mjs', import.meta.url)),
          String(routerPort),
          join(directory, 'result.json'),
          mode,
        ],
      },
      outputDir: 'issues',
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
  'compiled terminal flow: managed router → real Mastra ask → piped answers → JSON (%s API)',
  async (api) => {
    const run = await factory(
      api,
      api === 'chat' ? 'Export filtered issues' : undefined,
    );
    try {
      run.child.stdin.end(
        api === 'chat' ? 'CSV\n' : 'Export filtered issues\n1\n',
      );
      expect(await run.exit, run.stderr()).toEqual([0, null]);
      expect(issueBriefSchema.parse(JSON.parse(run.stdout()))).toEqual(brief);
      const files = await readdir(join(run.directory, 'issues'));
      expect(files).toHaveLength(1);
      expect(
        JSON.parse(
          await readFile(join(run.directory, 'issues', files[0] ?? ''), 'utf8'),
        ),
      ).toEqual(brief);
      expect(run.stderr()).toContain('Which export format?');
      expect(run.stderr()).toContain('Saved');
      expect(run.stdout()).not.toContain('test-key');
      expect(run.stderr()).not.toContain('test-key');
      await run.assertStopped();
    } finally {
      await run.clean();
    }
  },
  20_000,
);

test('EOF fails without inventing an answer or saving a brief', async () => {
  const run = await factory('responses', 'Export issues');
  try {
    run.child.stdin.end();
    expect(await run.exit).toEqual([1, null]);
    expect(run.stdout()).toBe('');
    expect(run.stderr()).toContain('Input ended before exploration finished');
    await expect(readdir(join(run.directory, 'issues'))).rejects.toThrow();
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

test.each([false, true])(
  'cancellation stops the router and pending terminal input (during agent question: %s)',
  async (duringQuestion) => {
    const run = await factory(
      'responses',
      duringQuestion ? 'Export issues' : undefined,
    );
    try {
      await vi.waitFor(
        () => {
          expect(run.stderr()).toContain(
            duringQuestion ? 'Which export format?' : 'Issue\n',
          );
        },
        { timeout: 10_000 },
      );
      run.child.kill('SIGINT');
      expect(await run.exit, run.stderr()).toEqual([130, null]);
      expect(run.stdout()).toBe('');
      await expect(readdir(join(run.directory, 'issues'))).rejects.toThrow();
      await run.assertStopped();
    } finally {
      await run.clean();
    }
  },
  20_000,
);

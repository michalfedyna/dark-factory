import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import type { FactoryConfig } from '../../src/config/schema.js';
import { hostCommand } from '../../src/integrations/git/command.js';
import { brief } from './brief.js';

export async function findRunDirectory(source: string): Promise<string> {
  const root = join(source, '.darkfactory', 'runs');
  const entries = await readdir(root);
  if (entries.length !== 1 || !entries[0])
    throw new Error('Expected one test run directory.');
  return join(root, entries[0]);
}

export async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port.');
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return address.port;
}

export async function installQaAutomation(directory: string) {
  const automation = join(directory, 'automation.mjs');
  await copyFile(new URL('./automation.mjs', import.meta.url), automation);
  await chmod(automation, 0o700);
  const bin = join(directory, 'bin');
  await mkdir(bin);
  await symlink(automation, join(bin, 'agent-browser'));
  await symlink(automation, join(bin, 'agent-device'));
  return bin;
}

export async function installPublicationAutomation(
  directory: string,
  bin: string,
  base: string,
) {
  const git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  await writeFile(
    join(directory, 'publication-fixture.json'),
    JSON.stringify({ git, base }),
  );
  const publication = join(directory, 'publication.mjs');
  await copyFile(new URL('./publication.mjs', import.meta.url), publication);
  await chmod(publication, 0o700);
  await symlink(publication, join(bin, 'git'));
  await symlink(publication, join(bin, 'gh'));
}

export async function createTestRepository(
  directory: string,
  files: Record<string, string | Uint8Array>,
  githubRemote?: string,
) {
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
  if (githubRemote) await git(['remote', 'add', 'origin', githubRemote]);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), content);
  }
  await git(['add', '.']);
  await git(['commit', '-m', 'initial']);
  const base = (await git(['rev-parse', 'HEAD'])).trim();
  return { source, git, base };
}

export async function startCompiledFactory(options: {
  directory: string;
  source: string;
  cwd?: string;
  api: string;
  issue?: string;
  mode?: string;
  observerEnabled?: boolean;
  debug?: boolean;
  npmScript?: 'dev' | 'start';
  path?: string;
  timeoutMs?: number;
  isolation?: FactoryConfig['sandbox']['isolation'];
}) {
  const { directory, source, api, issue, mode = 'normal' } = options;
  const port = await availablePort();
  const resultPath = join(directory, 'brief.json');
  const configPath = join(directory, 'factory.json');
  await writeFile(resultPath, JSON.stringify(brief));
  await writeFile(
    configPath,
    JSON.stringify({
      model: { api, baseUrl: `http://127.0.0.1:${port}/v1` },
      ...(options.isolation
        ? { sandbox: { isolation: options.isolation } }
        : {}),
      observer: {
        enabled: options.observerEnabled ?? true,
        intervalMs: 1_000,
        ...(mode.startsWith('observer') ? { modelId: 'observer-model' } : {}),
      },
      router: {
        command: process.execPath,
        args: [
          fileURLToPath(new URL('./router.mjs', import.meta.url)),
          String(port),
          resultPath,
          mode,
        ],
      },
    }),
  );
  const factoryArguments = [
    'start',
    '--config',
    configPath,
    ...(issue === undefined ? [] : ['--issue', issue]),
    ...(options.debug ? ['--debug'] : []),
  ];
  const command = options.npmScript ? 'npm' : process.execPath;
  const args = options.npmScript
    ? [
        '--silent',
        '--prefix',
        fileURLToPath(new URL('../../', import.meta.url)),
        'run',
        options.npmScript,
        '--',
        ...factoryArguments,
      ]
    : [
        fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url)),
        ...factoryArguments,
      ];
  const child = spawn(command, args, {
    cwd: options.cwd ?? source,
    env: {
      ...process.env,
      ...(options.path ? { PATH: options.path } : {}),
      DARKFACTORY_API_KEY: 'test-key',
      MASTRA_AUTO_REFRESH_PROVIDERS: 'false',
      NO_COLOR: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: options.timeoutMs ?? 15_000,
  });
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
        fetch(`http://127.0.0.1:${port}/v1/models`),
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

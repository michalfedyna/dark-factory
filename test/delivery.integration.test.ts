import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { hostCommand } from '../src/integrations/git/command.js';
import { deliveryResultSchema } from '../src/contracts/delivery.js';
import { brief } from './fixtures/brief.js';
import { deliveryConfig } from './fixtures/delivery.js';

async function availablePort() {
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

test.each([
  ['chat', 'delivery', 1],
  ['responses', 'delivery', 1],
  ['responses', 'delivery-qa-repair', 2],
  ['chat', 'delivery-review-repair', 2],
] as const)(
  'compiled workflow: four agents, real workspaces, stub UI tools and optional repair (%s, %s)',
  async (api, mode, rounds) => {
    const directory = await mkdtemp(
      join(tmpdir(), 'darkfactory-delivery-e2e-'),
    );
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const source = join(directory, 'source');
      await mkdir(source);
      const signal = new AbortController().signal;
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
          signal,
        );
      await git(['init', '-b', 'main']);
      await git(['config', 'user.name', 'Test']);
      await git(['config', 'user.email', 'test@example.com']);
      await writeFile(join(source, 'original.txt'), 'original');
      await git(['add', '.']);
      await git(['commit', '-m', 'initial']);
      const base = (await git(['rev-parse', 'HEAD'])).trim();
      await writeFile(join(source, 'original.txt'), 'user work');
      const automation = join(directory, 'automation.mjs');
      await copyFile(
        new URL('./fixtures/automation.mjs', import.meta.url),
        automation,
      );
      await chmod(automation, 0o700);
      const port = await availablePort();
      const resultPath = join(directory, 'brief.json');
      await writeFile(resultPath, JSON.stringify(brief));
      const configPath = join(directory, 'factory.json');
      await writeFile(
        configPath,
        JSON.stringify({
          model: { api, baseUrl: `http://127.0.0.1:${port}/v1` },
          router: {
            command: process.execPath,
            args: [
              fileURLToPath(new URL('./fixtures/router.mjs', import.meta.url)),
              String(port),
              resultPath,
              mode,
            ],
          },
          delivery: {
            ...deliveryConfig,
            checks: [
              {
                id: 'test',
                command: process.execPath,
                args: [
                  '-e',
                  "if (!require('node:fs').readFileSync('feature.txt', 'utf8').startsWith('implemented')) process.exit(1)",
                ],
              },
            ],
            repository: source,
            browserCommand: automation,
            deviceCommand: automation,
            targets: [
              {
                id: 'web',
                kind: 'web',
                url: 'http://localhost:3000',
                start: {
                  command: process.execPath,
                  args: ['-e', 'setInterval(() => {}, 1000)'],
                },
              },
              {
                id: 'ios',
                kind: 'mobile',
                platform: 'ios',
                app: 'com.example.app',
                prepare: {
                  command: process.execPath,
                  args: ['-e', 'process.exit(0)'],
                },
              },
            ],
          },
        }),
      );
      child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL('../dist/cli/index.js', import.meta.url)),
          'start',
          '--config',
          configPath,
          '--issue',
          'Export filtered issues',
          '--deliver',
        ],
        {
          env: {
            ...process.env,
            DARKFACTORY_API_KEY: 'test-key',
            MASTRA_AUTO_REFRESH_PROVIDERS: 'false',
            NO_COLOR: '1',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 20_000,
        },
      );
      const exit = once(child, 'close');
      let stdout = '';
      let stderr = '';
      child.stdout!.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.stdin!.end('CSV\nImplement\nKeep local\n');
      expect(await exit, stderr).toEqual([0, null]);
      const result = deliveryResultSchema.parse(JSON.parse(stdout));
      expect(result.status).toBe('ready');
      expect(result.rounds).toBe(rounds);
      expect(result.pullRequestUrl).toBeNull();
      expect((await git(['rev-parse', 'HEAD'])).trim()).toBe(base);
      expect(await readFile(join(source, 'original.txt'), 'utf8')).toBe(
        'user work',
      );
      expect(
        await readFile(
          join(result.runDirectory, 'repository/feature.txt'),
          'utf8',
        ),
      ).toBe(rounds === 1 ? 'implemented' : 'implemented repaired');
      const evidenceFiles = await readdir(
        join(result.runDirectory, `round-${rounds}`),
      );
      expect(
        evidenceFiles.filter((name) => name.endsWith('.png')),
      ).toHaveLength(2);
      expect(
        await readFile(join(result.runDirectory, 'state.json'), 'utf8'),
      ).toContain('Independently inspected feature.txt');
      await expect(
        readFile(join(result.runDirectory, 'publication.json')),
      ).rejects.toThrow();
      expect(stdout).not.toContain('test-key');
      expect(stderr).not.toContain('test-key');
      await expect(
        fetch(`http://127.0.0.1:${port}/v1/models`),
      ).rejects.toThrow();
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await once(child, 'close');
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
  25_000,
);

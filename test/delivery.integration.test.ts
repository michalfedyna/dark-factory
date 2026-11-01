import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSandbox } from '@mastra/core/workspace';
import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  deliveryResultSchema,
  deliveryStateSchema,
} from '../src/contracts/delivery.js';
import { brief } from './fixtures/brief.js';
import { uiProjectPlan } from './fixtures/delivery.js';
import {
  createTestRepository,
  availablePort,
  installQaAutomation,
  installPublicationAutomation,
  startCompiledFactory,
} from './fixtures/integration.js';

test.each([
  ['chat', 'delivery', 1, undefined],
  ['responses', 'delivery', 1, undefined],
  ...(z.object({ available: z.boolean() }).parse(LocalSandbox.detectIsolation())
    .available
    ? [['responses', 'delivery-native', 1, undefined] as const]
    : []),
  ['chat', 'delivery-responsive', 1, undefined],
  ['responses', 'delivery-responsive', 1, undefined],
  ['chat', 'delivery-long-qa', 1, undefined],
  ['responses', 'delivery-long-qa', 1, undefined],
  ['responses', 'delivery-qa-repair', 2, undefined],
  ['chat', 'delivery-sandbox-qa', 1, undefined],
  ['responses', 'delivery-sandbox-qa', 1, undefined],
  ['responses', 'delivery-sandbox-qa-cli', 1, undefined],
  ['responses', 'delivery-sandbox-qa-repair', 2, undefined],
  ['responses', 'delivery-check-repair', 2, undefined],
  ['chat', 'delivery-server-repair', 2, undefined],
  ['responses', 'delivery-server-repair', 2, undefined],
  ['chat', 'delivery-review-repair', 2, undefined],
  ['responses', 'delivery', 1, 'dev'],
  ['responses', 'delivery', 1, 'start'],
] as const)(
  'default workflow: exploration through delivery with real workspaces and optional repair (%s, %s, %s rounds, npm script %s)',
  async (api, mode, rounds, npmScript) => {
    const directory = await mkdtemp(
      join(tmpdir(), 'darkfactory-delivery-e2e-'),
    );
    let run: Awaited<ReturnType<typeof startCompiledFactory>> | undefined;
    try {
      const { source, git, base } = await createTestRepository(
        directory,
        {
          'original.txt': 'original',
          'package.json': JSON.stringify({
            name: 'test-project',
            scripts: {
              test: 'node check.cjs',
              dev: 'node server.cjs',
              'prepare:ios': 'node install.cjs',
            },
          }),
        },
        'https://github.com/example/project.git',
      );
      await mkdir(join(source, 'nested'));
      await writeFile(join(source, 'original.txt'), 'user work');
      const bin = await installQaAutomation(directory);
      await installPublicationAutomation(directory, bin, base);
      const plan = structuredClone(uiProjectPlan);
      const port = await availablePort();
      const web = plan.targets.find((target) => target.kind === 'web');
      if (!web || web.kind !== 'web') throw new Error('Missing web fixture.');
      web.url = `http://127.0.0.1:${port}`;
      web.start.args = [
        '-e',
        [
          ...(mode === 'delivery-server-repair'
            ? [
                "if (require('node:fs').readFileSync('feature.txt', 'utf8') === 'implemented') { console.error('unable to start FSEvent stream'); process.exit(1); }",
              ]
            : []),
          `require('node:http').createServer((_req, res) => res.end('ready')).listen(${port}, '127.0.0.1');`,
        ].join('\n'),
      ];
      if (mode === 'delivery-check-repair')
        plan.checks[0]!.args = [
          '-e',
          "if (require('node:fs').readFileSync('feature.txt', 'utf8') !== 'implemented repaired') { console.error('Expected repaired feature.'); process.exit(1); }",
        ];
      if (mode === 'delivery-sandbox-qa-cli') plan.targets = [];
      await writeFile(
        join(directory, 'verification-plan.json'),
        JSON.stringify(plan),
      );
      run = await startCompiledFactory({
        directory,
        source,
        cwd: join(source, 'nested'),
        api,
        mode,
        ...((mode === 'delivery-long-qa' || mode === 'delivery-sandbox-qa') &&
        api === 'responses'
          ? { debug: true }
          : {}),
        ...(mode === 'delivery-native' ? { isolation: 'native' as const } : {}),
        ...(npmScript ? { npmScript } : {}),
        issue: 'Export filtered issues',
        path: `${bin}:${process.env.PATH ?? ''}`,
        timeoutMs: 20_000,
      });
      run.child.stdin.end('CSV\nStart\n');
      expect(await run.exit, run.stderr()).toEqual([0, null]);
      const result = deliveryResultSchema.parse(JSON.parse(run.stdout()));
      expect(result.status).toBe('published');
      expect(result.rounds).toBe(rounds);
      expect(result.pullRequestUrl).toBe(
        'https://github.com/example/project/pull/12',
      );
      expect(run.stderr()).not.toContain('Implement this brief?');
      expect(run.stderr()).not.toContain('Push this candidate');
      const contexts = (
        await readFile(join(directory, 'agent-contexts.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              role: string;
              payload?: Record<string, unknown>;
              tools: string[];
            },
        );
      const expectedFields: Record<string, string[]> = {
        implementation: ['task', 'allowedPaths', 'checks', 'repair'],
        qa: ['acceptanceCriteria', 'constraints', 'targets', 'evidence'],
        review: [
          'task',
          'allowedPaths',
          'patch',
          'verification',
          'evidence',
          'acceptanceResults',
          'previousFindings',
        ],
        summary: [
          'issue',
          'implementation',
          'checks',
          'qa',
          'review',
          'findings',
        ],
      };
      if (mode.startsWith('delivery-sandbox-qa'))
        expectedFields['sandbox-qa'] = [
          'acceptanceCriteria',
          'constraints',
          'verification',
          'blockedCriteria',
          'evidence',
        ];
      for (const [role, fields] of Object.entries(expectedFields)) {
        const requests = contexts.filter((context) => context.role === role);
        expect(requests.length, `Missing ${role} request`).toBeGreaterThan(0);
        for (const request of requests)
          expect(Object.keys(request.payload ?? {}).sort()).toEqual(
            [...fields].sort(),
          );
        for (const request of requests)
          expect(request.tools).not.toContain('ask');
      }
      expect(
        contexts.find((context) => context.role === 'exploration')?.tools,
      ).toContain('ask');
      for (const request of contexts.filter(({ role }) => role === 'qa')) {
        expect(request.tools.sort()).toEqual(
          mode === 'delivery-sandbox-qa-cli'
            ? []
            : ['agent_browser', 'agent_device'],
        );
        for (const record of request.payload?.evidence as object[])
          expect(record).not.toHaveProperty('path');
      }
      expect(contexts.find(({ role }) => role === 'review')?.tools).toContain(
        'mastra_workspace_read_file',
      );
      const sandboxRequests = contexts.filter(
        ({ role }) => role === 'sandbox-qa',
      );
      if (mode.startsWith('delivery-sandbox-qa')) {
        expect(sandboxRequests.length).toBeGreaterThan(0);
        for (const request of sandboxRequests) {
          expect(request.tools).toEqual(
            expect.arrayContaining([
              'mastra_workspace_read_file',
              'mastra_workspace_write_file',
              'mastra_workspace_execute_command',
              'mastra_workspace_get_process_output',
              'qa_evidence',
            ]),
          );
        }
        expect(contexts.findIndex(({ role }) => role === 'qa')).toBeLessThan(
          contexts.findIndex(({ role }) => role === 'sandbox-qa'),
        );
      } else expect(sandboxRequests).toHaveLength(0);
      const implementations = contexts.filter(
        (context) => context.role === 'implementation',
      );
      expect(implementations[0]!.payload?.repair).toBeNull();
      expect(implementations[0]!.payload?.checks).toEqual([]);
      expect(contexts.some(({ role }) => role === 'inspection')).toBe(false);
      if (rounds > 1)
        expect(implementations[1]!.payload?.repair).toMatchObject({
          findings: [
            expect.objectContaining({
              source:
                mode === 'delivery-qa-repair' ||
                mode === 'delivery-sandbox-qa-repair' ||
                mode === 'delivery-server-repair'
                  ? 'qa'
                  : mode === 'delivery-check-repair'
                    ? 'checks'
                    : 'review',
            }),
          ],
        });
      if (mode === 'delivery-check-repair') {
        const repair = implementations[1]!.payload?.repair as {
          checkLogs: { checkId: string; exitCode: number; excerpt: string }[];
        };
        expect(repair.checkLogs).toHaveLength(1);
        expect(repair.checkLogs[0]).toMatchObject({
          checkId: 'test',
          exitCode: 1,
        });
        expect(repair.checkLogs[0]?.excerpt).toContain(
          'Expected repaired feature.',
        );
      }
      if (mode === 'delivery-server-repair') {
        const repair = implementations[1]!.payload?.repair as {
          checkLogs: { checkId: string; exitCode: number; excerpt: string }[];
        };
        expect(repair.checkLogs).toHaveLength(1);
        expect(repair.checkLogs[0]).toMatchObject({
          checkId: 'qa-server-web',
          exitCode: 1,
        });
        expect(repair.checkLogs[0]?.excerpt).toContain(
          'unable to start FSEvent stream',
        );
        expect(contexts.filter(({ role }) => role === 'qa')).toHaveLength(1);
        expect(contexts.filter(({ role }) => role === 'review')).toHaveLength(
          1,
        );
      }
      const input = JSON.parse(
        await readFile(join(result.runDirectory, 'input.json'), 'utf8'),
      ) as {
        config: { repository: string; baseBranch: string; githubRepo: string };
        brief: unknown;
      };
      expect(input.config).toMatchObject({
        repository: await realpath(source),
        baseBranch: 'main',
        githubRepo: 'example/project',
      });
      expect(input.brief).toEqual(brief);
      expect(input).toMatchObject({
        sandbox: { isolation: mode === 'delivery-native' ? 'native' : 'none' },
      });
      expect(result.runDirectory).toBe(
        join(await realpath(source), '.darkfactory/runs', result.runId),
      );
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
      ).toHaveLength(
        mode === 'delivery-sandbox-qa-cli'
          ? 0
          : mode === 'delivery-responsive'
            ? 3
            : 2,
      );
      const persisted = await readFile(
        join(result.runDirectory, 'state.json'),
        'utf8',
      );
      if (mode.startsWith('delivery-sandbox-qa')) {
        const state = deliveryStateSchema.parse(JSON.parse(persisted));
        const round = state.history.at(-1)!;
        expect(round.browserQa?.verdict).toBe('blocked');
        expect(round.sandboxQa?.verdict).toBe('pass');
        expect(round.qa?.verdict).toBe('pass');
        expect(round.evidence).toContainEqual(
          expect.objectContaining({ kind: 'sandbox', exitCode: 0 }),
        );
      }
      if (mode === 'delivery-long-qa') {
        const state = deliveryStateSchema.parse(JSON.parse(persisted));
        expect(
          state.history[0]!.evidence.filter(
            (record) => record.kind === 'browser',
          ).length,
        ).toBeGreaterThan(30);
        expect(state.history[0]!.qa?.verdict).toBe('pass');
      }
      expect(persisted).toContain('Independently inspected feature.txt');
      expect(
        (JSON.parse(persisted) as { history: unknown[] }).history,
      ).toHaveLength(rounds);
      if (mode === 'delivery-responsive') {
        const state = deliveryStateSchema.parse(JSON.parse(persisted));
        const viewports = state.history[0]!.evidence.filter(
          (record) => record.operation === 'viewport',
        );
        expect(viewports).toHaveLength(2);
        const commands = await Promise.all(
          viewports.map(async (record) => {
            expect(record).toMatchObject({
              kind: 'browser',
              targetId: 'web',
              revision: result.revision,
              exitCode: 0,
            });
            return JSON.parse(await readFile(record.path, 'utf8')) as {
              output: { args: string[] };
            };
          }),
        );
        expect(commands.map(({ output }) => output.args.slice(-4))).toEqual([
          ['set', 'viewport', '1280', '800'],
          ['set', 'viewport', '390', '844'],
        ]);
      }
      const publication: unknown = JSON.parse(
        await readFile(join(result.runDirectory, 'publication.json'), 'utf8'),
      );
      expect(publication).toMatchObject({
        status: 'published',
        url: result.pullRequestUrl,
      });
      const calls = (
        await readFile(join(directory, 'publication-calls.jsonl'), 'utf8')
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { command: string; args: string[] });
      expect(
        calls.filter(
          (call) => call.command === 'git' && call.args.includes('push'),
        ),
      ).toHaveLength(1);
      expect(
        calls.filter((call) => call.command === 'gh' && call.args[0] === 'pr'),
      ).toHaveLength(1);
      expect(run.stdout()).not.toContain('test-key');
      expect(run.stderr()).not.toContain('test-key');
      await run.assertStopped();
    } finally {
      if (run) await run.clean();
      else await rm(directory, { recursive: true, force: true });
    }
  },
  25_000,
);

test.each(['chat', 'responses'])(
  'implementation scaffolds and verifies an app from an empty README without repository inspection (%s)',
  async (api) => {
    const directory = await mkdtemp(join(tmpdir(), 'darkfactory-scaffold-'));
    let run: Awaited<ReturnType<typeof startCompiledFactory>> | undefined;
    try {
      const { source, git, base } = await createTestRepository(directory, {
        'README.md': '',
      });
      const port = await availablePort();
      const bin = await installQaAutomation(directory);
      const verification = {
        checks: [
          { id: 'build', command: 'npm', args: ['run', 'build'] },
          { id: 'test', command: 'npm', args: ['test'] },
        ],
        targets: [
          {
            id: 'web',
            kind: 'web',
            url: `http://127.0.0.1:${port}`,
            start: { command: 'npm', args: ['run', 'dev', '--', String(port)] },
          },
        ],
      };
      await writeFile(
        join(directory, 'verification-plan.json'),
        JSON.stringify(verification),
      );
      run = await startCompiledFactory({
        directory,
        source,
        api,
        mode: 'delivery-scaffold',
        issue: 'Build a new app',
        path: `${bin}:${process.env.PATH ?? ''}`,
        timeoutMs: 25_000,
      });
      run.child.stdin.end('CSV\nStart\n');
      const exit = await run.exit;
      const result = deliveryResultSchema.parse(JSON.parse(run.stdout()));
      const state = JSON.parse(
        await readFile(join(result.runDirectory, 'state.json'), 'utf8'),
      ) as {
        history: {
          evidence: {
            kind: string;
            operation: string;
            exitCode: number;
            path: string;
          }[];
        }[];
      };
      const logs = await Promise.all(
        state.history.flatMap(({ evidence }) =>
          evidence
            .filter(({ kind }) => kind === 'check')
            .map(({ path }) => readFile(path, 'utf8')),
        ),
      );
      expect(exit, `${run.stderr()}\n${logs.join('\n')}`).toEqual([0, null]);
      expect(result).toMatchObject({ status: 'ready', rounds: 1 });
      const repository = join(result.runDirectory, 'repository');
      expect(
        JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')),
      ).toMatchObject({
        scripts: {
          dev: 'node server.cjs',
          build: 'node --check server.cjs',
          test: 'node --test check.cjs',
        },
      });
      expect(
        JSON.parse(
          await readFile(join(repository, 'package-lock.json'), 'utf8'),
        ),
      ).toMatchObject({ name: 'scaffolded-app', lockfileVersion: 3 });
      expect(
        state.history[0]?.evidence.filter(({ kind }) => kind === 'check'),
      ).toEqual([
        expect.objectContaining({ operation: 'build', exitCode: 0 }),
        expect.objectContaining({ operation: 'test', exitCode: 0 }),
      ]);
      expect(state.history[0]?.evidence).toContainEqual(
        expect.objectContaining({ kind: 'screenshot', exitCode: 0 }),
      );
      const contexts = await readFile(
        join(directory, 'agent-contexts.jsonl'),
        'utf8',
      );
      expect(contexts).not.toContain('"role":"inspection"');
      expect(contexts).toContain('mastra_workspace_execute_command');
      expect(run.stderr()).not.toContain('Inspecting repository');
      expect((await git(['rev-parse', 'HEAD'])).trim()).toBe(base);
      expect((await git(['status', '--short'])).trim()).toBe(
        '?? .darkfactory/',
      );
      await expect(readFile(join(source, 'package.json'))).rejects.toThrow();
      await run.assertStopped();
    } finally {
      if (run) await run.clean();
      else await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

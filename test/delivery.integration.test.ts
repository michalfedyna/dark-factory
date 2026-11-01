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
import { expect, test } from 'vitest';
import { deliveryResultSchema } from '../src/contracts/delivery.js';
import { brief } from './fixtures/brief.js';
import { uiProjectPlan } from './fixtures/delivery.js';
import {
  createTestRepository,
  installQaAutomation,
  installPublicationAutomation,
  startCompiledFactory,
} from './fixtures/integration.js';

test.each([
  ['chat', 'delivery', 1, undefined],
  ['responses', 'delivery', 1, undefined],
  ['responses', 'delivery-qa-repair', 2, undefined],
  ['responses', 'delivery-check-repair', 2, undefined],
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
      if (mode === 'delivery-check-repair')
        plan.checks[0]!.args = [
          '-e',
          "if (require('node:fs').readFileSync('feature.txt', 'utf8') !== 'implemented repaired') { console.error('Expected repaired feature.'); process.exit(1); }",
        ];
      await writeFile(
        join(directory, 'project-plan.json'),
        JSON.stringify(plan),
      );
      run = await startCompiledFactory({
        directory,
        source,
        cwd: join(source, 'nested'),
        api,
        mode,
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
        inspection: ['task'],
        implementation: ['task', 'allowedPaths', 'checks', 'repair'],
        qa: ['acceptanceCriteria', 'constraints', 'targets', 'evidence'],
        review: [
          'task',
          'allowedPaths',
          'patch',
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
      const implementations = contexts.filter(
        (context) => context.role === 'implementation',
      );
      expect(implementations[0]!.payload?.repair).toBeNull();
      if (rounds > 1)
        expect(implementations[1]!.payload?.repair).toMatchObject({
          findings: [
            expect.objectContaining({
              source:
                mode === 'delivery-qa-repair'
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
      ).toHaveLength(2);
      const persisted = await readFile(
        join(result.runDirectory, 'state.json'),
        'utf8',
      );
      expect(persisted).toContain('Independently inspected feature.txt');
      expect(
        (JSON.parse(persisted) as { history: unknown[] }).history,
      ).toHaveLength(rounds);
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

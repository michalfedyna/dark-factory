import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { factoryConfigSchema } from '../src/config/schema.js';
import type { DeliveryRound } from '../src/contracts/delivery.js';
import type { VerificationPlan } from '../src/contracts/project.js';
import { createDeliveryRuntime } from '../src/delivery/runtime.js';
import { canRunQa } from '../src/delivery/policy.js';
import { brief } from './fixtures/brief.js';
import { implementation } from './fixtures/delivery.js';
import { createTestRepository } from './fixtures/integration.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

test.each([0, 1])(
  'native preparation mutations retain logs and require a fresh candidate (exit %s)',
  async (exitCode) => {
    const directory = await mkdtemp(
      join(tmpdir(), 'darkfactory-check-mutation-'),
    );
    directories.push(directory);
    const { source, base } = await createTestRepository(directory, {
      'package.json': JSON.stringify({ scripts: { ios: 'expo start --ios' } }),
    });
    const signal = new AbortController().signal;
    const observe = vi.fn();
    const runtime = createDeliveryRuntime({
      repository: {
        repository: source,
        baseBranch: 'main',
        baseRevision: base,
        githubRepo: null,
      },
      ...factoryConfigSchema.parse({}),
      apiKey: 'private-key',
      runId: 'mutation',
      signal,
      progress: () => {},
      observe,
    });
    try {
      await runtime.operations.prepare(brief, signal);
      const repositoryPath = join(
        source,
        '.darkfactory/runs/mutation/repository',
      );
      await writeFile(join(repositoryPath, 'feature.txt'), 'implemented');
      const candidate = await runtime.operations.capture(signal);
      const mobileTarget = {
        id: 'ios',
        kind: 'mobile',
        platform: 'ios',
        app: 'com.example.app',
        screenshots: true,
        prepare: { command: process.execPath, args: ['-e', ''] },
      } satisfies VerificationPlan['targets'][number];
      const preparation = [
        `require('node:fs').writeFileSync('package.json', JSON.stringify({ scripts: { ios: 'expo run:ios' } }));`,
        `console.error('Preparation output');`,
        `process.exit(${exitCode});`,
      ].join('\n');
      const round: DeliveryRound = {
        ...candidate,
        round: 1,
        implementation: {
          ...implementation,
          verification: {
            checks: [
              { id: 'test', command: process.execPath, args: ['-e', ''] },
            ],
            targets: [
              {
                ...mobileTarget,
                prepare: {
                  command: process.execPath,
                  args: ['-e', preparation],
                },
              },
            ],
          },
        },
        evidence: [],
        qa: null,
        review: null,
        findings: [],
      };
      const checked = await runtime.operations.checks(round, signal);
      expect(canRunQa(checked)).toBe(false);
      expect(round.evidence).toEqual([]);
      expect(round.findings).toEqual([]);
      expect(checked.evidence.map((record) => record.operation)).toEqual([
        'test',
        'prepare-ios',
        'candidate-unchanged',
      ]);
      expect(checked.findings).toHaveLength(exitCode ? 2 : 1);
      expect(checked.findings.at(-1)).toMatchObject({
        source: 'checks',
        kind: 'defect',
        severity: 'blocking',
        evidenceIds: ['r1-e3'],
      });
      expect(await readFile(checked.evidence[1]!.path, 'utf8')).toContain(
        'Preparation output',
      );
      expect(await readFile(checked.evidence[2]!.path, 'utf8')).toContain(
        'changed the candidate',
      );
      await runtime.operations.record({
        brief,
        baseRevision: base,
        round: 1,
        status: 'repair',
        reason: '',
        history: [checked],
        summary: null,
      });
      const saved: unknown = JSON.parse(
        await readFile(
          join(source, '.darkfactory/runs/mutation/state.json'),
          'utf8',
        ),
      );
      expect(saved).toMatchObject({
        history: [{ evidence: checked.evidence, findings: checked.findings }],
      });

      // Implementation accepts the setup changes and supplies source-preserving preparation.
      const repaired = await runtime.operations.capture(signal);
      const next = await runtime.operations.checks(
        {
          ...round,
          ...repaired,
          round: 2,
          implementation: {
            ...implementation,
            verification: {
              checks: [
                { id: 'test', command: process.execPath, args: ['-e', ''] },
              ],
              targets: [mobileTarget],
            },
          },
        },
        signal,
      );
      expect(repaired.revision).not.toBe(candidate.revision);
      expect(canRunQa(next)).toBe(true);
      expect(
        next.evidence.every((record) => record.revision === repaired.revision),
      ).toBe(true);
      expect(next.evidence[0]?.id).toBe('r2-e1');
    } finally {
      await runtime.close();
    }
  },
);

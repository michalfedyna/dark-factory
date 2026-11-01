import {
  verificationPlanSchema,
  projectSchema,
} from '../../src/contracts/project.js';
import type { DeliveryState } from '../../src/contracts/delivery.js';
import { brief } from './brief.js';

export function candidateState(): DeliveryState {
  return {
    brief: structuredClone(brief),
    baseRevision: 'base',
    round: 1,
    status: 'repair',
    reason: '',
    summary: null,
    implementationAttempts: [
      {
        attempt: 1,
        result: structuredClone(implementation),
        candidateRound: 1,
      },
    ],
    history: [
      {
        round: 1,
        revision: 'revision',
        tree: 'tree',
        implementation: structuredClone(implementation),
        evidence: [
          {
            id: 'test',
            revision: 'revision',
            kind: 'check',
            targetId: null,
            operation: 'test',
            exitCode: 0,
            path: 'test.json',
          },
        ],
        findings: [],
        qa: null,
        review: null,
      },
    ],
  };
}

export const verificationPlan = verificationPlanSchema.parse({
  checks: [
    {
      id: 'test',
      command: process.execPath,
      args: [
        '-e',
        "if (require('node:fs').readFileSync('feature.txt', 'utf8') !== 'implemented') process.exit(1)",
      ],
    },
  ],
});

export const implementation = {
  summary: 'Implemented.',
  blockers: [],
  verification: verificationPlan,
};

export const projectPlan = {
  ...projectSchema.parse({
    repository: '.',
    baseBranch: 'main',
    githubRepo: 'example/project',
    baseRevision: 'base',
  }),
  ...verificationPlan,
};

export const uiProjectPlan = verificationPlanSchema.parse({
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
      prepare: { command: process.execPath, args: ['-e', 'process.exit(0)'] },
    },
  ],
});

export const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJXkAAAAASUVORK5CYII=',
  'base64',
);

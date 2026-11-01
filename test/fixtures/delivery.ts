import { deliveryConfigSchema } from '../../src/config/delivery.js';

export const deliveryConfig = deliveryConfigSchema.parse({
  repository: '.',
  baseBranch: 'main',
  githubRepo: 'example/project',
  trustedLocalExecution: true,
  isolation: 'none',
  allowedPaths: ['feature.txt'],
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

export const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJXkAAAAASUVORK5CYII=',
  'base64',
);

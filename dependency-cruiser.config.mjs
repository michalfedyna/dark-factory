/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: 'keep-delivery-policy-out-of-integrations',
      severity: 'error',
      from: { path: '^src/integrations/' },
      to: { path: '^src/delivery/' },
    },
    {
      name: 'no-circular-dependencies',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-unresolved-imports',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-dev-dependencies-in-source',
      severity: 'error',
      from: { path: '^src/' },
      to: { dependencyTypes: ['npm-dev'] },
    },
    {
      name: 'no-test-imports-in-source',
      severity: 'error',
      from: { path: '^src/' },
      to: { path: '^test/' },
    },
    {
      name: 'keep-cli-out-of-other-modules',
      comment: 'Configuration and factory modules must not depend on the CLI.',
      severity: 'error',
      from: { path: '^src/', pathNot: '^src/cli/' },
      to: { path: '^src/cli/' },
    },
    {
      name: 'keep-contracts-independent',
      severity: 'error',
      from: { path: '^src/contracts/' },
      to: { path: '^src/', pathNot: '^src/contracts/' },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
  },
};

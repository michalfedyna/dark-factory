# DarkFactory

A TypeScript CLI using Commander. The current implementation displays help and
the version from `package.json`.

## Requirements

- Node.js 22.18+ on 22.x, 24.11+ on 24.x, or 26+
- npm

## Setup and usage

```sh
npm install
npm run build
npm start -- --help
npm start -- --version
```

To use the `dark` executable after building:

```sh
npm link
dark --help
dark --version
```

Running without arguments shows help. `-h` and `-V` are aliases for `--help` and
`--version`. Unknown options and unexpected arguments exit with code 1.

## Development

| Command                 | Behavior                                                                    |
| ----------------------- | --------------------------------------------------------------------------- |
| `npm run dev -- --help` | Run the TypeScript CLI with tsx.                                            |
| `npm run build`         | Compile `src/` into `dist/`.                                                |
| `npm run typecheck`     | Type-check source and tests without emitting files.                         |
| `npm run lint`          | Run ESLint, including type-aware TypeScript rules.                          |
| `npm run lint:fix`      | Apply automatic ESLint fixes.                                               |
| `npm run format:check`  | Check Prettier formatting.                                                  |
| `npm run format`        | Apply Prettier formatting.                                                  |
| `npm test`              | Build and run all Vitest tests, including the compiled CLI tests.           |
| `npm run test:unit`     | Run tests excluding `*.integration.test.ts`, without building.              |
| `npm run test:coverage` | Build and run tests with V8 coverage reports in `coverage/`.                |
| `npm run test:mutation` | Run Stryker mutation testing on `src/**/*.ts`.                              |
| `npm run deps:check`    | Check imports and module boundaries with dependency-cruiser.                |
| `npm run knip`          | Check for unused files, exports, and dependencies.                          |
| `npm run check`         | Run formatting, linting, type checking, dependency checks, Knip, and tests. |

Dependency rules reject cycles, unresolved imports, source imports of tests or
development dependencies, and imports of `src/cli/` from other source modules.
Stryker requires a mutation score of at least 80% and writes reports to
`reports/mutation/`.

`npm pack` builds the CLI before packaging it.

## Git hooks

The postinstall script installs Lefthook hooks when both `.git` and Lefthook are
present. It skips installation otherwise. Run `npm run hooks:install` to install
them manually.

- **pre-commit:** runs `npm run check`.
- **commit-msg:** runs commitlint with the Conventional Commits preset in strict
  mode, so warnings also fail the check.

For example:

```text
feat(cli): add a command
fix: handle empty input
```

Run `npm run hooks:check` to run the pre-commit hook without committing.

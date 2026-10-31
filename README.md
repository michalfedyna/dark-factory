# DarkFactory

An autonomous software factory powered by AI agents.

## Requirements

- Node.js 22.18+ on 22.x, 24.11+ on 24.x, or 26+ (required by the development tools)
- npm

## Setup

```sh
npm install
npm run build
```

To make `dark` available in your shell after building:

```sh
npm link
dark --help
dark --version
```

You can also run it without linking:

```sh
npm start -- --help
npm start -- --version
```

Running `dark` without arguments shows help. `-h` and `-V` are aliases for
`--help` and `--version`. Invalid options or arguments exit with code 1.
The version comes from `package.json`.

## Development

```sh
npm run dev -- --help
npm run build
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:coverage
npm run test:mutation
npm run deps:check
npm run knip
npm run check
```

- `dev` runs TypeScript directly with tsx.
- `build` compiles `src/` into `dist/`.
- `typecheck` checks source and tests without writing files.
- `lint` runs ESLint with type-aware TypeScript rules. `lint:fix` applies automatic fixes.
- `format:check` checks Prettier formatting. `format` formats source, tests, configuration, and docs.
- `test` builds the CLI and runs Vitest unit, property, and executable integration tests.
- `test:unit` runs source-level tests without building the CLI.
- `test:coverage` writes coverage reports to `coverage/`.
- `test:mutation` runs StrykerJS against all TypeScript source files using Vitest.
- `deps:check` uses dependency-cruiser to check module boundaries and imports.
- `knip` finds unused files, exports, and dependencies.
- `check` runs formatting checks, linting, type checking, dependency checks, Knip, and Vitest.

Vitest handles TypeScript and ESM directly, without Jest, ts-jest, or experimental
VM flags. TypeScript 6 checks source and test types separately through `typecheck`
and `check`. It is kept on the latest 6.x release for compatibility with typed
linting, dependency analysis, and mutation testing.

The fast-check properties run 100 generated cases each with a fixed seed. They
check version round trips and rejection of unknown flags. Failures include a seed
and counterexample path for reproduction and shrinking.

Dependency-cruiser rejects cycles, unresolved imports, production imports of test
code or development dependencies, and imports of the CLI from other source
modules, including type-only imports. Knip checks source, tests, and tool
configuration. Its only unused-dependency exception is Clack, which is reserved
for future interactive commands.

Stryker runs the source-level tests, not the compiled executable tests. This makes
sure mutations are tested in the Vitest process instead of being missed in child
processes. Mutation testing does not require a prior build. The minimum mutation
score is 80%; reports are written to `reports/mutation/`, including
`reports/mutation/mutation.html` and `reports/mutation/mutation.json`.

`npm pack` also builds the CLI before packaging it. Installing the packaged CLI
does not require TypeScript or other development dependencies.

## Commits and Git hooks

Commit messages follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

```text
<type>[optional scope][!]: <description>

[optional body]

[optional footers]
```

Examples:

```text
feat(cli): add a new command
fix: handle empty input
feat(config)!: change the configuration format
```

Use one of `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`,
`revert`, `style`, or `test`. The commitlint conventional preset also requires a
lowercase type, a header of at most 100 characters, and a subject without a final
period. Separate the body and footers with blank lines. Breaking changes may use
`!` in the header or a `BREAKING CHANGE:` footer; both are not required.

`npm install` installs Lefthook's Git hooks through the project's `postinstall`
script. It skips hook installation outside a Git checkout or when development
dependencies are absent, so packaged and production-only installs still work.
Use `npm run hooks:install` to reinstall hooks manually, or if installation
scripts were disabled with `--ignore-scripts`.

- **pre-commit:** runs `npm run check` across the whole working tree: formatting,
  linting, type checking, dependency boundaries, Knip, and the full Vitest suite.
  It does not auto-fix files or change what is staged.
- **commit-msg:** runs commitlint against Git's commit message file. Invalid
  messages and convention warnings block the commit.

Run `npm run hooks:check` to try the pre-commit hook without creating a commit,
even when no files are staged.
Mutation testing stays separate: use `npm run test:mutation` when needed.

## Structure

```text
src/cli/index.ts              Executable entry point and package version loading
src/cli/program.ts            Commander command setup
test/cli.test.ts              Command behavior unit tests
test/cli-entry.test.ts        Entry point wiring test
test/cli.integration.test.ts  Compiled CLI integration tests
```

Commander handles commands, flags, help, and version output. Clack is installed
for future interactive prompts and progress output; this scaffold does not start
an interactive session. Keep future configuration and factory logic in separate
modules, outside the CLI layer.

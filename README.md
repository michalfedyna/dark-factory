# DarkFactory

A CLI software factory. Describe an issue, answer the exploration agent's
questions, and get a validated JSON brief. It does **not** change project code yet.

The CLI is the only interface. There is no web app or local UI server.

## Requirements

- Node.js 22.18+ on 22.x, 24.11+ on 24.x, or 26+; npm
- [CLIProxyAPI](https://help.router-for.me/introduction/quick-start.html) v8
- Upstream credentials with access to `gpt-6.1-sol` (Sol 6.1), or another configured
  model that supports tool calls

## Setup

```sh
npm install
brew install cliproxyapi
cp config/router.example.yaml config/router.yaml
cp .env.example .env
```

Skip copying files that you already configured. Set the same private client key
in `config/router.yaml` (`access.api-keys`) and `.env` (`DARKFACTORY_API_KEY`). This
authenticates the factory to the proxy; it is **not** an upstream OpenAI API key.
Both files are gitignored. Environment variables take precedence over `.env`.

Authenticate the proxy once, for example with Codex OAuth:

```sh
cliproxyapi -config config/router.yaml --codex-login
```

Alternatively, configure an upstream provider using the
[router documentation](https://help.router-for.me). The account must expose the
configured model. The factory checks `/v1/models` and waits until
`router.readyTimeoutMs` for credentials/catalogs to load. A temporarily empty
model list is not treated as a permanent failure.

Do not also run a Homebrew proxy service in managed mode. Stop an existing
service on the configured port or explicitly set `router.managed` to `false`.

## Run

```sh
npm run dev -- start
```

The CLI starts the proxy, prompts for an issue, and asks follow-up questions in
the terminal. Choose a suggested answer or select **Other** to write your own.
Questions without suggestions use a text prompt directly.

You can supply the issue up front:

```sh
npm run dev -- start --issue "Export filtered issues as CSV"
```

One invocation explores one issue. When finished, the factory validates the brief,
saves `.darkfactory/issues/<run-uuid>.json`, prints the JSON to stdout, and stops
its proxy child. Prompts, progress, diagnostics, and the saved path go to stderr.
Ctrl+C or Escape cancels without treating silence as approval (exit code 130).

For a built executable:

```sh
npm run build
npm link
dark start
dark start --issue "Export filtered issues as CSV" > brief.json
dark start --config /path/to/factory.config.json
```

Without linking, use `node dist/cli/index.js start` or `npm start -- start`.
Use the built executable when redirecting JSON: npm itself may print script
headers to stdout. Running `dark` without a command still shows help.

### Piped input

When stdin is not a terminal, input is line-oriented. The first line is the issue
unless `--issue` is supplied; each later line answers the next agent question.
You can enter a displayed choice number (starting at 1) or free text. Input is
buffered between model calls. Empty lines are rejected; EOF fails the run rather
than fabricating an answer or approving a brief. Model questions can vary, so do
not assume a fixed answer script is suitable for every real issue.

## Configuration

`factory.config.json` is validated by
[`src/config/schema.ts`](src/config/schema.ts). Unknown fields are rejected.
**The old `ui` section is no longer supported; remove it from custom configs.**

`.env`, router arguments, and output paths are relative to the config directory.
The executable is resolved through `PATH` or an absolute path. Arguments are
passed directly, without a shell.

| Option                  | Default                             | Purpose                                                                |
| ----------------------- | ----------------------------------- | ---------------------------------------------------------------------- |
| `model.id`              | `gpt-6.1-sol`                       | Exact model ID/alias exposed by the proxy.                             |
| `model.baseUrl`         | `http://127.0.0.1:8317/v1`          | OpenAI-compatible API base URL.                                        |
| `model.api`             | `responses`                         | `responses` or `chat`.                                                 |
| `model.apiKeyEnv`       | `DARKFACTORY_API_KEY`               | Environment variable holding the proxy client key.                     |
| `model.maxSteps`        | `30`                                | Maximum model steps, including tool calls.                             |
| `router.managed`        | `true`                              | Own a proxy child; `false` uses an existing endpoint.                  |
| `router.command`        | `cliproxyapi`                       | Proxy executable.                                                      |
| `router.args`           | `["-config", "config/router.yaml"]` | Proxy arguments.                                                       |
| `router.readyTimeoutMs` | `20000`                             | Proxy/model startup deadline.                                          |
| `outputDir`             | `.darkfactory/issues`               | Validated JSON output directory.                                       |
| `sessionTimeoutMs`      | `1800000`                           | Exploration deadline, including time waiting for answers (30 minutes). |

For an existing/remote endpoint, set `router.managed: false` and configure the
model URL, protocol, and key. Managed URLs must be loopback addresses. The factory
never stops a service it did not start. Unexpected proxy exits cancel active model
work and pending input. Proxy logs are not mixed into JSON; run the configured
proxy command directly for its detailed diagnostics.

## Output and boundaries

The versioned Zod schema is in [`src/contracts/issue.ts`](src/contracts/issue.ts).
It defines the problem, outcome, users, scope, prioritized requirements,
Given/When/Then acceptance criteria, constraints, assumptions, decisions, risks,
open questions, and readiness. See [the output contract](docs/issue-brief.md).

The agent asks for confirmation before completion. Zod rejects `ready` briefs
without confirmation or with open questions, empty requirements/acceptance
criteria, duplicate IDs, and unknown fields. Invalid results are not saved.

Cancellation, timeout, input errors, and validation failures stop the run. Active
conversations are not durable across restarts; saved briefs remain on disk. Keep
`.darkfactory/` private because briefs may contain sensitive information.

## Structure

```text
config/                 Proxy template; local config is gitignored
src/
  agents/               Mastra agents and their instructions
  tools/                Agent tools, starting with ask
  contracts/            Zod schemas and boundary types
  config/               Factory configuration validation/loading
  integrations/router/  Proxy process lifecycle and readiness
  factory/              Exploration orchestration and output persistence
  cli/                  Commander commands, Clack prompts, line input, and signals
test/                   Unit and offline integration tests
docs/                   Architecture and output contract
```

See [architecture](docs/architecture.md) for the flow and extension points.

## Development

| Command                 | Behavior                                                     |
| ----------------------- | ------------------------------------------------------------ |
| `npm run build`         | Compile TypeScript into `dist/`; no browser build.           |
| `npm run dev -- start`  | Run the CLI through tsx.                                     |
| `npm run typecheck`     | Type-check source and tests.                                 |
| `npm run lint`          | Type-aware ESLint, zero warnings.                            |
| `npm run format`        | Format with Prettier.                                        |
| `npm run format:check`  | Check formatting.                                            |
| `npm test`              | Build and run unit and compiled CLI integration tests.       |
| `npm run test:unit`     | Test without building, excluding `*.integration.test.ts`.    |
| `npm run test:coverage` | Test with V8 coverage reports.                               |
| `npm run test:mutation` | Run Stryker mutation testing.                                |
| `npm run deps:check`    | Check cycles, imports, and module boundaries.                |
| `npm run knip`          | Check unused files, exports, and dependencies.               |
| `npm run check`         | Formatting, lint, types, dependency checks, Knip, and tests. |

Tests need no upstream credentials. Integration tests start a child test endpoint,
run the actual Mastra agent/tool loop through both OpenAI protocols, answer through
stdin, validate stdout and saved JSON, and verify cancellation/EOF cleanup.

`npm pack` builds before packaging. Postinstall installs Lefthook when `.git` and
Lefthook are present. **pre-commit** runs `npm run check`; **commit-msg** requires
Conventional Commits. Run `npm run hooks:check` to check hooks without committing.

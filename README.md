# DarkFactory

A CLI software factory. The `default` workflow takes an issue through exploration,
optional Figma UI scaffolding, implementation, web/native QA, independent review,
and automatic draft GitHub PR publication.

The CLI is the only interface. There is no web app or local UI server.

## Navigation

- [Setup](#setup), [run](#run), and [configuration](#configuration)
- [Delivery setup, evidence, and limits](docs/delivery.md) — current behavior
- [Figma UI agent and REST setup](docs/figma.md) — design-to-code and repository design systems
- [Architecture and code ownership](docs/architecture.md) — current implementation
- [Issue brief contract](docs/issue-brief.md) — validated exploration output
- [Target workflow design](docs/Workflow.md) — future design, not an implemented feature list

## Requirements

- Node.js 22.18+ on 22.x, 24.11+ on 24.x, or 26+; npm
- [CLIProxyAPI](https://help.router-for.me/introduction/quick-start.html) v8
- Upstream credentials with access to `gpt-6.1-sol` (Sol 6.1), or another configured
  model that supports tool calls

Run inside a trusted Git repository on a local branch with a commit. Project
commands run on the host by default; native isolation is opt-in. Publication needs
an authenticated GitHub CLI; UI QA needs the applicable browser/device tools.
See [workflow setup](docs/delivery.md).

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
configured model. The factory checks `/v1/models` and waits for
credentials/catalogs to load, without a readiness deadline. A temporarily empty
model list is not treated as a permanent failure.

Do not also run a Homebrew proxy service in managed mode. Stop an existing
service on the configured port or explicitly set `router.managed` to `false`.

There is no project-specific factory setup. Run the CLI in the repository you
want to work on, using `--config` to point to your transport configuration if it
lives elsewhere. The config's location never selects the target repository.

## Run

```sh
npm run dev -- start
```

To work on another repository without installing or linking the CLI, run from
that repository:

```sh
npm --prefix /path/to/DarkFactory run dev -- start --config /path/to/DarkFactory/factory.config.json
```

The factory uses the directory where you ran npm, not the `--prefix` directory.
This also applies to `npm --prefix /path/to/DarkFactory start -- start` after a
build. Relative `--config` paths are resolved from the directory where you launch
the command; `.env` and router arguments remain relative to the config file.

The CLI starts the proxy, prompts for an issue, and asks follow-up questions in
the terminal. Choose a suggested answer or select **Other** to write your own.
Questions without suggestions use a text prompt directly.

You can supply the issue up front:

```sh
npm run dev -- start --issue "Export filtered issues as CSV"
```

To see live agent activity instead of Observer summaries:

```sh
npm run dev -- start --debug
# Or: dark start --debug
```

Debug mode streams agent text, provider-exposed reasoning under `Thinking` headings,
tool arguments/results, step usage, errors, and validated results from exploration through delivery. Agent
headings and formatted detail blocks keep the output readable; `NO_COLOR` disables
color and redirected stderr stays plain. The Observer is not started, even when
enabled in config. Prompts remain interactive and stdout is still only the final
validated JSON. Debug output can contain source code, user answers, and other
sensitive data: keep captured logs private. The configured API key and common
credential fields in formatted objects are redacted; this is not a general secret
scanner. The configured Figma token is also redacted. Raw provider headers, encrypted reasoning, and binary image contents are
not printed.

One invocation runs one issue from exploration to delivery. The factory validates
the brief in memory. Confirming the issue plan during exploration is the last
user interaction: implementation owns repository setup, dependency installation,
and scaffolding when needed. It supplies actual check commands and QA targets for
the implemented candidate; the factory independently verifies, repairs in scope,
and publishes a draft PR automatically. Only exploration has `ask`; later agents
cannot prompt or request approval. Genuine external blockers stop the run, but
missing app source, manifests, lockfiles, or scripts are implementation work.
Confirmation also authorizes publication of verification screenshots and a small
manifest. Use trusted repositories, test accounts, and disposable data.
Stdout contains only the final delivery result JSON, not the intermediate brief.
Prompts, progress, diagnostics, and artifact paths go to stderr. The managed proxy
stops when the run ends, including cancellation, crashes, and forced factory termination.
Ctrl+C or Escape cancels without treating silence as approval (exit code 130).

For a built executable:

```sh
npm run build
npm link
dark start
dark start --issue "Export filtered issues as CSV" > delivery.json
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
than fabricating an answer or confirming a plan. Once the plan is confirmed,
stdin can close; no more input is needed.
Model questions can vary, so do not assume a fixed answer script is suitable for
every real issue.

## Configuration

### Repository discovery

`dark start` always runs the registered `default` workflow:
exploration → Figma UI scaffold if linked → implementation/setup → checks → browser/mobile QA → sandbox QA if needed → review → summary → draft PR.
The target is the Git root containing the CLI's working directory; the current
local branch supplies the pinned base. GitHub publication uses `origin`, or a
single unambiguous GitHub remote when origin is absent. Without a usable GitHub
remote, verified work stays local.

There is no repository-inspection agent or pre-implementation plan gate. The
implementation agent reads the pinned checkout using Mastra filesystem/sandbox
tools, follows existing conventions, and creates a scaffold if the task needs one.
A Git repository with an initial commit containing only a README is sufficient.
For issues with Figma links, a dedicated UI-only agent first creates or updates
presentational components and design-system code in the same checkout. Implementation
receives its handoff and owns all functional wiring and subsequent repairs. Set
`FIGMA_ACCESS_TOKEN` to read designs through REST; no token is needed for unlinked
issues. This does not edit Figma files. See [Figma setup and limits](docs/figma.md).
During exploration, the agent can already view linked screens as PNGs, including
links supplied in follow-up answers. It keeps questions product-focused; detailed
design specifications remain the UI agent's responsibility.
Implementation supplies a validated verification plan on every candidate, with at
least one meaningful deterministic check and all required UI targets. No delivery
config is needed. Project sandboxes allow network access for dependency setup and
verification; factory credentials are not passed to them. Changes may span the
repository within the confirmed brief; protected-path and independent review
gates still apply.
QA first uses **agent-browser** for web and **agent-device** for native iOS/Android.
If criteria cannot be checked with those tools, a second QA agent runs sequentially
with full Mastra filesystem and sandbox access to test only those blocked criteria.
It cannot override observed UI failures or repair the candidate.
QA/review defects return to implementation without a repair-round cap;
new candidates always get fresh verification. Exploration confirmation authorizes
the in-scope run through draft PR publication; there are no later user approval prompts.
Without a usable GitHub remote, verified work remains local. Stdout is one final result JSON. Evidence and retained checkouts
live under the target repository's `.darkfactory/runs/<run-id>/`; there is no
separate issue-file output or save step. Work is supervised: there are no agent
step caps, workflow deadlines, command timeouts, or repeated-tree cutoffs. Use
Ctrl+C or Escape to stop a run. Validation, evidence, scope, and publication gates
still apply; genuine external blockers and execution errors can still stop work.

This first provider is for **trusted local repositories**, not hostile code.
See [workflow setup, evidence, and limitations](docs/delivery.md).

### General settings

`factory.config.json` is validated by
[`src/config/schema.ts`](src/config/schema.ts). Unknown fields are rejected.
Only model, observer, router, sandbox execution, and Figma access settings belong here. Remove
the old `model.maxSteps`, `sessionTimeoutMs`, `router.readyTimeoutMs`, `ui`,
`delivery`, and `outputDir` fields from custom configs. Verification commands no
longer accept `timeoutMs`.

`.env` and router arguments are relative to the config directory.
The executable is resolved through `PATH` or an absolute path. Arguments are
passed directly, without a shell.

| Option                  | Default                             | Purpose                                                                                                                  |
| ----------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `model.id`              | `gpt-6.1-sol`                       | Exact model ID/alias exposed by the proxy.                                                                               |
| `model.baseUrl`         | `http://127.0.0.1:8317/v1`          | OpenAI-compatible API base URL.                                                                                          |
| `model.api`             | `responses`                         | `responses` or `chat`.                                                                                                   |
| `model.reasoningEffort` | `medium`                            | Reasoning effort for all agents: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; support varies by model. |
| `model.apiKeyEnv`       | `DARKFACTORY_API_KEY`               | Environment variable holding the proxy client key.                                                                       |
| `observer.enabled`      | `true`                              | Background, user-facing progress summaries on stderr.                                                                    |
| `observer.modelId`      | Same as `model.id`                  | Optional separate model ID on the same proxy, protocol, and credentials.                                                 |
| `observer.intervalMs`   | `15000`                             | Minimum time between summary requests; no requests without new activity.                                                 |
| `observer.timeoutMs`    | `10000`                             | Deadline for each background summary request.                                                                            |
| `router.managed`        | `true`                              | Own a proxy child; `false` uses an existing endpoint.                                                                    |
| `router.command`        | `cliproxyapi`                       | Proxy executable.                                                                                                        |
| `router.args`           | `["-config", "config/router.yaml"]` | Proxy arguments.                                                                                                         |
| `sandbox.isolation`     | `none`                              | Host execution; set `native` to require Seatbelt (macOS) or Bubblewrap (Linux).                                          |
| `figma.tokenEnv`        | `FIGMA_ACCESS_TOKEN`                | Environment variable holding the Figma token; required only for linked designs.                                          |
| `figma.auth`            | `personal`                          | `personal` uses `X-Figma-Token`; `oauth` uses an existing Bearer access token.                                           |

Host execution favors compatibility for trusted local repositories. Commands run
with your account's filesystem and network permissions, even though they use a
separate run checkout and private HOME. Factory credentials are not automatically
inherited by project commands. Set `sandbox.isolation: "native"` to restrict
project commands; a missing native backend then blocks the run without falling
back to host execution. Use a disposable remote/container environment for
untrusted code. Checks, QA, review, and publication gates apply in either mode.

For an existing/remote endpoint, set `router.managed: false` and configure the
model URL, protocol, and key. Managed URLs must be loopback addresses. The factory
never stops a service it did not start. A supervisor watches the factory connection
and stops the owned proxy even if the factory is killed with SIGKILL. On macOS/Linux,
cleanup covers the proxy's process group, including command wrappers; processes
that ignore SIGTERM are killed after three seconds. Unexpected proxy exits cancel active model
work and pending input. Proxy logs are not mixed into JSON; run the configured
proxy command directly for its detailed diagnostics.

Responses requests always use `store: false` for compatibility with stateless
proxies, including CLIProxyAPI with Codex OAuth. All agents replay conversation and
tool content instead of server-side item references. Encrypted reasoning is
requested and replayed when available; reasoning without encrypted content is
omitted by the SDK. Do not enable `store: true` to work around missing-item errors.
No proxy configuration change is needed.

### Agent context

Agents receive role-specific inputs, not the full workflow state or round history.
Exploration can view Figma PNG previews and lightweight screen names/IDs, but has no
repository access or detailed design-inspection tools.
The Figma agent gets the approved task, allowed paths and canonical design sources.
Implementation gets its validated UI handoff when present, the approved task, allowed paths, check commands, and only the
latest repair findings, failed criterion notes, and failed check-log tails.
Browser/mobile QA gets acceptance criteria, constraints, target addresses, and current evidence
metadata without file paths—not implementation claims, setup commands, or logs.
It tests only running application behavior against those criteria, using constrained
browser/device tools with UI captures returned directly. This first QA has no workspace,
filesystem, or shell tools and does not inspect or review files.
Sandbox QA receives only the blocked criteria and reasons, constraints, the current
verification plan, and evidence references. It can read files and run commands,
including API/CLI tests, but cannot change tracked source, tests, or configuration.
Successful criteria require its own recorded sandbox command evidence.
Review gets the task, patch, allowed paths, current acceptance/evidence references,
and the last relevant reviewer feedback. It has full filesystem, shell, and
background-process tools to independently rerun checks and investigate findings,
but must not repair or change the candidate. The PR summary gets only final outcomes.

The workflow still retains complete history for gates and artifacts. Implementation
and review can read needed source and evidence through their role-specific tools;
only the fallback QA has that access. See [agent context](docs/architecture.md#agent-context).

### Background observer

The observer is a separate, tool-free Mastra agent. It turns workflow stages,
agent thinking, tool activity, check outcomes, and delivery gate metadata into short
`Observer:` updates on stderr. It starts only after exploration returns a validated, confirmed,
ready brief, then runs alongside delivery, not as a blocking step.
In a terminal, updates appear as compact accent blocks with a bold cyan heading
and a cyan left border, wrapped to the terminal width. `NO_COLOR` disables color;
redirected stderr keeps plain `Observer: ...` lines. Terminal blocks have blank
lines before and after them.
Exploration activity is not collected or summarized; stale results from a previous
delivery stage are discarded. Final stdout JSON is unchanged.

The observer receives up to 40 new activity events since its last processed update,
the current stage, and its previous report. Consecutive reasoning chunks are combined
into excerpts limited to the latest 2,000 characters each. These are the provider's
exposed reasoning or summaries, not hidden model thoughts or encrypted reasoning.
Responses requests explicitly ask for reasoning summaries; availability and timing
depend on the model and proxy. Models without reasoning output still get normal
activity updates.

Source files, tool arguments/results, and user answers are not forwarded directly.
Reasoning can mention private task or source details, and excerpts are sent to the
configured Observer model. The configured API key is redacted before summarization;
this is not a general secret scanner. Disable the Observer if this is unsuitable.
The Observer describes thinking as tentative investigation, not verified results.
Reports describe only new developments, without recapping earlier progress, and
stay silent when there is nothing new to
report. Tool completion is not proof of passing verification.
Summaries are informational and never approve work or control delivery gates.

It uses `model.id` by default. To use a faster/cheaper model, set
`observer.modelId` to an ID your proxy supports. Summaries incur additional model
calls, at most one at a time, only after new activity. A summary failure disables
summaries for that run and leaves normal stage updates running. Completion,
cancellation, and errors abort background work without waiting for it.
Set `observer.enabled: false` to keep only the existing stage updates.
Use `--debug` to replace summaries with live agent diagnostics for one invocation.

This follows the background-observation pattern from
[Mastra observational memory](https://mastra.ai/docs/memory/observational-memory),
but does not enable conversation compression, a Reflector, or durable memory.
Those solve agent context management rather than live user-facing progress.

## Output and boundaries

Stdout is one validated delivery result, defined in
[`src/contracts/delivery.ts`](src/contracts/delivery.ts). It includes the status,
tested revision, round count, artifact directory, summary, and optional draft PR URL.

The intermediate issue brief is defined in
[`src/contracts/issue.ts`](src/contracts/issue.ts). It describes the problem,
outcome, users, scope, prioritized requirements,
Given/When/Then acceptance criteria, constraints, assumptions, decisions, risks,
open questions, and readiness. See [the output contract](docs/issue-brief.md).

The agent asks for confirmation before completion. Zod rejects `ready` briefs
without confirmation or with open questions, empty requirements/acceptance
criteria, duplicate IDs, and unknown fields. Invalid briefs cannot advance.

Cancellation, input errors, and validation failures stop the run. Active
conversations are not durable across restarts. The brief stays in memory until
approved run artifacts record the workflow inputs and state. There are no separate
issue files. Keep `.darkfactory/` private because artifacts may contain sensitive
information.

## Mastra workflows

`src/workflows/default.ts` defines the single registered `default` workflow in
`src/factory/start.ts`. Its `explore-issue` step validates the brief and passes it
directly to preparation. The CLI starts and cancels one native workflow run.

Delivery uses a nested Mastra repair loop, not a second top-level run.
The loop has no execution-time or repair-round budget. Implementation and review use
separate per-run workspaces and sandboxes. Browser/mobile
QA gets only application-testing tools; conditional sandbox QA gets its own
round-owned workspace and sandbox. Trusted runners capture revision-bound evidence. See
[architecture](docs/architecture.md) and [delivery](docs/delivery.md).

## Structure

```text
config/                 Proxy template; local config is gitignored
src/
  agents/               Mastra agents and their instructions
  workflows/            Native Mastra composition, step schemas, and request context
  delivery/             Delivery operations, resources, policy, evidence, and finishing
  tools/                Ask, Figma REST, browser/device QA, and recorded QA evidence tools
  contracts/            Zod schemas and boundary types
  config/               Factory configuration validation/loading
  integrations/         External Figma, Git, GitHub, and proxy adapters
  factory/              Mastra registration, run lifecycle, and background observation
  cli/                  Commander commands, Clack prompts, line input, and signals
test/                   Unit and offline integration tests
docs/                   Architecture and output contract
```

Start with [`src/workflows/default.ts`](src/workflows/default.ts) for the flow and
[`src/delivery/runtime.ts`](src/delivery/runtime.ts) for delivery composition.
The [architecture guide](docs/architecture.md) maps resource ownership and gates.

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
stdin, scaffold empty repositories, validate final JSON and evidence, and verify
cancellation/EOF cleanup.
Shared repository/process setup lives in `test/fixtures/integration.ts`.
The offline provider separates wire formatting (`provider-protocol.mjs`) from
scenarios (`provider-scenario.mjs`); roles are identified by their input contracts,
not prompt wording. Lifecycle and state regressions are tested separately from
the compiled CLI scenarios.

`npm pack` builds before packaging. Postinstall installs Lefthook when `.git` and
Lefthook are present. **pre-commit** runs `npm run check`; **commit-msg** requires
Conventional Commits. Run `npm run hooks:check` to check hooks without committing.

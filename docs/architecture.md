# CLI software factory

## Boundaries

- `contracts/` defines data and callback interfaces without importing application
  modules. It contains no presentation markup or browser transport state.
- `agents/` defines model behavior. `tools/` adapts the injected `Ask` capability
  into a Mastra tool. Neither depends on terminal rendering.
- `workflows/` defines typed Mastra steps and task-specific workflows. The
  exploration workflow validates the brief and saves it in a separate step.
  Agent execution and saving are injectable for offline tests.
- `factory/` registers workflows with Mastra, adapts CLI cancellation/deadlines to
  workflow runs, maps failures to safe messages, and provides output persistence.
- `integrations/router/` owns only the proxy process it starts. It waits for the
  authenticated model catalog and handles bounded startup/shutdown.
- `cli/` loads config/environment and connects Commander, Clack, stdin/stderr,
  structured stdout, and process signals to the factory.

There is no web app, HTTP UI server, frontend build, React, or OpenUI dependency.
CLIProxyAPI remains the model transport; it is not a user interface.

## Flow

1. `dark start` validates config and loads the adjacent `.env`. An optional
   `--issue` is validated before startup; otherwise the terminal prompts for it.
2. Start the managed proxy without a shell (or connect in unmanaged mode). Wait
   for `/v1/models` to expose the configured model, retrying incomplete catalogs
   until `router.readyTimeoutMs`.
3. Get the registered `exploration` workflow from Mastra and create a native run.
   Start it with the issue as input and the terminal callback and cancellation
   signal in a per-run `RequestContext`. The factory combines process,
   proxy-exit, and exploration-deadline cancellation signals.
4. The `explore-issue` step creates a fresh exploration agent. The agent calls
   `ask` with a validated question and awaits the real user's answer. In a TTY,
   Clack offers choices plus Other or a text prompt. Non-TTY input uses a single
   buffered line reader for the whole run.
5. Validate the answer and continue the same agent run with its tool result.
   Questions execute sequentially. EOF, Escape, and cancellation never produce
   invented answers or implicit confirmation.
6. Validate the final issue brief with Zod. The `save-brief` step writes a private
   exclusive JSON file named with Mastra's run ID and prints only the brief to
   stdout. Show the saved path on stderr.
7. Close terminal input, shut down Mastra, and stop the owned proxy after
   completion or failure.

Without `--deliver`, one invocation only explores one issue. Start another
invocation for another issue.
There is no custom Sessions class, session polling, browser state, or durable
conversation resume. Mastra owns step sequencing, run IDs, and execution status.

## Cancellation and failures

All model/tool work receives an AbortSignal combining the native workflow signal
and the CLI cancellation/deadline signal. Prompts and pending line reads listen to
it. The CLI adapter calls `run.cancel()` on cancellation and also races its wait
against cancellation: Mastra cancellation prevents subsequent steps but cannot
force a non-responsive step to return. Late agent results are checked before the
save step. Run completion closes any remaining tool waits.

Workflow steps are not retried automatically: repeating terminal questions or
file writes would be unsafe. Automatic run recovery is disabled for exploration
because terminal callbacks do not survive process restarts. No workflow snapshot
storage is configured yet. The existing `sessionTimeoutMs` option sets the CLI
deadline for this workflow; it does not refer to a custom session runtime.

Ctrl+C/Escape and termination signals cancel with exit code 130. Startup failures,
EOF, model/schema failures, persistence failures, and timeouts exit with code 1.
The factory closes its proxy in all cases; unmanaged endpoints are never killed.
Raw provider errors are not copied into user-facing error messages.

Structured output uses schema prompt injection to coexist with tool calls through
the compatible proxy. It is still strictly validated. Responses is the default
protocol; Chat Completions is configurable and integration-tested.

## Growing the factory

- Add agents in `agents/` and inject tools instead of importing CLI behavior.
- Add tools in `tools/` with validated inputs and small capability interfaces.
- Define each agent and integration tool in its own file. Share common helpers,
  not role-switching agent or tool definitions.
- Prefer Mastra's existing functionality before building custom infrastructure.
- Add task-specific definitions in `workflows/` and register them with Mastra in
  `factory/start.ts`. Use separate workflows for exploration, implementation, QA,
  or other tasks when their execution flows differ. Reuse steps or nested
  workflows rather than growing one universal workflow or a custom runtime.
- Add versioned contracts before downstream planning or implementation stages.
- Keep terminal rendering and line/TTY behavior in `cli/`.
- Use Mastra workflow storage and suspend/resume when durable execution becomes
  a requirement, without coupling persistence to terminal widgets.

## Implementation and QA environments

Opt-in delivery uses a separate registered workflow. Its native nested
`.dountil()` cycle runs implementation, deterministic checks, QA, independent
review, and the controller's gate. Findings return to implementation within one
shared repair budget. Summary and explicitly approved draft-PR publication happen
only after passing gates. See [delivery](delivery.md) for configuration and the
initial provider's limits.

Each agent owns its instructions, Mastra definition, and output contract in
`agents/exploration.ts`, `agents/implementation.ts`, `agents/qa.ts`,
`agents/review.ts`, or `agents/summary.ts`. `agents/shared.ts` only shares delivery
instructions, model transport configuration, and structured-output generation.

QA's `agent_browser` and `agent_device` tools are defined separately in
`tools/agent-browser.ts` and `tools/agent-device.ts`. Each handles its own CLI
arguments and target kind, including screenshot operations. `tools/qa.ts` only
assembles the integrations required by the configured targets; `tools/qa-command.ts`
shares argument validation, sandbox execution, and evidence recording.

`factory/delivery-runtime.ts` creates run-owned Mastra `Workspace`,
`LocalFilesystem`, and `LocalSandbox` instances. Implementation gets filesystem
and sandbox tools; QA/review filesystem providers are read-only. QA's explicit
tools invoke only configured agent-browser/agent-device binaries through Mastra,
record evidence, and restrict operations and global flags. Project dependency
installs, commands, builds, tests, and background processes use Mastra rather than
a custom command execution layer. See the
[sandbox documentation](https://mastra.ai/docs/sandbox/overview).

Scope environments to a task or workflow run. For resolver-backed workspaces, use
a corresponding `sandboxCacheKey`; keep track of created sandboxes, destroy them
when the task ends, and clear their cache entries. Mastra shutdown does not
destroy resolver-owned sandboxes. Persist hand-off artifacts outside ephemeral
sandboxes before cleanup so QA can reproduce the implementation's changes.

Plain `LocalSandbox` executes on the application host and is not isolation. Use
native isolation or a remote/container provider for untrusted repository code.
Restrict network access and credentials before executing commands, and do not
share mutable environments between unrelated tasks.

The trusted Git/GitHub adapters run outside project sandboxes and own snapshot
commits and authorized publication. The source checkout is cloned at a pinned
local base, and its Git control files live outside the agent filesystem. Native
isolation is the default for project commands but isn't a complete host boundary;
browser/device CLIs run on the trusted local host. No factory API-key environment
is passed to project commands. Local provider limits are explicit in the approval
and documented; use remote/container isolation before supporting hostile code.

Native workflow sequencing and budgets are not a custom session engine. Run
artifacts are persisted for inspection, but delivery doesn't yet configure Mastra
snapshot storage or automatic restart/resume. Publishing is never retried after
an uncertain external effect. Runs end at a draft PR, not a CI-ready or merged PR.

Not included yet: separate planning agents, token streaming, durable suspension,
PR feedback monitoring, or remote/multi-user interfaces.

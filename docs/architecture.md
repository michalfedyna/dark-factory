# CLI software factory

## Boundaries

- `contracts/` defines data and callback interfaces without importing application
  modules. It contains no presentation markup or browser transport state.
- `agents/` defines model behavior. `tools/` adapts the injected `Ask` capability
  into a Mastra tool. Neither depends on terminal rendering.
- `workflows/default.ts` defines the single end-to-end `default` workflow with
  typed steps and a nested delivery repair cycle. Agents and project inspection
  are injectable for offline tests.
- `factory/` registers the workflow with Mastra, adapts CLI cancellation/deadlines to
  workflow runs, maps failures to safe messages, and provides output persistence.
- `integrations/router/` owns only the proxy process it starts. It waits for the
  authenticated model catalog and handles bounded startup/shutdown.
- `cli/` loads config/environment and connects Commander, Clack, stdin/stderr,
  structured stdout, and process signals to the factory.

There is no web app, HTTP UI server, frontend build, React, or OpenUI dependency.
CLIProxyAPI remains the model transport; it is not a user interface.

## Flow

1. `dark start` validates transport config and loads the adjacent `.env`. An optional
   `--issue` is validated before startup; otherwise the terminal prompts for it.
   Inspect Git metadata from the CLI's working directory, not the config directory.
   Resolve the Git root, current branch, pinned commit, and unambiguous GitHub remote.
2. Start the managed proxy without a shell (or connect in unmanaged mode). Wait
   for `/v1/models` to expose the configured model, retrying incomplete catalogs
   until `router.readyTimeoutMs`.
3. Get the registered `default` workflow from Mastra and create one native run.
   Start it with the issue as input and the terminal callback and cancellation
   signal in a per-run `RequestContext`. The factory combines process,
   proxy-exit, and whole-workflow deadline cancellation signals.
4. The `explore-issue` step creates a fresh exploration agent. The agent calls
   `ask` with a validated question and awaits the real user's answer. In a TTY,
   Clack offers choices plus Other or a text prompt. Non-TTY input uses a single
   buffered line reader for the whole run.
5. Validate the answer and continue the same agent run with its tool result.
   Questions execute sequentially. EOF, Escape, and cancellation never produce
   invented answers or implicit confirmation.
6. Validate the final issue brief with Zod and pass it directly to preparation.
   It stays in memory; there is no issue-file writer or separate save step.
7. Require a confirmed, ready brief. A read-only inspection agent infers change
   scope, setup commands, checks, network needs, and web/native targets from the
   repository. It asks about necessary unknowns and cannot execute project code.
   Require separate approval of the brief and inferred plan before preparing the
   run-owned repository. Run implementation, checks, QA, and review
   in a bounded repair cycle. Only passing candidates reach summary and publication
   approval. **Keep local** returns a verified candidate without pushing.
8. Print only the final validated delivery JSON to stdout. Its run ID also names
   the artifact directory at `<git-root>/.darkfactory/runs/<run-id>/`.
9. Close terminal input, shut down Mastra, and stop the owned proxy after
   completion or failure.

One invocation runs one issue from exploration to delivery. There is no separate
exploration-only command or `--deliver` opt-in. Start another invocation for another issue.
There is no custom Sessions class, session polling, browser state, or durable
conversation resume. Mastra owns step sequencing, run IDs, and execution status.

## Cancellation and failures

All model/tool work receives an AbortSignal combining the native workflow signal
and the CLI cancellation/deadline signal. Prompts and pending line reads listen to
it. The CLI adapter calls `run.cancel()` on cancellation and also races its wait
against cancellation: Mastra cancellation prevents subsequent steps but cannot
force a non-responsive step to return. Late agent results are checked before
preparation. Exploration completion closes any remaining exploration tool waits;
run completion closes other pending waits.

Workflow steps are not retried automatically: repeating terminal questions or
file writes would be unsafe. Automatic run recovery is disabled for `default`
because terminal callbacks do not survive process restarts. No workflow snapshot
storage is configured yet. `sessionTimeoutMs` bounds the entire workflow, including
exploration, inspection, approvals, implementation, repairs, and publication.

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
- Extend the issue-to-delivery flow in `workflows/default.ts`, reusing typed steps
  and native control flow. Unrelated future tasks can have their own workflows;
  do not build a custom runtime.
- Add versioned contracts before downstream planning or implementation stages.
- Keep terminal rendering and line/TTY behavior in `cli/`.
- Use Mastra workflow storage and suspend/resume when durable execution becomes
  a requirement, without coupling persistence to terminal widgets.

## Implementation and QA environments

The delivery phase of `default` uses a native nested
`.dountil()` cycle that runs implementation, deterministic checks, QA, independent
review, and the controller's gate. Findings return to implementation within one
shared repair budget. Summary and explicitly approved draft-PR publication happen
only after passing gates. See [delivery](delivery.md) for discovery and the
initial provider's limits.

Each agent owns its instructions, Mastra definition, and output contract in
`agents/exploration.ts`, `agents/project.ts`, `agents/implementation.ts`, `agents/qa.ts`,
`agents/review.ts`, or `agents/summary.ts`. `agents/shared.ts` only shares delivery
instructions, model transport configuration, and structured-output generation.

QA's `agent_browser` and `agent_device` tools are defined separately in
`tools/agent-browser.ts` and `tools/agent-device.ts`. Each handles its own CLI
arguments and target kind, including screenshot operations. `tools/qa.ts` only
assembles the integrations required by the approved targets; `tools/qa-command.ts`
shares argument validation, sandbox execution, and evidence recording.

`factory/delivery-runtime.ts` creates run-owned Mastra `Workspace`,
`LocalFilesystem`, and `LocalSandbox` instances. Implementation gets filesystem
and sandbox tools; QA/review filesystem providers are read-only. QA's explicit
tools invoke agent-browser/agent-device from PATH through Mastra,
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
isolation is required for project commands but isn't a complete host boundary;
browser/device CLIs run on the trusted local host. No factory API-key environment
is passed to project commands. Local provider limits are explicit in the approval
and documented; use remote/container isolation before supporting hostile code.

Native workflow sequencing and budgets are not a custom session engine. Run
artifacts are persisted for inspection, but delivery doesn't yet configure Mastra
snapshot storage or automatic restart/resume. Publishing is never retried after
an uncertain external effect. Runs end at a draft PR, not a CI-ready or merged PR.

Not included yet: separate planning agents, token streaming, durable suspension,
PR feedback monitoring, or remote/multi-user interfaces.

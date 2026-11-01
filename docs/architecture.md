# CLI software factory

This describes the current implementation. [Workflow.md](Workflow.md) is the
broader target design; durable recovery, planning agents, and PR feedback are not
implemented here.

## Boundaries

- `contracts/` defines data and callback interfaces without importing application
  modules. It contains no presentation markup or browser transport state.
- `agents/` defines model behavior and role-specific context types. `tools/`
  exposes the injected `Ask` capability and constrained browser/device tools.
  Neither depends on terminal rendering.
- `workflows/default.ts` defines the single end-to-end `default` workflow with
  named steps and a nested delivery repair cycle. `workflows/steps.ts` owns Mastra
  step schemas, request context, signal composition, exploration, and recording
  after delivery steps. Detailed delivery behavior is in `delivery/steps.ts`.
- `delivery/` owns the issue-to-candidate application behavior: live environments,
  agent sessions, deterministic checks, gates, evidence/artifacts, and finishing.
  `delivery/operations.ts` is the interface between workflows and delivery
  execution; runtime code does not import the workflow implementation.
- `factory/` registers the workflow with Mastra, adapts CLI cancellation/deadlines to
  workflow runs, maps failures to safe messages, and owns background observation.
- `integrations/` owns external Git, GitHub, and proxy adapters. The router adapter
  owns only the process it starts, waits for the authenticated model catalog, and
  handles bounded startup/shutdown. `router/managed-process.ts` owns the factory's
  supervisor connection; `router/supervisor.ts` starts the proxy and stops its
  process group when that connection closes, even after a factory crash or SIGKILL.
  Domain gates and PR text belong in `delivery/`, not in external adapters.
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

## Agent context

Workflow state and model context are separate. `delivery/agent-context.ts` selects
explicit, typed inputs for each delivery role; `agents/shared.ts` serializes only
that selected context. Full state, workflow status/reason, base/tree/revision
bookkeeping, and round history are not included in initial agent task payloads.

| Agent                 | Direct task input                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Exploration           | Original issue text; real user answers arrive through its own ask tool.                                                                       |
| Repository inspection | Approved issue task; no Git branch, commit, remote, or full brief envelope.                                                                   |
| Implementation        | Issue task, allowed paths, check commands; latest repair findings, failed criterion notes, and failed check-log tails only.                   |
| QA                    | Acceptance criteria, constraints, target IDs/addresses/device settings/screenshot requirements, and current evidence references.              |
| Review                | Issue task, allowed paths, full candidate patch, current acceptance results/evidence references, and feedback from the last completed review. |
| PR summary            | Issue title/kind/outcome, final implementation summary, check outcomes, QA criterion results/notes, review outcome, and remaining findings.   |
| Progress observer     | Current stage, previous observer summary, latest 40 metadata events.                                                                          |

`agents/task.ts` selects issue-task content: problem, desired outcome, affected
users, scope, requirements, acceptance criteria, constraints, assumptions, user
decisions, and risks. Approval/readiness/schema fields remain with the controller.
Assumptions stay explicitly labeled as unverified.

QA does not receive implementation summaries, old reports, server-start/build
commands, or check-log text. QA/review can read current evidence files on demand.
Repair feedback strips stale evidence IDs; failed check excerpts keep only the
last 12,000 characters per failed check. Review receives only the last relevant
reviewer's findings, even if an intervening attempt failed before review. Summary
does not receive patches, raw logs, evidence paths, targets, or historical attempts.

Role instructions, output schemas, framework workspace/tool definitions, and an
agent's own tool-loop messages still enter model context normally. This selection
is not a new security boundary or a token-budget/compression engine. Mastra retains
the existing orchestration and tool access; the workflow keeps full state for gates,
repair accounting, and persisted artifacts. Prompt-boundary tests cover both API
protocols and check/QA/review repair paths.

## Progress observer

`agents/observer.ts` defines a tool-free Mastra agent for user-facing progress,
separate from the verified final PR summary. `factory/observer.ts` batches a
bounded window of metadata and schedules at most one background request at a
time. Native Mastra tool hooks in `agents/activity.ts` forward only tool names,
roles, and execution status; workflow stages and trusted check/gate outcomes
provide the remaining facts. No source, arguments, results, reasoning, user
answers, or credentials enter the observer prompt.

Each invocation owns its observer and ties it to the whole-workflow signal.
`factory/start.ts` pauses it around every
question and approval, discards stale-stage/prompt results, and aborts it in
`finally` without delaying workflow completion. Failures disable summaries only;
normal progress continues. The CLI renders summaries on stderr through Clack
without mixing them into stdout JSON or a pending prompt. Observations are not
fed back into agents, gates, or approvals. This is not durable observational
memory and does not add storage or a custom workflow engine.

`cli/observer.ts` owns summary sanitization and plain `Observer: ...` output.
It shares `cli/accent-block.ts` with titled question context in `cli/terminal.ts`:
terminal-width accent blocks in a TTY, respecting `NO_COLOR`. The implementation
approval supplies an explicit `contextTitle` of `Implementation plan`; its full
multiline context is preserved. Untitled questions and redirected context remain
plain text.

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
Initialization failures also stop an already acquired proxy. The supervisor detects
factory death through IPC disconnection rather than relying on factory exit handlers.
On macOS/Linux it terminates the owned process group, including wrappers and their
children, and escalates to SIGKILL after three seconds if needed. Unmanaged endpoints
are never killed. Processes that deliberately leave the group are not supervised.
Raw provider errors are not copied into user-facing error messages.

Structured output uses schema prompt injection to coexist with tool calls through
the compatible proxy. It is still strictly validated. Responses is the default
protocol; Chat Completions is configurable and integration-tested.
All agents use the transport defaults in `agents/model.ts`. Responses explicitly
sets `openai.store: false` and requests `reasoning.encrypted_content`, including
for custom model aliases. Mastra's SDK replays messages, function calls/results,
and encrypted reasoning rather than referencing proxy-side stored items. Reasoning
without encrypted content is omitted. Chat uses no Responses-specific options.

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
instructions and structured-output generation; `agents/model.ts` owns the common
model transport configuration for all agents, including exploration and observation.
`agents/task.ts` owns the common task/evidence/repair prompt types and the approved
task projection. Each role owns its narrower context type; the delivery boundary
builds those contexts without exposing workflow state to the agents.

QA's `agent_browser` and `agent_device` tools are defined separately in
`tools/agent-browser.ts` and `tools/agent-device.ts`. Each handles its own CLI
arguments and target kind, including screenshot operations. `tools/qa.ts` only
assembles the integrations required by the approved targets; `tools/qa-command.ts`
shares argument validation, sandbox execution, and evidence recording.

`delivery/runtime.ts` composes an environment owner, agent sessions, checks, QA
validation, and finishing through `DeliveryOperations`. It does not own mutable
initialization variables for individual resources.

`delivery/environment.ts` creates run-owned Mastra `Workspace`,
`LocalFilesystem`, and `LocalSandbox` instances. Implementation gets filesystem
and sandbox tools; QA/review filesystem providers are read-only. QA's explicit
tools invoke agent-browser/agent-device from PATH through Mastra,
record evidence, and restrict operations and global flags. Project dependency
installs, commands, builds, tests, and background processes use Mastra rather than
a custom command execution layer. See the
[sandbox documentation](https://mastra.ai/docs/sandbox/overview).

### Delivery code map

| Module                                  | Responsibility                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `delivery/preparation.ts`               | Validate the inferred project plan, recheck the pinned base, require isolation and exact implementation approval. |
| `delivery/environment.ts`               | Acquire resources, expose a prepared run/current round, and clean up even after partial setup.                    |
| `delivery/context.ts`                   | Typed live `RunResources`, revision-bound `RoundResources`, and delivery inputs.                                  |
| `delivery/agent-sessions.ts`            | Assemble typed role inputs and bound implementation/QA sessions.                                                  |
| `delivery/checks.ts`                    | Execute approved commands and record check findings/evidence.                                                     |
| `delivery/qa-session.ts`                | Own round-specific automation sessions and background QA servers.                                                 |
| `delivery/steps.ts`, `state.ts`         | Delivery step behavior and immutable current-round replacement with explicit preconditions.                       |
| `delivery/qa-policy.ts`, `policy.ts`    | Pure QA evidence validation, review reference validation, stage eligibility, and repair/approval decisions.       |
| `delivery/artifacts.ts`, `evidence.ts`  | Private run files, check-log excerpts, revision-bound evidence, and PNG validation.                               |
| `delivery/finish.ts`, `pull-request.ts` | Local preview/result, publication approval, and PR sections. GitHub side effects stay in its adapter.             |

Factory configuration (`FactoryConfig`) controls model transport, observation,
router lifecycle, and the whole-run deadline. The inspected project plan (`Project`)
controls approved repository setup, checks, scope, and QA targets. These are not
interchangeable. For artifact compatibility, `input.json` still stores the project
plan under its existing `config` key.

### Resource and state ownership

- A run context is available only after inspection, approval, resource setup, and
  dependencies succeed. Operations fail explicitly if preparation is incomplete.
- Resources are registered as soon as acquired. A static workspace owns its
  sandbox once construction succeeds; until then the environment retains cleanup
  ownership. The Git checkout and artifacts are retained, not deleted on cleanup.
- Checks create a fresh round context with its round number, revision, evidence
  recorder, and QA session. QA rejects a context for another round or revision.
- QA owns configured server handles and automation session names for that round.
  It closes sessions and stops project processes in `finally`, including partial
  server startup. Cleanup uses a separate 10-second signal and 8-second command
  timeout, even when the run is cancelled. Repeated close calls share completion.
- Closing an environment aborts its setup lifetime. Late inspection/setup results
  cannot expose a ready run or acquire more live resources. Cleanup attempts all
  acquired resources even if QA cleanup fails.
- `DeliveryState` contains only serializable brief/candidate/history/summary data.
  Workspaces, sandboxes, processes, and evidence recorders stay in live contexts.
  Each step returns a new state/round rather than mutating earlier workflow inputs.
- `currentRound` checks that the latest captured round matches the state counter.
  An implementation blocker may advance the counter without capturing a round;
  blocked stages skip that precondition and finishing retains the existing result
  semantics.

### Validation and compatibility

Agents validate their structured results; workflow steps independently parse them
again. QA/review policies validate criterion and evidence references. Trusted Git
checks enforce approved paths and candidate immutability. Publication independently
requires passing gates, a summary, an unchanged candidate, a matching GitHub base,
and a metadata-only evidence commit. Approval labels, schemas, private file formats,
repair budget, deadlines, and uncertain-publication journaling are unchanged.

Tests separate pure state/policy and lifecycle regressions from real Mastra/CLI
integration scenarios. `test/fixtures/integration.ts` owns common repository and
process setup; the fake provider's protocol codec is separate from role/scenario
behavior. Role routing uses structured inputs, not incidental instruction strings.

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

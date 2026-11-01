# CLI software factory

This describes the current implementation. [Workflow.md](Workflow.md) is the
broader target design; durable recovery, planning agents, and PR feedback are not
implemented here.

## Boundaries

- `contracts/` defines data and callback interfaces without importing application
  modules. It contains no presentation markup or browser transport state.
- `agents/` defines model behavior and role-specific context types. `tools/`
  exposes the injected `Ask` capability, scoped Figma REST access and constrained browser/device tools.
  Neither depends on terminal rendering.
- `workflows/default.ts` defines the single end-to-end `default` workflow with
  named steps and a nested delivery repair cycle. `workflows/steps.ts` owns Mastra
  step schemas, request context, signal composition, exploration, and recording
  after delivery steps. Detailed delivery behavior is in `delivery/steps.ts`.
- `delivery/` owns the issue-to-candidate application behavior: live environments,
  agent sessions, deterministic checks, gates, evidence/artifacts, and finishing.
  `delivery/operations.ts` is the interface between workflows and delivery
  execution; runtime code does not import the workflow implementation.
- `factory/` registers the workflow with Mastra, adapts CLI cancellation to
  workflow runs, maps failures to safe messages, and owns background observation.
- `integrations/` owns external Figma, Git, GitHub, and proxy adapters. The router adapter
  owns only the process it starts, waits for the authenticated model catalog, and
  waits for readiness without a work deadline and bounds shutdown. `router/managed-process.ts` owns the factory's
  supervisor connection; `router/supervisor.ts` starts the proxy and stops its
  process group when that connection closes, even after a factory crash or SIGKILL.
  Domain gates and PR text belong in `delivery/`, not in external adapters.
- `cli/` loads config/environment and connects Commander, Clack, stdin/stderr,
  structured stdout, and process signals to the factory.

There is no web app, HTTP UI server, frontend build, React, or OpenUI dependency.
CLIProxyAPI remains the model transport; it is not a user interface.

## Flow

1. `dark start` validates factory config and loads the adjacent `.env`. An optional
   `--issue` is validated before startup; otherwise the terminal prompts for it.
   Inspect Git metadata from the CLI's launch directory, not the config directory.
   For the factory's npm `dev`/`start` scripts, use npm's `INIT_CWD` to preserve
   that directory despite npm changing to its package root. Relative config paths
   use the same launch directory; direct CLI calls use the process working directory.
   Resolve the Git root, current branch, pinned commit, and unambiguous GitHub remote.
2. Start the managed proxy without a shell (or connect in unmanaged mode). Wait
   for `/v1/models` to expose the configured model, retrying incomplete catalogs
   until the model is ready or the supervisor cancels.
3. Get the registered `default` workflow from Mastra and create one native run.
   Start it with the issue as input and the terminal callback and cancellation
   signal in a per-run `RequestContext`. The factory combines process,
   and proxy-exit cancellation signals.
4. The `explore-issue` step creates a fresh exploration agent. The agent calls
   `ask` with a validated question and awaits the real user's answer. In a TTY,
   Clack offers choices plus Other or a text prompt. Non-TTY input uses a single
   buffered line reader for the whole run.
   Its scoped Figma preview tool can export linked screens as PNGs before
   confirmation, including links supplied in real answers. Whole-file discovery
   returns only screen names and IDs; detailed design inspection stays with the UI agent.
5. Validate the answer and continue the same agent run with its tool result.
   Questions execute sequentially. EOF, Escape, and cancellation never produce
   invented answers or implicit confirmation.
6. Validate the final issue brief with Zod and pass it directly to preparation.
   It stays in memory; there is no issue-file writer or separate save step.
7. Require a confirmed, ready brief, recheck the pinned base, and prepare the
   run-owned checkout and workspaces using the configured execution mode. No inspection agent or
   pre-implementation command plan is required. Implementation owns dependency
   setup and app scaffolding. Before implementation, `figma-ui` conditionally runs
   the UI-only agent when the original issue or approved brief contains supported
   Figma links. `integrations/figma/sources.ts` normalizes references; the REST tool is
   scoped to these sources and records successful reads. The handoff and scaffold
   enter implementation together. Implementation returns actual check commands and web/native
   targets for its candidate. Run checks, QA, and review in a supervised repair cycle.
   The exploration confirmation authorizes the full in-scope run; delivery has no
   interaction callback. Only passing candidates reach summary and automatic draft
   PR publication. Without a usable GitHub remote, verified work stays local.
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

| Agent             | Direct task input                                                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exploration       | Original issue text and real ask answers; scoped Figma PNG previews and lightweight screen names/IDs, without repository access or detailed specifications.                              |
| Figma UI          | Approved issue task, allowed paths and canonical design sources; a scoped REST tool and separate Mastra workspace in the implementation checkout.                                        |
| Implementation    | Issue task, repository-wide non-protected paths, previous candidate's check commands (initially empty); latest repair findings, failed criterion notes, and failed check-log tails only. |
| Browser/mobile QA | Acceptance criteria, constraints, target IDs/addresses/device settings/screenshot requirements, and current evidence metadata without file paths.                                        |
| Sandbox QA        | Only blocked acceptance criteria and their notes, constraints, the current verification plan, and evidence references.                                                                   |
| Review            | Issue task, allowed paths, full candidate patch, verification plan, current acceptance results/evidence references, and feedback from the last completed review.                         |
| PR summary        | Issue title/kind/outcome, final implementation summary, check outcomes, QA criterion results/notes, review outcome, and remaining findings.                                              |
| Progress observer | Current stage, previous observer summary, latest 40 activity events including bounded provider-exposed reasoning excerpts.                                                               |

`agents/task.ts` selects issue-task content: problem, desired outcome, affected
users, scope, requirements, acceptance criteria, constraints, assumptions, user
decisions, and risks. Approval/readiness/schema fields remain with the controller.
Assumptions stay explicitly labeled as unverified.

Implementation additionally receives the validated Figma handoff when present.
`contracts/figma.ts` defines sources and role results; `integrations/figma/client.ts`
owns fixed read-only REST endpoints and authentication; `tools/figma.ts` owns source
inspection for the UI agent. `tools/figma-access.ts` owns session-scoped source
allowlists, credential use and read tracking; `tools/figma-preview.ts` limits
exploration to PNG exports and screen discovery. `integrations/figma/images.ts`
downloads and validates PNGs without credentials. `agents/exploration-preview.ts`
uses Mastra's outbound-request processor to lift PNGs into image-capable user turns
for Chat transports without mutating conversation history. The environment lazily owns
the Figma workspace and sandbox, stops them after the stage and destroys them at
run cleanup. Credentials stay outside workflow state, model context and sandbox
environments. [Figma behavior](figma.md) describes the UI-only role boundary and limits.

Browser/mobile QA does not receive implementation summaries, old reports, server-start/build
commands, file paths, or check-log text. It has no workspace, filesystem, or shell
tools and does not inspect or review files. QA tests only application behavior
against acceptance criteria; UI captures arrive directly from its testing tools.
The sequential sandbox fallback can read source, configuration, tests, and logs and
run commands to test criteria the first QA could not verify. It does not receive
unrelated criteria or implementation summaries. It cannot repair the candidate or
replace the review role. Review can read current source and evidence files on demand.
Review also receives the candidate's verification plan to reject missing UI targets
or ineffective checks selected by implementation.
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
bounded window of unprocessed activity and schedules at most one background request
at a time. Accepted summaries consume their event batch, including empty or duplicate
summaries that produce no output; activity arriving during a request stays pending.
Discarded stale or paused results do not consume events. The agent uses its previous
report to avoid repeating facts and can return an empty summary when nothing new
is worth reporting. Native Mastra tool hooks in `agents/activity.ts` forward only tool names,
roles, and execution status. `agents/generation.ts` also forwards native reasoning
deltas without provider metadata. Consecutive deltas from one agent/reasoning block
are coalesced and capped at the latest 2,000 characters per excerpt, within the
40-event window. New deltas never merge into a batch already being summarized,
so consuming that batch cannot drop new thinking. The configured API key and its
trailing partial prefixes are redacted from excerpts before model calls and from
summaries before output. Reasoning is untrusted and provisional, not verified
execution evidence. It can contain private task/source details; redaction is not a
general secret scanner. Source files, tool arguments/results, and user answers are
not forwarded directly; encrypted reasoning is never sent to the Observer.
Workflow stages and trusted check/gate outcomes provide verified status.

Each invocation owns its observer and ties it to the whole-workflow signal.
After exploration returns a validated, confirmed, ready brief, the preparation
step calls a per-run delivery-start callback to activate it before delivery progress.
Exploration events are not collected and no summary requests run during exploration,
questions, or confirmation. `factory/start.ts` aborts it in `finally` without
delaying workflow completion; stale-stage results are discarded. Failures disable
summaries only; normal progress continues. The CLI renders summaries on stderr through Clack
without mixing them into stdout JSON or a pending prompt. Observations are not
fed back into agents, gates, or approvals. This is not durable observational
memory and does not add storage or a custom workflow engine.

`cli/progress.ts` owns the Clack spinner lifecycle: stage changes update the active
animation's message instead of starting additional timers. Questions and Observer
blocks clear it before writing; completion, failure, and cancellation close it so
late updates cannot restart the animation.

`cli/observer.ts` owns summary sanitization and plain `Observer: ...` output.
It shares `cli/accent-block.ts` with titled question context in `cli/terminal.ts`:
terminal-width accent blocks in a TTY, respecting `NO_COLOR`. Exploration questions
can supply a `contextTitle` for readable brief confirmation; full multiline
context is preserved. Untitled questions and redirected context remain
plain text.

### Debug streaming

`dark start --debug` replaces the Observer for that invocation; its agent is not
created or registered. `agents/generation.ts` uses native Mastra `Agent.stream()`
callbacks and `getFullOutput()` for exploration and every delivery role, retaining
the same tools, cancellation signal, concurrency, and strict Zod result validation.
Observed runs also stream so thinking reaches the Observer before completion;
calls without observation or debug still use `Agent.generate()`. Streaming disables
eager tool execution so an exploration question does not overlap ongoing model output.

`contracts/debug.ts` separates opt-in diagnostic events from the bounded activity
Observer contract. The agent adapter forwards text, exposed reasoning, tool inputs
and results, step/usage metadata, errors, and validated results; it does not forward
provider headers or encrypted reasoning. Trusted check and gate events use the
same diagnostic sink without entering agent context or controlling execution.

`cli/debug.ts` owns live text and `Thinking` headings, formatted detail blocks, credential
redaction, control-character sanitization, and prompt buffering. The CLI pauses
diagnostics during questions, avoids spinner collisions, and closes the writer
before final output or cancellation so late events cannot print. Diagnostics go
only to stderr, respect `NO_COLOR`, and keep redirected output plain. Source and
answers may appear in debug logs; redaction is not a general secret scanner.

## Cancellation and failures

All model/tool work receives an AbortSignal combining the native workflow signal
and the CLI cancellation signal. Prompts and pending line reads listen to
it. The CLI adapter calls `run.cancel()` on cancellation and also races its wait
against cancellation: Mastra cancellation prevents subsequent steps but cannot
force a non-responsive step to return. Late agent results are checked before
preparation. Exploration completion closes any remaining exploration tool waits;
run completion closes other pending waits.

Workflow steps are not retried automatically: repeating terminal questions or
file writes would be unsafe. Automatic run recovery is disabled for `default`
because terminal callbacks do not survive process restarts. No workflow snapshot
storage is configured yet. There are no agent-step, workflow-time, repair-round,
or repeated-tree cutoffs. Explicit `stopWhen: () => false` replaces Mastra's default
five-step cap; the agent still finishes normally when it returns its result.
Mastra local sandboxes use `timeout: 0` to disable the framework's default command
deadline. Application/router readiness and trusted Git/GitHub commands also wait
without a factory deadline, while remaining cancellable. Observer and cleanup
deadlines do not stop active work. External services can still fail or impose limits.

Ctrl+C/Escape and termination signals cancel with exit code 130. Startup failures,
EOF, model/schema failures, and persistence failures exit with code 1.
Initialization failures also stop an already acquired proxy. The supervisor detects
factory death through IPC disconnection rather than relying on factory exit handlers.
On macOS/Linux it terminates the owned process group, including wrappers and their
children, and escalates to SIGKILL after three seconds if needed. Unmanaged endpoints
are never killed. Processes that deliberately leave the group are not supervised.
Raw provider errors are not copied into user-facing error messages.

Structured output uses schema prompt injection to coexist with tool calls through
the compatible proxy. It is still strictly validated. Responses is the default
protocol; Chat Completions is configurable and integration-tested.
All agents use the transport defaults in `agents/model.ts`, including
`model.reasoningEffort` (default `medium`) for both protocols. Responses explicitly
sets `openai.store: false` and requests `reasoning.encrypted_content`, including
for custom model aliases. It also configures `openai.reasoningSummary: 'auto'`;
the SDK sends this for models it recognizes as reasoning-capable. Mastra's SDK replays messages, function calls/results,
and encrypted reasoning rather than referencing proxy-side stored items. Reasoning
without encrypted content is omitted. Chat passes effort through
`openaiCompatible.reasoningEffort` and uses no Responses-specific options.
The Responses SDK can omit effort for model IDs it does not recognize as
reasoning-capable; model/proxy support still determines accepted effort levels.

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
`.dountil()` cycle that runs implementation, deterministic checks, browser/mobile
QA, conditional sandbox QA, independent
review, and the controller's gate. Findings return to implementation within one
supervised repair cycle without an attempt cap. Summary and automatic draft-PR publication happen
only after passing gates. See [delivery](delivery.md) for discovery and the
initial provider's limits.

Each agent owns its instructions, Mastra definition, and output contract in
`agents/exploration.ts`, `agents/implementation.ts`, `agents/qa.ts`, `agents/sandbox-qa.ts`,
`agents/review.ts`, or `agents/summary.ts`. `agents/shared.ts` shares delivery
instructions and context serialization; `agents/generation.ts` owns validated
generation and optional debug streaming. `agents/model.ts` owns the common
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
`LocalFilesystem`, and `LocalSandbox` instances. Implementation and review get
separate workspaces with full filesystem and sandbox tools under the same project
execution policy. Review independently reruns relevant checks and can install
dependencies or create ignored test artifacts, but must not repair or change the
candidate. Its workspace stops in `finally`, including on failure or cancellation;
the run owner destroys it during cleanup. Browser/mobile QA has no workspace
or file tools. Its explicit tools invoke agent-browser/agent-device from PATH
through Mastra, record evidence, and restrict operations and global flags.
Mastra's `toModelOutput` returns captured UI images inline without exposing a
file-reading capability. Project dependency
installs, commands, builds, tests, and background processes use Mastra rather than
a custom command execution layer. See the
[sandbox documentation](https://mastra.ai/docs/sandbox/overview).

Sandbox QA gets a separate, round-owned workspace with full filesystem and sandbox
tools using the same project execution policy. Mastra still executes all commands;
`delivery/sandbox-qa-evidence.ts` records native foreground command results without
parsing tool text or trusting agent-authored evidence. `tools/qa-evidence.ts` lists
those evidence IDs. Background processes allow application setup; completed
foreground observations are required to pass. The fallback stops its workspace
resources in `finally`. It starts its own services after the primary UI session closes.

### Delivery code map

| Module                                  | Responsibility                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `delivery/preparation.ts`               | Require a confirmed brief, recheck the pinned base, and resolve the configured execution mode.                  |
| `delivery/environment.ts`               | Acquire resources, bind candidate verification plans to round resources, and clean up even after partial setup. |
| `delivery/context.ts`                   | Typed live `RunResources`, revision-bound `RoundResources`, and delivery inputs.                                |
| `delivery/agent-sessions.ts`            | Assemble typed role inputs and bound implementation, QA, and review sessions.                                   |
| `delivery/checks.ts`                    | Execute approved commands and record check findings/evidence.                                                   |
| `delivery/qa-session.ts`                | Own round-specific automation sessions, server readiness, and revision-bound server failure logs.               |
| `delivery/qa-handoff.ts`                | Decide whether sandbox QA is needed and combine reports without replacing UI passes or failures.                |
| `delivery/sandbox-qa-evidence.ts`       | Record native sandbox QA command outcomes as revision-bound evidence.                                           |
| `delivery/steps.ts`, `state.ts`         | Delivery step behavior and immutable current-round replacement with explicit preconditions.                     |
| `delivery/qa-policy.ts`, `policy.ts`    | Pure QA evidence validation, review reference validation, stage eligibility, and repair/approval decisions.     |
| `delivery/artifacts.ts`, `evidence.ts`  | Private run files, check-log excerpts, revision-bound evidence, and PNG validation.                             |
| `delivery/finish.ts`, `pull-request.ts` | Local preview/result, automatic gated publication, and PR sections. GitHub side effects stay in its adapter.    |

Factory configuration (`FactoryConfig`) controls model transport, observation,
router lifecycle and sandbox execution policy. `Project` holds Git metadata,
repository-wide non-protected change scope, network policy, and QA tool commands.
Project sandboxes default to host execution (`sandbox.isolation: "none"`) for
compatibility. Opt-in `"native"` mode requires an available Seatbelt/Bubblewrap
backend and fails closed rather than falling back. Both modes allow network access
for dependency installation and verification; neither inherits factory credentials.
Their PATH prefers the factory's active Node installation over HOME-dependent
version-manager shims while retaining a private run-owned HOME.
Implementation owns setup and returns a `VerificationPlan` with actual checks and
QA targets after implementing or scaffolding the app. Each round combines that
candidate's plan with project settings as a `VerificationProject`; no commands or
targets are required before implementation. `input.json` stores project settings
under `config` and the requested execution policy under `sandbox`; each implementation result in `state.json` stores its verification
plan. Live resources remain outside serializable workflow state.

### Resource and state ownership

- A run context is available after exploration confirmation and isolated resource
  setup, even if the repository has no app yet. Implementation handles dependencies
  and scaffolding. Operations fail explicitly if preparation is incomplete.
- Resources are registered as soon as acquired. A static workspace owns its
  sandbox once construction succeeds; until then the environment retains cleanup
  ownership. The Git checkout and artifacts are retained, not deleted on cleanup.
- Checks create a fresh round context with its round number, revision, candidate
  verification plan, evidence recorder, QA session, and full-access sandbox QA workspace.
  Both QA stages reject a context for
  another round or revision. Repairs cannot reuse old commands, targets, or evidence.
- QA owns configured server handles and automation session names for that round.
  Web targets must respond before the QA agent runs; readiness has no overall deadline.
  Server failures become failed check evidence and controller-authored unverified
  criterion results, returning logs to implementation without giving QA file access.
  It closes sessions and stops project processes in `finally`, including partial
  server startup. Cleanup uses a separate 10-second signal and 8-second command
  timeout, even when the run is cancelled. Repeated close calls share completion.
- Sandbox QA runs only for blocked primary criteria, never as a replacement for an
  observed failure or candidate-server crash. Its own report covers exactly that
  subset and passing results require current sandbox command evidence. The combined
  `qa` report preserves primary results outside the subset; raw `browserQa` and
  optional `sandboxQa` reports are retained. Required UI captures and candidate
  immutability still gate review. Preliminary QA validation does not add final
  blocking findings until the conditional fallback has completed.
- Closing an environment aborts its setup lifetime. Late base-validation/setup results
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
and a metadata-only evidence commit. Successful implementations must return a
complete verification plan; genuine blockers return null verification. Missing
app scaffolding is implementation work, not a prerequisite. There are no post-exploration approvals;
validation gates and uncertain-publication journaling still apply.

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
isolation is opt-in for project commands and isn't a complete host boundary;
browser/device CLIs run on the trusted local host. No factory API-key environment
is passed to project commands. Local provider limits are explicit in exploration confirmation
and documented; use remote/container isolation before supporting hostile code.

Native workflow sequencing is not a custom session engine. Run
artifacts are persisted for inspection, but delivery doesn't yet configure Mastra
snapshot storage or automatic restart/resume. Publishing is never retried after
an uncertain external effect. Runs end at a draft PR, not a CI-ready or merged PR.

Not included yet: separate planning agents, durable suspension,
PR feedback monitoring, or remote/multi-user interfaces.

# Software Factory Workflow

**Target design, not the current implementation.** For implemented behavior and
code ownership, read [architecture.md](architecture.md) and [delivery.md](delivery.md).
The current CLI runs hands-off after exploration confirmation and ends at a draft PR; it does not yet implement
the planning/task graph, durable recovery, design integrations, or PR-check loop
described below.

## 1. Goal

Turn a user request into reviewed, tested software and a pull request through a
controlled, repeatable workflow. This is the target design for DarkFactory, not
a description of all capabilities already implemented. The initial delivery slice
(implementation, QA, review, bounded repairs, summary, and automatic draft PR) is
described in [delivery.md](delivery.md), including its local-provider limitations.

LLMs generate proposals; software decides what is allowed, what happens next,
and whether the result is acceptable. The goal is not identical generated code.
It is predictable execution, constrained variation, reproducible checks, and
traceable decisions.

## 2. Determinism contract

1. **Code controls execution.** Explicit states, transitions, and gate conditions
   govern the run. Agents cannot approve themselves, change policy, or choose
   arbitrary next steps.
2. **Approve before implementing.** Discovery is read-only. Source changes and
   scaffolding start only after the user approves the exact plan. Running project
   code during discovery requires separate permission and isolation.
3. **Constrain each task.** Give agents only the approved inputs, owned paths,
   tools, acceptance criteria, and budget needed for their role. Enforce limits
   outside the model; prompts alone are not a permission system.
4. **Validate every handoff.** Machine-consumed outputs are structured and checked
   for both schema validity and meaning: valid references, scope, dependencies,
   requirement coverage, and evidence. Invalid or missing output blocks progress.
5. **Separate creation from verification.** Independent QA and reviewers evaluate
   the candidate. Authors cannot approve their own work; reviewers cannot silently
   repair source or weaken acceptance criteria.
6. **Require evidence.** “Tests pass” is not evidence. Trusted runners record the
   check, environment, result, logs, and tested revision. Gates are computed from
   these records, not agent confidence.
7. **Bind decisions to versions.** Plans, inputs, candidates, findings, evidence,
   and approvals have immutable versions. A green result for one candidate is not
   automatically valid for another.
8. **Bound autonomy.** Retries, repair rounds, concurrency, runtime, tokens, and
   cost have explicit limits. Exhaustion or repeated lack of progress stops work
   and reports a blocker.
9. **Keep humans in control.** Users can clarify, approve, request changes, pause,
   or cancel. Silence and conversational summaries never count as approval.
   Only exploration has `ask`. Once the issue plan is accepted, agents work
   autonomously or report blockers; they never prompt for more input or approval.

## 3. Workflow and gates

| Stage               | Required result                                                                              | Gate to advance                                                               |
| ------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Intake              | Request, repository/base revision, constraints, permissions, and budgets.                    | Read scope is authorized; user work is protected.                             |
| Explore             | Codebase map, relevant documentation/design sources, baseline failures, risks, and unknowns. | Facts are traceable; missing information is explicit.                         |
| Define              | Goals, non-goals, acceptance criteria, constraints, and assumptions.                         | Every criterion is observable; blocking questions are resolved.               |
| Plan and review     | Architecture/design intent, task graph, verification plan, risks, and requested effects.     | Independent plan review passes; user approves the exact revision.             |
| Prepare             | Detailed contracts/design, task ownership, isolated workspaces, and test targets.            | Tasks are executable and consistent with the approved plan.                   |
| Implement           | Scoped patches, tests, local check results, and reported blockers.                           | Changes stay within task ownership and pass required local checks.            |
| Integrate           | One candidate assembled in a stable dependency order.                                        | No unresolved conflicts; required automated checks pass on that candidate.    |
| Verify and review   | Acceptance evidence, runtime/design QA, independent code and security review.                | Required checks pass; blocking findings are independently verified as closed. |
| Preview and publish | User-visible result, limitations, evidence, and proposed PR.                                 | Publication is authorized for the current candidate.                          |
| PR checks           | Pull request with required CI and reviews.                                                   | Checks and reviews pass on the current PR head; mark `pr_ready`.              |

An agent reporting completion does not advance a stage. Missing infrastructure,
unsupported targets, or missing evidence produce a block, not a pass.

### Approval package

Before implementation, the user approves:

- Requirements, acceptance criteria, assumptions, and non-goals.
- Architecture, interfaces, dependencies, and design intent.
- Tasks, dependencies, owners, and allowed change scope.
- Verification methods, target platforms, thresholds, and exclusions.
- Risks, limitations, budgets, and permitted external effects.

Changes to scope, architecture, dependencies, design direction, acceptance
criteria, verification requirements, permissions, or increased budgets require a
revised plan and renewed approval. Mechanical fixes within the approved scope do
not.

The final exploration confirmation authorizes scoped implementation, verification,
repairs, and draft PR publication, including verification evidence. It does not
authorize merge or deployment. Material changes stop the run; a revised scope
requires a new exploration, not an agent question during delivery.

## 4. Scoped work and independent verification

The controller validates the task graph and dispatches ready tasks. Each task
contains its approved input references, owner, allowed paths/tools, dependencies,
acceptance criteria, checks, and completion conditions.

- Exploration, requirements, planning, and design roles propose artifacts without
  source-write access.
- Implementers own assigned source paths; test authors own assigned test paths.
  Shared contracts and configuration have a single owner.
- QA and reviewers receive the approved plan, integrated candidate, and relevant
  evidence with read-only source access and context independent of the author.
- Trusted workers enforce permissions, execute checks, integrate changes, and
  publish. Agents request these operations; they do not control the gates.

Parallel work uses isolated workspaces and explicit ownership. Integration order
follows dependencies, not agent completion timing. Conflicts return to their
owners; architectural conflicts return to planning.

Every acceptance criterion maps to a verification result. Required checks cover
the applicable build, static analysis, tests, security, runtime behavior,
accessibility, and visual requirements. Check results distinguish `pass`, `fail`,
`blocked`, and `not_applicable`; exclusions require a reason. Baseline failures
remain visible and need an explicit approved exception, not a false pass.

Exploratory agent testing supplements deterministic tests. Stable discovered
journeys become replayable checks wherever possible.

## 5. Repair, feedback, and invalidation

Every finding identifies the affected criterion or rule, expected versus actual
behavior, evidence, severity, and owner.

1. Classify the finding as an in-scope defect, a scope change, or a question.
2. Route defects to the owning implementer; route scope changes to planning.
3. Reintegrate fixes and rerun invalidated checks and independent review.
4. Close findings only after independent verification.
5. Stop when a repair/resource limit is reached or progress stalls; show the user
   the blocker, attempted fixes, evidence, and remaining options.

Agents cannot escape a failed gate by lowering severity, removing tests, changing
baselines, or weakening thresholds. Critical safety issues stop affected work;
blocking acceptance and security failures prevent delivery. Any permitted
exception must be explicit, human-authorized, and recorded.

Source changes invalidate candidate-wide checks and reviews. Rerun affected QA;
if impact is uncertain, rerun all required QA. Material plan changes invalidate
plan approval; candidate changes invalidate delivery approval unless its explicit
policy covers in-scope repairs.

PR feedback follows the same gates and shares the existing repair budget. After
merge or run closure, feedback starts a linked improvement run. Agents never
silently rewrite their own prompts, policy, or workflow.

## 6. Reproducibility and safe recovery

- Freeze the workflow, policy, schemas, role prompts, model configuration, tools,
  and dependency versions for each run. Low temperature is not a determinism
  guarantee; record mutable model aliases and other unavoidable variability.
- Snapshot the base commit, approved requirements/design sources, fixtures, and
  relevant runtime conditions. Use canonical artifacts as context, not chat
  history as the source of truth.
- Preserve the chain from requirement to task, candidate, check, finding,
  approval, and PR. Replaying saved decisions is distinct from asking a model to
  generate a fresh result.
- Persist stage state, approvals, evidence, counters, and pending interactions.
  Restarts and reconnects must not bypass gates or reset budgets.
- Reconcile uncertain external effects before retrying. Recovery must not create
  duplicate PRs, repeat publication, or allow competing workers to overwrite work.
- Treat repository content, web pages, design content, and PR comments as
  untrusted data, never as policy or authorization.
- Isolate project execution and QA from factory credentials, personal accounts,
  and production systems. Restrict tools, paths, and network access; redact secrets
  from evidence. Pause/cancel stops owned work without destroying user files.

## 7. Foundation and required integrations

[Mastra](https://mastra.ai/docs) provides workflow, agent, persistence, tracing,
and evaluation primitives. Factory code remains responsible for policy,
permissions, isolation, validation, and delivery decisions.

- **[agent-browser](https://github.com/vercel-labs/agent-browser):** web exploration
  and runtime verification.
- **[agent-device](https://github.com/callstack/agent-device):** supported native
  and mobile exploration and verification; browser emulation is not a substitute.
- **[Figma REST API](https://developers.figma.com/docs/rest-api/):** captured,
  versioned design references, assets, and design-to-code traceability.
- **CLI (Commander and Clack):** the only user interface for now: progress,
  evidence, questions, and explicit decisions over authoritative factory state.
  Generated explanations cannot alter approval content or authorize actions.
  Web UI and OpenUI integration are out of scope.

Each run uses only integrations applicable to its approved targets. A backend
change does not need fabricated UI checks; a required unavailable target blocks
verification rather than silently reducing coverage.

## 8. Definition of success

The factory is more deterministic when the same approved inputs and policy lead
to the same allowed actions, routing, gate decisions, and evidence requirements,
even when generated patches differ.

Test workflow invariants with deterministic tests: unauthorized actions are
denied, stale approvals cannot advance runs, missing evidence blocks gates,
candidate changes invalidate results, budgets survive restarts, and recovery does
not duplicate effects.

Evaluate LLM quality separately on representative tasks: plan completeness,
acceptance coverage, review usefulness, and feedback classification. Track
delivery success, human rework, escaped defects, repair rounds, flaky checks,
cost, and duration by workflow version. Evaluations inform improvements; they
never replace permissions or delivery gates.

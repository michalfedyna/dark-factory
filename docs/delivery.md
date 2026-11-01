# Default end-to-end workflow

```text
explore → confirm issue plan → prepare isolated checkout
  → implement/setup/scaffold → snapshot → checks → QA → independent review
      ↑                                      │             │
      └──────── bounded in-scope repairs ──────┴─────────────┘
  → summary → push branch → draft GitHub PR
```

`dark start` runs the single registered Mastra workflow named `default`, from
exploration through delivery. Stdout contains one final validated delivery JSON
object, not intermediate step outputs. The brief stays in memory until it becomes
part of approved run artifacts; there is no separate issue-file output or save
step. Prompts and progress remain on stderr.

## Setup

1. Run inside the **trusted** Git repository you want to change, on a local branch
   with a commit. Subdirectories are supported. The current branch supplies the
   base, pinned at startup; detached checkouts are rejected rather than guessed.
   Commit intended starting code before running. Uncommitted and untracked user
   work is not copied into the implementation checkout or edited.
2. Install Git and the GitHub CLI. Authenticate `gh auth login` and configure Git
   HTTPS authentication, for example `gh auth setup-git`. The account needs push
   and PR permissions on the inferred repository. The initial version publishes
   to the same GitHub repository, not a fork.
3. For web QA, install `agent-browser` and run `agent-browser install`. For native
   QA, install `agent-device`, run `agent-device doctor`, and prepare Xcode/iOS
   Simulator or Android SDK/emulators. Use test accounts and disposable app data.
   These CLIs are optional host prerequisites, not factory browser/UI dependencies.
4. Install the native sandbox backend: Seatbelt on macOS or Bubblewrap on Linux.
   Project execution fails closed when native isolation is unavailable. Configure
   only the factory's model/router transport, using an external config path if needed.

```sh
cd /path/to/your-app
dark start --config /path/to/DarkFactory/factory.config.json --issue "Add CSV export"
```

The config path selects transport settings, not the target repository. `.env` and
router arguments still resolve alongside that config. There is no `delivery`
section, project-path option, or separate delivery config file.

The final exploration confirmation authorizes the issue plan and an automatic
in-scope run through verification, bounded repairs, and draft PR publication,
including captured screenshots and the verification manifest. There is no
implementation or publication prompt. Only exploration has the `ask` tool;
delivery has no user interaction callback. EOF/cancellation never confirms a
plan. After confirmation, closed stdin does not interrupt autonomous work.

## Repository discovery

Git metadata supplies the root, current branch, and immutable base revision. The
GitHub target comes from `origin`; if origin is absent, only a single unambiguous
GitHub repository among the remotes is usable. SSH and HTTPS GitHub URLs are
supported. Missing, unsupported, or ambiguous GitHub remotes keep a verified
candidate local instead of inventing a publication target. Publication verifies
that the remote base still matches the pinned local commit.

There is no inspection agent or executable-plan prerequisite before implementation.
Implementation reads instructions, manifests, lockfiles, CI, and source from the
pinned checkout, installs dependencies, and scaffolds the app when the approved
task needs it. An initial commit containing only an empty README is sufficient;
the user does not need to prepare an app first. New apps need a manifest, lockfile,
development and verification scripts, and ignores for dependency/build outputs.

Every successful implementation returns `verification`, validated by
[`src/contracts/project.ts`](../src/contracts/project.ts), containing at least one
meaningful deterministic check and all required web/native QA targets. Commands
must match the actual implemented project, including newly created scripts. The
controller captures the candidate before executing those checks and starting QA;
agent claims are not verification evidence. Each repair supplies its own fresh
plan. Only non-UI work may omit targets. Independent browser/device QA and
screenshots belong to the later QA stage, not implementation. Implementation
reports local verification limitations in its summary without claiming a pass;
pending QA alone is not an implementation blocker. Genuine blockers include
specific reasons and may include a known valid plan, or null verification when
none can be supplied. Any implementation blocker stops the run before capture,
checks, or publication, even if a plan is present. Missing scaffolding is
implementation work.

Implementation may change any non-protected repository path within the confirmed
brief. Review independently checks scope. Native-isolated project sandboxes allow
network access for scaffolding, dependency installation, and verification; no
factory API key or GitHub credential environment is passed to project commands.

Web QA uses `agent-browser` from PATH; native iOS/Android QA uses `agent-device`.
Web servers must use a dedicated strict port. Native preparation must build and
install each candidate on the selected test device. Required targets get fresh
open, snapshot, and screenshot evidence each round. Missing tooling or native
builds incompatible with the sandbox block the workflow, rather than silently
disabling isolation or substituting an unrelated app/server. Cross-domain web
login journeys are not supported yet.

Responsive web QA uses the same web target at different sizes. The browser tool's
`viewport` operation accepts `[width, height]` as integer strings from 1 to 10000
CSS pixels, for example `["390", "844"]` for mobile and `["1280", "800"]` for
desktop. QA captures fresh evidence and checks interactions after resizing; native
apps still require `agent-device`. Other browser settings are not exposed.

The workflow has one `sessionTimeoutMs` deadline, including exploration, questions,
confirmation, repairs, and publication. The fixed repair budget allows the initial
implementation plus at most three repairs, shared by checks, QA, and review.
Commands default to a two-minute deadline and execute through Mastra sandboxes.
No factory API key or GitHub credential environment is passed to project commands.

## Gates and repairs

- Implementation, QA, review, and summary use fresh Mastra agents. Implementation
  receives filesystem/sandbox tools. Review has a read-only filesystem provider.
  QA has no workspace, filesystem, or shell tools: it only tests running application
  behavior against acceptance criteria through constrained browser/device operations.
  It does not inspect or review source, tests, configuration, diffs, or log files.
  Neither QA nor review gets a general shell or source-write tool.
  Summary gets no repository or publish tools.
  QA and review must reject missing required UI targets; review also inspects the
  implementation's verification plan for irrelevant, no-op, or weakened checks.
  Implementers receive check-log excerpts for repairs; review can read current
  evidence and screenshot images through its read-only filesystem provider.
  QA receives evidence metadata without file paths and captured UI images directly
  from testing tools. Check outcomes cannot replace observing criterion behavior;
  QA reports criteria it cannot test through available targets as blocked.
  Web and native tools are defined in separate files and exposed as `agent_browser`
  and `agent_device` only when the matching target kind is approved. Each accepts
  an operation such as `open`, `snapshot`, or `screenshot` and literal CLI arguments.
- A trusted Git adapter captures source commits and rejects out-of-scope changes,
  reserved `.git`/`.darkfactory` changes, and `.env` files other than `.env.example`.
  Check/QA/review source mutations invalidate the candidate. Ignore normal build
  outputs in the target repository; tracked source cannot change during checks.
- Required checks have trusted revision-bound exit statuses and private logs. QA
  must cover every acceptance criterion exactly once and cite actual current-round
  evidence IDs. Missing/stale/failed pass evidence, contradictory reports, and
  missing required open/snapshot/screenshot evidence block advancement.
- QA/review defects return to implementation. All checks and QA rerun on every new
  candidate; review reruns after QA passes. A prior green result never approves a
  repaired candidate. Scope changes, questions, implementation blockers, missing
  infrastructure, exhausted budgets, or repeated source trees stop automation.
- For questions, scope changes, and unavailable QA infrastructure, the final JSON's
  `reason` includes the blocking findings, so the cause is visible without opening
  `state.json`.
- Agent-authored acceptance assessments and code reviews are still judgments,
  not mathematical proof. Inspect retained verification artifacts when reviewing the PR; the summary
  is not a gate and cannot override failed verification.

## Publication and artifacts

After exploration confirmation and pinned-base validation, the workflow creates its private run directory at
`<git-root>/.darkfactory/runs/<run-id>/`. No separate issue files are created.
Run directories retain `input.json`, `state.json` (including each candidate's verification plan), round command records, PNG
screenshots, a PR preview, the isolated checkout, and `result.json`. They are
private local artifacts. Git metadata is kept outside the agent's filesystem.
Sandboxes/background processes and run-owned browser/device sessions are stopped
on completion, failure, timeout, or cancellation. Checkouts are retained for
inspection, not automatically deleted.

After passing verification gates, the trusted publisher automatically adds selected successful-round
screenshots and a small verification manifest in `.darkfactory/evidence/<run-id>/`.
It makes a metadata-only commit, verifies that project source still matches the
tested candidate, pushes `darkfactory/<run-id>` without force, and creates a
**draft** PR. The summary identifies the tested code commit separately from the
evidence commit. Images link to immutable GitHub commit URLs; private repository
access is still required. Full private logs and QA/review narrative are not
uploaded. Screenshots are published without a later confirmation and may contain
sensitive information: use test accounts and disposable data. This is not a secret scanning service.

`publication.json` records the branch and publication state before external
effects. A failed/ambiguous push or GitHub response is marked `uncertain` and is
**never automatically retried**. Check that journal and GitHub before any manual
recovery to avoid duplicate PRs. Published PRs are not merged, deployed, or marked
CI-ready by the factory.

## Initial-version boundaries

This implements the delivery slice of [Workflow.md](Workflow.md), not its entire
target architecture. There is no separate architecture/plan-review agent, task
graph/parallel implementation, durable workflow resume, automatic PR-feedback
monitoring, Figma integration, CI polling, or remote/container sandbox provider.
Saved state is diagnostic evidence, not a restart API; a new invocation is a new
run and requires fresh exploration confirmation. Hands-off delivery is the default,
not an opt-in publication flag.

LocalSandbox/native isolation is **not a safe boundary for hostile repositories**.
In particular, Seatbelt permits broad host reads, and local browser/device CLIs
need host access. `allowedPaths` is a commit gate, not a host filesystem ACL.
QA commands are constrained but apps and project execution are trusted local code.
Use a disposable environment without production credentials for unfamiliar code.
Do not use this initial provider for multi-tenant or adversarial workloads.

Offline tests exercise native Mastra workflows, both proxy protocols, filesystem
edits, real Git candidates, repairs, and publication gates. Browser/device binaries
and GitHub effects are substituted in tests: the suite doesn't assert real device,
browser, upstream-model, or GitHub availability.

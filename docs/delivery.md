# Default end-to-end workflow

```text
explore → confirm issue plan → inspect repository
  → implement → snapshot → inferred checks → QA → independent review
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

A read-only Mastra inspection agent reads repository instructions, manifests,
lockfiles, CI definitions, and relevant source to infer:

- Package manager and dependency/setup commands.
- Meaningful deterministic checks, with at least one required check.
- Source paths needed for the approved brief.
- Web servers/URLs or native app identifiers and build/install commands.
- Whether setup or verification requires network access.

The internal execution plan is validated by [`src/contracts/project.ts`](../src/contracts/project.ts)
and used automatically. No project code runs during inspection. Necessary facts
that the repository cannot establish become blockers, never user questions;
the agent must not invent commands or skip required UI verification. It may read working-tree documentation,
but implementation always starts at the pinned committed base.

Web QA uses `agent-browser` from PATH; native iOS/Android QA uses `agent-device`.
Web servers must use a dedicated strict port. Native preparation must build and
install each candidate on the selected test device. Required targets get fresh
open, snapshot, and screenshot evidence each round. Missing tooling or native
builds incompatible with the sandbox block the workflow, rather than silently
disabling isolation or substituting an unrelated app/server. Cross-domain web
login journeys are not supported yet.

The workflow has one `sessionTimeoutMs` deadline, including exploration, questions,
confirmation, repairs, and publication. The fixed repair budget allows the initial
implementation plus at most three repairs, shared by checks, QA, and review.
Commands default to a two-minute deadline and execute through Mastra sandboxes.
No factory API key or GitHub credential environment is passed to project commands.

## Gates and repairs

- Implementation, QA, review, and summary use fresh Mastra agents. Implementation
  receives filesystem/sandbox tools. QA and review have read-only filesystem
  providers. Only QA gets constrained browser/device operations; neither gets a
  general shell or source-write tool. Summary gets no repository or publish tools.
  Implementers receive check-log excerpts for repairs; QA/review can read current
  evidence and screenshot images through their read-only filesystem provider.
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
- Agent-authored acceptance assessments and code reviews are still judgments,
  not mathematical proof. Inspect retained verification artifacts when reviewing the PR; the summary
  is not a gate and cannot override failed verification.

## Publication and artifacts

After exploration confirmation and repository inspection, the workflow creates its private run directory at
`<git-root>/.darkfactory/runs/<run-id>/`. No separate issue files are created.
Run directories retain `input.json`, `state.json`, round command records, PNG
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

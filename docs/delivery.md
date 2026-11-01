# Default end-to-end workflow

```text
explore → confirm issue plan → prepare isolated checkout
  → Figma UI scaffold (only for linked designs)
  → implement/setup/scaffold → snapshot → checks
  → browser/mobile QA → sandbox QA (only if criteria are blocked) → review
      ↑                         │                                   │
      └──────── in-scope repairs ┴───────────────────────────────────┘
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
2. Install Git and the GitHub CLI. Authenticate with `gh auth login`. Publication
   uses GitHub CLI credentials for both HTTPS pushes and PR creation, without
   changing Git configuration or requiring `gh auth setup-git`. This also applies
   when the discovered remote uses SSH. The account needs push and PR permissions
   on the inferred repository. The initial version publishes to the same GitHub
   repository, not a fork.
3. For web QA, install `agent-browser` and run `agent-browser install`. For native
   QA, install `agent-device`, run `agent-device doctor`, and prepare Xcode/iOS
   Simulator or Android SDK/emulators. Use test accounts and disposable app data.
   These CLIs are optional host prerequisites, not factory browser/UI dependencies.
4. Project commands run on the host by default for compatibility. For optional
   native isolation, set `sandbox.isolation` to `"native"` and install Seatbelt on
   macOS or Bubblewrap on Linux. Explicit native mode fails closed when unavailable;
   it never silently falls back to host execution. Model/router transport and this
   execution policy use the factory config, which may live outside the repository.

```sh
cd /path/to/your-app
dark start --config /path/to/DarkFactory/factory.config.json --issue "Add CSV export"
```

The config path selects transport settings, not the target repository. `.env` and
router arguments still resolve alongside that config. There is no `delivery`
section, project-path option, or separate delivery config file.

### Native toolchain environment

Project commands keep a private run-owned `HOME`; they do not inherit the full
factory environment. The controller explicitly supplies a UTF-8 `LANG`/`LC_ALL`,
`JAVA_HOME`, and `DEVELOPER_DIR` when configured on the host. It forwards
`ANDROID_HOME` (or `ANDROID_SDK_ROOT`) and normalizes both to the same SDK path.
Without either variable, it discovers an existing SDK at
`$HOME/Library/Android/sdk` on macOS or `$HOME/Android/Sdk` on Linux, using the
original host home, not the private run home. The active Node, selected JDK,
Android platform-tools, and emulator binaries precede version-manager shims on
`PATH`. Automation receives the same tool locations but retains host CLI precedence
so explicitly selected agent-browser/agent-device wrappers are not bypassed.
Native isolation permits
read access to these toolchain locations, not writes to the host SDK or JDK.

Set custom locations in the launching shell or the config's adjacent `.env`:

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export JAVA_HOME="/path/to/a/compatible/jdk"
export DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer"
```

Use a JDK supported by the project's Gradle version; the newest installed Java
may not be compatible. Install the required Android platform/build-tools and boot
a test device before starting. Host AVD definitions are not copied into the private
run home. For iOS, use an Expo SDK/CLI compatible with the selected Xcode. Xcode 27
replaces `Simulator.app` with `DeviceHub.app`; the missing old application is not
evidence of a broken Xcode installation. Expo SDK 54 does not support that change.
[Expo recommends SDK 58 for Xcode 27](https://github.com/expo/expo/issues/52063),
including Device Hub and simulator-install compatibility fixes. Upgrade the app's
SDK and matching dependencies rather than trying to restore `Simulator.app`.
Missing host tooling or devices must be fixed outside the factory; implementation
must not use system package managers or change host-wide installations.

The final exploration confirmation authorizes the issue plan and an automatic
in-scope run through verification, supervised repairs, and draft PR publication,
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

Issues with supported Figma links first run a dedicated UI-only scaffold agent in
a separate workspace over the same checkout. It creates or maintains presentation
and design-system code, not application logic. Implementation receives the scaffold
and structured handoff, then owns functional wiring and all later repairs. Missing
credentials or unread required sources block before implementation, with zero
candidate rounds. See [Figma setup, ownership and REST limits](figma.md).
Exploration can view PNG previews before confirmation, but does not inspect
implementation-level design details or edit the repository.

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

Figma scaffolding and implementation prefer the latest stable releases for new
apps and new dependencies, verified at run time against official package metadata,
documentation, and release notes. They must check framework peer dependencies and
the actual target toolchain, use framework-compatible version sets and installers,
respect explicit version constraints, and avoid unrelated upgrades or unrequested
prereleases. Compatibility-driven older versions need a documented reason and
sources in the repository handoff. Review checks concrete compatibility/support
issues; it does not demand upgrades merely because newer packages exist.

No general web-search tool is configured. Workspace agents (Figma, implementation,
review, and sandbox QA) can fetch public docs and registry metadata through their
network-enabled Mastra sandbox, using commands such as `npm view` or `curl`.
Exploration has only user interaction and scoped linked-Figma reads, not general
web or shell access. Primary browser/mobile QA remains limited to application
testing; it has no general research capability. Prompt guidance does not add tools
or bypass these boundaries.

Source-generating setup must finish during implementation, before the controller
captures the candidate. For Expo, this includes prebuild and package-script
updates that `expo run:ios`/`expo run:android` would otherwise make during native
preparation. Checks and target preparation must preserve captured source,
manifests, lockfiles, and tests; ignored build outputs may change.

Implementation may change any non-protected repository path within the confirmed
brief. Review independently checks scope. Mastra project sandboxes run on the host
unless native isolation is explicitly enabled. Both modes allow network access for
scaffolding, dependency installation, and verification; no factory API key or
GitHub credential environment is passed to project commands.

Web QA uses `agent-browser` from PATH; native iOS/Android QA uses `agent-device`.
Web servers must use a dedicated strict port. Native preparation must build and
install each candidate on the selected test device. Required targets get fresh
open, snapshot, and screenshot evidence each round. Missing tooling or native
builds incompatible with the selected execution mode block the workflow, rather than silently
disabling isolation or substituting an unrelated app/server. Cross-domain web
login journeys are not supported yet.

Before web QA starts, the controller waits for a successful HTTP response (2xx/3xx)
from each target without an automatic startup deadline. It does not follow
redirects during readiness checks. A refused connection, failing response, or
startup crash cannot count as acceptance evidence. Server startup failures and
exits during QA retain the command and stdout/stderr as failed, revision-bound
`qa-server-<target-id>` check records. The controller marks criteria unverified and
returns those failures and log excerpts to implementation for repair;
QA and review do not approve that attempt. Cancellation is not a defect.
Prefer serving the checked production build for web QA. On macOS, Turbopack's
FSEvents watcher can fail when native Seatbelt isolation is enabled; use a
compatible serving command in that mode instead of changing the execution policy.

Responsive web QA uses the same web target at different sizes. The browser tool's
`viewport` operation accepts `[width, height]` as integer strings from 1 to 10000
CSS pixels, for example `["390", "844"]` for mobile and `["1280", "800"]` for
desktop. QA captures fresh evidence and checks interactions after resizing; native
apps still require `agent-device`. Other browser settings are not exposed.

Work is supervised. Agents have no step cap; the workflow has no overall deadline,
repair-round cap, or repeated-source-tree cutoff. Project, QA, and Git/GitHub
commands have no factory-imposed timeout, and router/app readiness waits until
ready or cancelled. A supervisor can stop the run with Ctrl+C or Escape.
Commands execute through Mastra sandboxes without inheriting factory credentials.
Observer request deadlines and short shutdown deadlines only bound ancillary
reporting and cleanup after work ends; they do not cancel active work. Providers,
operating systems, and external tools may still impose their own limits or fail.

## Gates and repairs

- Implementation, both QA stages, review, and summary use fresh Mastra agents. Implementation
  and review receive separate full Mastra filesystem/sandbox workspaces. Review can
  install dependencies, rerun verification commands, and start background processes
  under the configured project execution/network policy, without factory credentials.
  It independently checks the candidate and reports actual command results and
  limitations; it must not repair source or edit tracked tests/configuration.
  Ignored temporary test artifacts are allowed. Its processes stop in `finally`,
  and the run owner destroys its workspace on completion, failure, or cancellation.
  Browser/mobile QA has no workspace, filesystem, or shell tools: it only tests running application
  behavior against acceptance criteria through constrained browser/device operations.
  It does not inspect or review source, tests, configuration, diffs, or log files.
  Summary gets no repository or publish tools.
  QA and review must reject missing required UI targets; review also inspects the
  implementation's verification plan for irrelevant, no-op, or weakened checks.
  Implementers receive check-log excerpts for repairs; review can read current
  evidence and screenshot images through its filesystem provider.
  Browser/mobile QA receives evidence metadata without file paths and captured UI images directly
  from testing tools. Check outcomes cannot replace observing criterion behavior;
  it reports criteria it cannot test through available targets as blocked,
  with the missing capability in the notes and related findings tied to criterion IDs.
  Web and native tools are defined in separate files and exposed as `agent_browser`
  and `agent_device` only when the matching target kind is approved. Each accepts
  an operation such as `open`, `snapshot`, or `screenshot` and literal CLI arguments.
- The `sandbox-qa` workflow step runs a second agent only when browser/mobile QA
  leaves blocked criteria. Passing or failing criteria are not retested or replaced.
  Candidate-server crashes remain implementation defects rather than escalation requests.
  Sandbox QA gets a full, separate Mastra filesystem and sandbox in the same candidate
  checkout, with the configured execution/network policy and no factory credentials.
  It may inspect files, install dependencies, run API/CLI tests, and start background
  processes to verify the blocked behavior. Earlier UI sessions and servers are
  closed before it starts; it starts any services it needs. It must not repair source
  or edit tracked tests/configuration. Its processes stop in `finally` and its workspace
  is destroyed with the run, including on failure or cancellation.
  Foreground command results become revision-bound `sandbox` evidence; the
  `qa_evidence` tool lists their IDs. Source reading and old check results do not
  establish a sandbox pass. Unresolved criteria remain blocked. The combined report
  preserves primary passes/failures and unrelated findings, replacing only blocked
  results and their resolved criterion-specific questions. `state.json` retains
  `browserQa`, optional `sandboxQa`, and the combined `qa` report for each round.
  A sandbox pass cannot waive required UI captures, checks, or independent review.
- A trusted Git adapter captures source commits and rejects out-of-scope changes,
  reserved `.git`/`.darkfactory` changes, and `.env` files other than `.env.example`.
  Check/QA/review source mutations invalidate the candidate. Check-stage mutations
  become failed `candidate-unchanged` evidence and blocking repair findings, keeping
  all command logs and skipping QA/review. Implementation must correct the setup
  and hand off a newly captured candidate with fresh verification. QA/review
  mutations still terminate the workflow; neither agent may repair source.
  Ignore normal build outputs in the target repository.
- Required checks have trusted revision-bound exit statuses and private logs. QA
  must cover every acceptance criterion exactly once and cite actual current-round
  evidence IDs. Missing/stale/failed pass evidence, contradictory reports, and
  missing required open/snapshot/screenshot evidence block advancement.
- QA/review defects return to implementation. All checks and QA rerun on every new
  candidate; review reruns after QA passes. A prior green result never approves a
  repaired candidate. Scope changes, questions, implementation blockers, missing
  infrastructure, and invalid handoffs still stop automation. Defect repairs have
  no automatic attempt budget; repeated trees still need fresh checks, QA, and review.
- For questions, scope changes, and unavailable QA infrastructure, the final JSON's
  `reason` includes the blocking findings, so the cause is visible without opening
  `state.json`.
- Agent-authored acceptance assessments and code reviews are still judgments,
  not mathematical proof. Inspect retained verification artifacts when reviewing the PR; the summary
  is not a gate and cannot override failed verification.

## Publication and artifacts

After exploration confirmation and pinned-base validation, the workflow creates its private run directory at
`<git-root>/.darkfactory/runs/<run-id>/`. No separate issue files are created.
Run directories retain `input.json` (including the sandbox execution policy), `state.json` (including each candidate's verification plan), round command records, PNG
screenshots, sandbox QA command records when used, a PR preview, the isolated checkout, and `result.json`. They are
private local artifacts. Git metadata is kept outside the agent's filesystem.
Sandboxes/background processes and run-owned browser/device sessions are stopped
on completion, failure, or cancellation. Checkouts are retained for
inspection, not automatically deleted.

Delivery-step execution errors report the actual failed step and a private
`failure.json` path on stderr, including failures inside the nested repair cycle.
That journal retains the underlying error/cause and references to partial current
check evidence even when the step could not save a new `state.json`. Configured
model and Figma tokens are redacted, but this is not a general secret scanner;
keep error artifacts private. Raw provider errors are not printed to the terminal.
Cancellation does not produce a repair finding or failure journal. No failed step
or partial evidence authorizes publication.

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
effects, including the current operation (`push` or `create-pr`). A failed/ambiguous
push or GitHub response is marked `uncertain` and is **never automatically retried**.
The CLI reports the failed operation and journal path without printing raw command
errors or credentials. Check `gh auth status`, repository permissions, that journal,
and GitHub before any manual recovery to avoid duplicate PRs. Published PRs are not
merged, deployed, or marked CI-ready by the factory.

## Initial-version boundaries

This implements the delivery slice of [Workflow.md](Workflow.md), not its entire
target architecture. There is no separate architecture/plan-review agent, task
graph/parallel implementation, durable workflow resume, automatic PR-feedback
monitoring, Figma integration, CI polling, or remote/container sandbox provider.
Saved state is diagnostic evidence, not a restart API; a new invocation is a new
run and requires fresh exploration confirmation. Hands-off delivery is the default,
not an opt-in publication flag.

Default host execution has **no OS isolation**: generated commands can read or
modify files with your account's permissions beyond the run checkout. The private
HOME and separate checkout are organizational boundaries, not access controls.
Optional native isolation is also **not a safe boundary for hostile repositories**.
In particular, Seatbelt permits broad host reads, and local browser/device CLIs
need host access. `allowedPaths` is a commit gate, not a host filesystem ACL.
Browser/mobile QA commands are constrained; fallback sandbox QA has general command
and filesystem access. Apps and project execution are trusted local code.
Use a disposable environment without production credentials for unfamiliar code.
Do not use this initial provider for multi-tenant or adversarial workloads.

Offline tests exercise native Mastra workflows, both proxy protocols, filesystem
edits, real Git candidates, repairs, and publication gates. Browser/device binaries
and GitHub effects are substituted in tests: the suite doesn't assert real device,
browser, upstream-model, or GitHub availability.

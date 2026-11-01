# Initial end-to-end delivery

```text
explore → confirm brief → approve implementation
  → implement → snapshot → configured checks → QA → independent review
      ↑                                      │             │
      └──────── bounded in-scope repairs ──────┴─────────────┘
  → summary → approve publication → push branch → draft GitHub PR
```

`dark start` still only explores an issue. Use `dark start --deliver` to continue
through a separate registered Mastra delivery workflow. Stdout contains one final
validated delivery JSON object instead of the brief. The brief is still saved.
Prompts and progress remain on stderr.

## Setup

1. Use a **trusted** local Git repository and a local base branch. Commit the
   intended starting code and update that branch yourself before starting. The
   factory pins its local commit, not a moving remote branch. Uncommitted and
   untracked user work is not copied or edited. Publication checks that the GitHub
   base branch still matches the approved local commit; drift requires a new run.
2. Install Git and the GitHub CLI. Authenticate `gh auth login` and configure Git
   HTTPS authentication, for example `gh auth setup-git`. The account needs push
   and PR permissions on the configured repository. The initial version publishes
   to the same GitHub repository, not a fork.
3. For web QA, install `agent-browser` and run `agent-browser install`. For native
   QA, install `agent-device`, run `agent-device doctor`, and prepare Xcode/iOS
   Simulator or Android SDK/emulators. Use test accounts and disposable app data.
   These CLIs are optional host prerequisites, not factory browser/UI dependencies.
4. Copy and edit the example. It uses Vite-style server arguments; replace commands
   and paths with your project's actual commands. Keep this config outside agent
   ownership. Paths resolve from the config file's directory.

```sh
cp config/delivery.example.json factory.delivery.json
# Edit repository, githubRepo, allowedPaths, commands, and targets first.
npm run dev -- start --config factory.delivery.json --deliver --issue "Add CSV export"
```

The example omits `model` and `router`, so their existing defaults apply. Merge
your custom transport settings if needed. `.env` is loaded alongside this config.
For built CLI use `dark start --config factory.delivery.json --deliver`.

The **Implement** decision authorizes the displayed brief, pinned base, configured
source scope, commands, targets, and repair budget. Any other answer stops before
repository preparation. Later, **Publish** authorizes the displayed summary,
candidate, branch, verification manifest, and captured screenshots. **Keep local**
returns `ready` without Git push or GitHub operations. EOF/cancellation never
approves either action.

## Configuration

Add an optional `delivery` section to the existing factory configuration. Unknown
fields are rejected. [`src/config/delivery.ts`](../src/config/delivery.ts) is the
authoritative schema.

| Field                              | Default / requirement                                                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repository`                       | Required local Git repository path.                                                                                                                                                 |
| `baseBranch`                       | Required local branch, also used as the GitHub PR base.                                                                                                                             |
| `githubRepo`                       | Required `owner/repository` on github.com.                                                                                                                                          |
| `trustedLocalExecution`            | Must explicitly be `true`.                                                                                                                                                          |
| `allowedPaths`                     | Required nonempty list of relative files/directories; `.` allows all nonprotected paths. Changes outside this scope block the run.                                                  |
| `isolation`                        | `native`: require Mastra's detected Seatbelt/Bubblewrap backend. `none` explicitly opts into direct host execution.                                                                 |
| `allowNetwork`                     | `false` for native project sandboxes. Enable for dependency downloads or required services. Not an egress policy for browser/device host automation; it has its own network access. |
| `setup`                            | `[]`: dependency/bootstrap commands, run once before implementation.                                                                                                                |
| `checks`                           | Required nonempty list of commands with unique `id`s, run on every candidate.                                                                                                       |
| `targets`                          | `[]`: no UI QA for backend/CLI-only work. Every configured UI target is required.                                                                                                   |
| `browserCommand` / `deviceCommand` | `agent-browser` / `agent-device`; executable name on PATH or absolute path.                                                                                                         |
| `maxRepairRounds`                  | `3`: initial implementation plus at most three repairs, shared by checks, QA, and review.                                                                                           |
| `timeoutMs`                        | `3600000`: total delivery deadline, including approval waits. Exploration keeps its separate `sessionTimeoutMs`.                                                                    |
| `runsDir`                          | `.darkfactory/runs`: private run artifacts and retained checkouts.                                                                                                                  |

Each command is `{ "command": "npm", "args": ["run", "build"], "timeoutMs": 120000 }`.
`args` defaults to `[]`; `timeoutMs` defaults to two minutes. Programmatic commands
use Mastra sandboxes; server argv is shell-quoted before Mastra process spawning.
No host API key or GitHub credential environment is passed to project commands.

### Web targets

```json
{
  "id": "web",
  "kind": "web",
  "url": "http://127.0.0.1:3000",
  "start": { "command": "npm", "args": ["run", "dev"] },
  "screenshots": true
}
```

`start` is required and runs from the candidate checkout for every QA round. Use
a dedicated port and a server that **fails** if the port is already in use; don't
silently test an unrelated existing server. Configure the URL to match that
server. The controller checks the server has not exited during QA. It doesn't
prove the server's deployment/source provenance beyond the configured commands.
QA opens the configured URL, takes accessibility snapshots, tests criteria, and
captures evidence through `agent-browser`. A separate session is used per
run/round/target. Navigation is limited to the configured hostname by
`agent-browser`; cross-domain login journeys aren't supported in this version.

### Native mobile targets

```json
{
  "id": "ios",
  "kind": "mobile",
  "platform": "ios",
  "app": "com.example.app",
  "device": "iPhone 17 Pro",
  "prepare": { "command": "npm", "args": ["run", "build-and-install:ios"] },
  "start": { "command": "npm", "args": ["run", "metro"] },
  "screenshots": true
}
```

`platform` is `ios` or `android`. `device` and the background `start` command are
optional. `prepare` is required and runs on **every** candidate: it must build and
install that candidate on the selected test device. Its exit status is recorded
as a required check. Don't point QA at an unrelated previously installed build.
Native build tools may require explicit `isolation: "none"` on a trusted host.
QA uses `agent-device`, not browser device emulation. Unavailable apps/devices or
tooling block delivery. Screenshot capture defaults to `true` for both target
kinds; turn it off explicitly where screenshots are not appropriate.

## Gates and repairs

- Implementation, QA, review, and summary use fresh Mastra agents. Implementation
  receives filesystem/sandbox tools. QA and review have read-only filesystem
  providers. Only QA gets constrained browser/device operations; neither gets a
  general shell or source-write tool. Summary gets no repository or publish tools.
  Implementers receive check-log excerpts for repairs; QA/review can read current
  evidence and screenshot images through their read-only filesystem provider.
  Web and native tools are defined in separate files and exposed as `agent_browser`
  and `agent_device` only when the matching target kind is configured. Each accepts
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
  not mathematical proof. Configure meaningful deterministic checks; the summary
  is not a gate and cannot override failed verification.

## Publication and artifacts

Run directories retain `input.json`, `state.json`, round command records, PNG
screenshots, a PR preview, the isolated checkout, and `result.json`. They are
private local artifacts. Git metadata is kept outside the agent's filesystem.
Sandboxes/background processes and run-owned browser/device sessions are stopped
on completion, failure, timeout, or cancellation. Checkouts are retained for
inspection, not automatically deleted.

After publication approval, the trusted publisher adds selected successful-round
screenshots and a small verification manifest in `.darkfactory/evidence/<run-id>/`.
It makes a metadata-only commit, verifies that project source still matches the
tested candidate, pushes `darkfactory/<run-id>` without force, and creates a
**draft** PR. The summary identifies the tested code commit separately from the
evidence commit. Images link to immutable GitHub commit URLs; private repository
access is still required. Full private logs and QA/review narrative are not
uploaded. Screenshots may contain sensitive information: inspect them before
choosing Publish. This is not a secret scanning service.

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
run and requires fresh approvals. There is no unattended publication flag.

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

# Issue brief v1.0

The contract lives in [`src/contracts/issue.ts`](../src/contracts/issue.ts).
`IssueBrief` is inferred from `issueBriefSchema`; do not maintain a separate
interface that can drift away from runtime validation.

| Field                    | Meaning                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `schemaVersion`          | Literal `"1.0"`, so downstream agents can recognize the contract.          |
| `title`                  | Short issue title.                                                         |
| `kind`                   | `feature`, `bug`, `chore`, or `research`.                                  |
| `problem`                | What is wrong or missing now.                                              |
| `desiredOutcome`         | The observable result the user wants.                                      |
| `users`                  | People or systems affected.                                                |
| `scope.in` / `scope.out` | Included work and explicit non-goals.                                      |
| `requirements`           | `{ id, description, priority }`; priority is `must`, `should`, or `could`. |
| `acceptanceCriteria`     | `{ id, given, when, then }`, describing testable behavior.                 |
| `constraints`            | Known limits, such as platform, security, budget, or compatibility.        |
| `assumptions`            | Unverified statements, separated from confirmed facts.                     |
| `decisions`              | `{ question, answer }` records of decisions made with the user.            |
| `risks`                  | Known failure modes, dependencies, or delivery risks.                      |
| `openQuestions`          | Information that still needs clarification.                                |
| `readiness`              | `ready` or `needs-clarification`.                                          |
| `confirmedByUser`        | Whether the user explicitly confirmed the proposed brief.                  |

All fields are required. Use `[]` for absent list information. Strings must be
nonempty (maximum 8,000 characters). Lists have at most 100 items. Requirements
and acceptance criteria each need at least one item and unique IDs within their
list. The agent is instructed to use `R1`, `R2`, … and `AC1`, `AC2`, … respectively.
Unknown object fields are rejected.

`ready` is valid only when `confirmedByUser` is true and `openQuestions` is empty.
This is a schema consistency check, not proof of factual completeness: the model
is responsible for faithfully recording the conversation, and the user should
review the brief before downstream execution. Unverified assumptions remain
visible even in a confirmed brief.

The `default` workflow passes the brief in memory from exploration to preparation,
just like other step outputs. There is no separate issue JSON file or save step.
Exploration confirmation is the last interaction and authorizes automatic delivery
through a verified draft PR. Only exploration agents can ask questions. After
delivery preparation, the run's private input/state artifacts include the
brief alongside project settings and candidate verification plans. Stdout is
reserved for the final validated workflow result; prompts and progress go to
stderr. Active conversations are not saved for resume.

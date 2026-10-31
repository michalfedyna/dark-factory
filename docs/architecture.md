# CLI issue exploration

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

One invocation explores one issue. Start another invocation for another issue.
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

Implementation and QA agents are not implemented yet. Their repository commands,
dependency installs, builds, tests, and background processes should use Mastra
`Workspace` and sandbox providers, including the generated filesystem and command
tools, rather than a custom command execution layer. See the
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

Not included yet: repository tools, source edits, planning/build agents, token
streaming, durable agent suspension, or remote/multi-user interfaces.

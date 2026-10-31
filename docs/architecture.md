# CLI issue exploration

## Boundaries

- `contracts/` defines data and callback interfaces without importing application
  modules. It contains no presentation markup or browser transport state.
- `agents/` defines model behavior. `tools/` adapts the injected `Ask` capability
  into a Mastra tool. Neither depends on terminal rendering.
- `factory/` owns exploration deadlines, input/output validation, and persistence.
  Agent execution and saving are injectable for offline tests.
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
3. Create a fresh exploration agent and run ID. The factory combines process,
   proxy-exit, and exploration-deadline cancellation signals.
4. The agent calls `ask` with a validated question. Its execution awaits the real
   user's answer. In a TTY, Clack offers choices plus Other or a text prompt.
   Non-TTY input uses a single buffered line reader for the whole run.
5. Validate the answer and continue the same agent run with its tool result.
   Questions execute sequentially. EOF, Escape, and cancellation never produce
   invented answers or implicit confirmation.
6. Validate the final issue brief with Zod, write a private exclusive JSON file,
   and print only the brief to stdout. Show the saved path on stderr.
7. Close terminal input and stop the owned proxy after completion or failure.

One invocation explores one issue. Start another invocation for another issue.
There is no session polling, browser state, or durable conversation resume.

## Cancellation and failures

All model/tool work receives an AbortSignal. Prompts and pending line reads listen
to it. The orchestration also races cancellation so a non-responsive model cannot
keep the run alive beyond its deadline. A late model result is checked for
cancellation before saving. Run completion closes any remaining tool waits.

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
- Add versioned contracts before downstream planning or implementation stages.
- Keep terminal rendering and line/TTY behavior in `cli/`.
- Add durable run storage when resume becomes a requirement, without coupling
  persistence to terminal widgets.

Not included yet: repository tools, source edits, planning/build agents, token
streaming, durable agent suspension, or remote/multi-user interfaces.

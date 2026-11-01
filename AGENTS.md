# DarkFactory

## Purpose

DarkFactory is an autonomous software factory. It uses AI agents to turn software requirements into working software with minimal manual work.

## Technology

- Use TypeScript and Node.js.
- Use [Mastra](https://mastra.ai/docs) for AI agents and workflows.
- Use [Commander](https://github.com/tj/commander.js) for CLI commands, arguments, options, help, and version output.
- Use [Clack](https://github.com/bombshell-dev/clack) for interactive prompts and progress output.

## Mastra First

- Prefer functionality provided by Mastra over custom implementations. Check the current Mastra documentation before building infrastructure that the framework may already provide.
- Use registered [Mastra workflows](https://mastra.ai/docs/workflows/overview) for task orchestration, steps, run state, and execution control. Do not build a custom Sessions class or workflow engine.
- Define separate workflows for different tasks when their steps or control flow differ. Reuse steps or nested workflows where useful; do not force every task through one workflow.
- Use Mastra [workspaces and sandboxes](https://mastra.ai/docs/sandbox/overview) for implementation and review agents that need repository access, commands, dependency installation, builds, tests, or background processes. Prefer framework-provided filesystem and sandbox tools over custom equivalents.
- QA agents only test running application behavior against acceptance criteria. Give them constrained application-testing tools, not repository, filesystem, or shell access. They must not inspect or review files; code inspection belongs to the review agent.
- Scope sandbox environments to the task or workflow run, and explicitly manage their lifecycle and cleanup. Do not share mutable environments across unrelated runs.
- An ordinary LocalSandbox runs on the host; it is not a security boundary. Use native isolation or a remote/container sandbox for untrusted code, and restrict network access and credentials to what the task needs.

## Architecture

- Keep the core small and focused.
- Build separate modules with clear responsibilities.
- Keep coupling low: modules should depend on each other as little as possible.
- Keep cohesion high: related behavior should stay together.
- Connect modules through small, clear interfaces.
- Keep the CLI, configuration, and factory logic separate.
- Prefer simple solutions over complex abstractions.

## Readability

- Keep orchestration, resource setup, policy checks, persistence, and rendering separate. Extract cohesive responsibilities, not arbitrary chunks or tiny forwarding files.
- Make workflow definitions read as a sequence of named steps. Put detailed step behavior and pure gate decisions in focused modules.
- Make dependencies and initialization order explicit through typed inputs and run/round contexts. Avoid callbacks that rely on uninitialized shared variables or undocumented call order.
- Keep live workspaces, sandboxes, and processes separate from serializable workflow state. Give resources a clear owner and make cleanup safe after partial initialization.
- Organize folders by clear responsibility and feature ownership. Keep external adapters in `integrations/`; keep domain policy outside it. Avoid catch-all `runtime`, `shared`, or `utils` modules.
- Name values by their actual role, such as `projectSandbox` or `reviewWorkspace`. Define role-specific agent context types; reserve `unknown` for genuinely untrusted boundaries.
- Use a consistent state-update style. Assert stage preconditions explicitly instead of relying on scattered non-null assertions and implicit history invariants.
- Format prompts into readable paragraphs or lists. Build long rendered output from named sections instead of dense templates with inline logic.
- Extract reusable test setup so scenarios and assertions remain visible. Do not identify agent roles or test scenarios by matching incidental prompt wording.
- Keep developer navigation and folder maps current. Clearly distinguish implemented behavior from future design documents.

## Running the Factory

- Start the factory through a CLI and a configuration file.
- Use the CLI as a thin entry point, not as the home for business logic.
- Make factory behavior configurable without changing the core.
- Provide rich configuration options with sensible defaults.
- Validate configuration before starting work and explain errors clearly.
- Keep configuration explicit and easy to understand.

## Interaction and Copy

- The CLI is the only user interface for now. Do not add a web app, local UI server, or browser UI dependencies.
- Use Commander for commands and Clack for interactive terminal prompts and progress.
- Keep terminal output compact and functional. No slogans, decorative banners, filler paragraphs, or redundant status messages.
- Do not explain obvious controls. Keep prompts and actions short and direct.
- Send prompts, progress, and diagnostics to stderr; reserve stdout for the final validated JSON.
- Support suggested answers and free text. Cancellation and input ending must never count as confirmation.
- Use short, direct action labels. Show context only when it helps the user make a decision.
- Show real content and useful state, not placeholders describing future content.
- When in doubt, remove it. Less is better.

## Working on This Project

- Use simple English in code comments, documentation, and CLI messages.
- Keep changes focused and consistent with the architecture.
- Avoid unnecessary dependencies and features.
- Test module behavior and the boundaries between modules.
- Document configuration options and changes to user-facing behavior.

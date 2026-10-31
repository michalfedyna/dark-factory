# DarkFactory

## Purpose

DarkFactory is an autonomous software factory. It uses AI agents to turn software requirements into working software with minimal manual work.

## Technology

- Use TypeScript and Node.js.
- Use [Mastra](https://mastra.ai/docs) for AI agents and workflows.
- Use [Commander](https://github.com/tj/commander.js) for CLI commands, arguments, options, help, and version output.
- Use [Clack](https://github.com/bombshell-dev/clack) for interactive prompts and progress output.

## Architecture

- Keep the core small and focused.
- Build separate modules with clear responsibilities.
- Keep coupling low: modules should depend on each other as little as possible.
- Keep cohesion high: related behavior should stay together.
- Connect modules through small, clear interfaces.
- Keep the CLI, configuration, and factory logic separate.
- Prefer simple solutions over complex abstractions.

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

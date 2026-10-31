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

## Working on This Project

- Use simple English in code comments, documentation, and CLI messages.
- Keep changes focused and consistent with the architecture.
- Avoid unnecessary dependencies and features.
- Test module behavior and the boundaries between modules.
- Document configuration options and changes to user-facing behavior.

# DarkFactory

A CLI that turns an issue into working software, with automated checks, UI QA,
independent review, and a draft GitHub PR.

## Requirements

- Node.js 22.18+ on 22.x, 24.11+ on 24.x, or 26+; npm
- [CLIProxyAPI](https://help.router-for.me/introduction/quick-start.html) v8
- Provider credentials for `gpt-6.1-sol` or another model with tool support
- A trusted Git repository on a local branch with at least one commit

PR publication requires an authenticated [GitHub CLI](https://cli.github.com/).
UI QA requires the applicable browser/device tools.

## Setup

From the DarkFactory directory:

```sh
npm install
brew install cliproxyapi
cp config/router.example.yaml config/router.yaml
cp .env.example .env
```

Skip copying files you already configured. Set the same private client key in
`config/router.yaml` (`access.api-keys`) and `.env` (`DARKFACTORY_API_KEY`). This is
the proxy client key, **not** your provider API key. Both files are gitignored.

Authenticate the proxy, then build and link the CLI:

```sh
cliproxyapi -config config/router.yaml --codex-login
npm run build
npm link
```

For other providers, follow the [router documentation](https://help.router-for.me).

## Run

Run from the repository you want to work on:

```sh
dark start
dark start --issue "Export filtered issues as CSV" > delivery.json
```

Answer the follow-up questions and confirm the plan. The factory then implements,
verifies, repairs, and publishes a draft PR without further approval prompts.
Without a usable GitHub remote, verified work stays local. Confirmation also
authorizes publication of verification screenshots.

- `--config /path/to/factory.config.json`: use configuration stored elsewhere.
- `--debug`: show live agent activity instead of progress summaries.
- Ctrl+C or Escape: cancel the run. Interrupted runs cannot be resumed.

The final result is JSON on stdout; prompts and diagnostics go to stderr.
Run artifacts are saved under `.darkfactory/runs/` in the target repository.

## Configuration

Edit [`factory.config.json`](factory.config.json) to configure the model, proxy,
progress summaries, sandbox isolation, and Figma access.

- To use an existing proxy, set `router.managed` to `false` and configure
  `model.baseUrl`, `model.api`, and `model.apiKeyEnv`. Otherwise, stop any proxy
  service already using the configured port.
- For issues with Figma links, set `FIGMA_ACCESS_TOKEN` in `.env`.
- To disable progress summaries and their extra model calls, set
  `observer.enabled` to `false`.

`.env` and router arguments are resolved relative to the config directory.
Environment variables override `.env` values. The config location does not select
the target repository.

Documentation searches use the configured model for one extra, tool-free cleanup
call per nonempty search. It cleans titles and snippets into plain text without
changing source URLs or ranking. If cleanup fails or exceeds 30 seconds, search
returns the parsed results with a cleanup error. Search snippets are not verified
documentation; the documentation agent still reads the relevant source pages.

## Safety

Project commands run on your host by default. Use trusted repositories, test
accounts, and disposable data. Set `sandbox.isolation` to `"native"` for native
isolation, or use a disposable remote/container environment for untrusted code.
Keep `.darkfactory/` and debug logs private; they may contain sensitive data.

## Development

```sh
npm run dev -- start  # Run without building
npm test             # Build and test; no provider credentials needed
npm run check        # Run all checks
```

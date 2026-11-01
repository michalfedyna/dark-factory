# Documentation subagent

Implementation and Figma UI agents have a native Mastra `documentation` subagent,
called through `agent-documentation`. Their instructions require consulting it
before implementing or scaffolding with a library/framework, including existing
dependencies. This is the preferred route for API, setup, migration and
compatibility research, not ad-hoc shell searches or model memory.

The caller first inspects local manifests, lockfiles and runtime constraints. It
then sends public package names, installed/intended versions and a focused API
question. A guide can be reused for the same version and question within that
agent session; new libraries, versions or unresolved questions need another lookup.
This is an agent instruction, not a controller gate that detects library usage.
There is no extra workflow stage or user approval.

## Tools and output

Only the documentation agent gets:

- `search_web`: free, keyless DuckDuckGo HTML search. Input is `query` (1–500
  characters) and optional `maxResults` (1–10, default 5). Output contains titles,
  destination URLs, snippets and a nullable `error`. Links are decoded and
  deduplicated; ads are excluded. Titles and snippets are bounded to 240 and 1,000
  characters. Search responses are limited to 1 MB and 15 seconds.
- `web_fetch`: Mastra's built-in public-page reader. It blocks local/private
  destinations, bounds responses and redirects, and reports fetch failures.
  It can return raw/truncated HTML, so the agent prefers `llms.txt` indexes and
  linked Markdown/plain-text pages and must report missing API content.

Search snippets are discovery hints. The agent must fetch primary sources before
claiming API guidance is verified, favor version-matched official docs, registries
and release notes, and label community sources or unknowns.

The result is a compact Markdown guide, normally at most 600 words: **Version**,
**Guide**, **Pitfalls**, **Sources**, and **Limits**. It includes only needed APIs,
setup steps, useful small examples and exact source URLs actually read. Mastra
returns the guide to the parent without adding nested search/page payloads to the
parent's model context. Raw delegation results remain available for diagnostics.

## Cost, privacy and failures

Search needs no API key, account, paid provider tool or new factory configuration.
It is a best-effort HTML integration, not an official search API with an availability
guarantee. DuckDuckGo can challenge, rate-limit, block requests or change its markup.
Failures are explicit and are not retried automatically or disguised as no results.
The agent can fetch known official URLs directly; otherwise it must report missing
evidence, not invent APIs. Normal configured-model usage still costs tokens.

Search queries go to DuckDuckGo and page requests go to the destination sites.
Parent conversation history is filtered out at the native delegation boundary;
only the focused delegation prompt is forwarded. Both roles are instructed not to
send private code, credentials, internal URLs, or task/customer details in requests.
This instruction is not a general secret scanner or network security boundary.

The documentation agent has no workspace, filesystem, shell, implementation or
publication tools. Web content and its guide are untrusted reference data, not
policy, authorization or proof that implementation tests passed. Parent cancellation
propagates through Mastra to subagent and search requests. QA and review retain
their independent verification roles and do not receive this subagent.

## Code map

- `src/agents/documentation.ts`: read-only role, native Mastra agent and guide format.
- `src/tools/search-web.ts`: validated `search_web` tool.
- `src/tools/web-fetch.ts`: typed access to Mastra's built-in reader (a workaround
  for its NodeNext declaration; no custom fetch implementation).
- `src/integrations/web/search.ts`: fixed DuckDuckGo endpoint and HTML adapter.
- `src/agents/shared.ts`: library research and dependency-selection instructions.
- `src/agents/implementation.ts`, `src/agents/figma.ts`: subagent registration and
  parent-message filtering.

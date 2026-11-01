# Figma design access

Include a Figma link in an issue to run the UI agent after exploration confirmation
and before implementation. Links in the approved brief also count, including ones
provided in follow-up answers. Original issue links are retained even if exploration
omits them from its output. Issues without supported links skip this stage.

```sh
dark start --issue "Build the settings page from https://www.figma.com/design/FILE_KEY/Settings?node-id=1-2"
```

## Setup

Set `FIGMA_ACCESS_TOKEN` in the environment or the factory config directory's `.env`.
Use a Figma personal access token with access to the linked files and
`file_content:read`. Library endpoints need `library_content:read`; optional local
variables need `file_variables:read` and eligible Enterprise membership.

The factory config supports:

```json
{
  "figma": {
    "tokenEnv": "FIGMA_ACCESS_TOKEN",
    "auth": "personal"
  }
}
```

`tokenEnv` names an environment variable, not the token itself. Set `auth` to
`oauth` to supply an existing OAuth access token through the same variable. The
factory does not implement OAuth login or token refresh. Credentials are required
only when a Figma source is present; missing credentials block before implementation.
Never commit tokens to configuration or source files.

## Scope and handoff

### Exploration

Before confirmation, exploration uses PNG exports to understand the linked screens
and ask short product questions. Node links render directly; whole-file links first
return only top-level screen IDs and names so it can choose relevant PNGs. There is
no detailed node, layout, style, token or component inspection in this stage; that
belongs to the UI agent.

Exploration can preview links from the original issue and real follow-up answers.
Each agent session has its own source allowlist. Designs cannot grant access to
other files. The preview tool has no repository, filesystem, shell or Figma write
access. PNGs are downloaded without credentials from supported Figma CDN hosts,
validated, limited to 10 MB each, and sent as images, not textual URLs. Chat
transports use a Mastra request processor to place them in image-capable user
messages; Responses keeps native multimodal tool results.

If access is unavailable, exploration explains the limitation and asks for missing
product information rather than inventing design details or asking for credentials
in chat. Essential unanswered questions still prevent confirmation. Inspection
results are not candidate verification evidence.

### UI scaffolding

The Figma agent has a separate run-owned Mastra workspace and sandbox in the same
checkout used by implementation. It can install UI dependencies and create a minimal
app scaffold when needed. Its role is limited to:

- Presentational screens, layouts, responsive styles, accessibility and assets.
- Reusable components, variants, tokens, themes and design-system documentation.
- Creating or maintaining the repository's design system within the approved issue.
- Typed props and callbacks, explicit sample content, and a structured handoff of
  component interfaces and unwired behavior.

It must not implement business logic, API calls, authentication, persistence, domain
validation, routing behavior or state management, or rewire existing functionality.
This is a role/review policy, not a semantic filesystem security boundary.

Implementation reads the scaffold and handoff, wires the functional behavior,
replaces sample content, and supplies meaningful checks and QA targets. The Figma
stage runs once, not on each repair. Implementation owns subsequent UI and functional
repairs; independent checks, acceptance QA, code review and publication gates remain
unchanged. Scaffold changes and handoff claims do not count as verification evidence.

The serializable delivery state records canonical sources and the validated handoff:
summary, components, design-system changes, implementation notes, limitations and
blockers. Raw API payloads and credentials are not added to workflow state. Debug
logs can include design data and temporary asset URLs; keep them private.

## REST access and limits

Both roles expose a `figma` Mastra tool with different capabilities. REST calls
use only GET requests to `https://api.figma.com/v1`. The tools accept user-supplied
source URLs, normalized against the session allowlist, rather than arbitrary endpoints or
headers. Redirects are rejected. The token stays in controller-owned request headers;
it is not passed to agent context or project sandbox environments.

Supported links use `figma.com` or `www.figma.com`, HTTPS, and `/design/`, `/file/`
or `/proto/`. Branch links use the branch key. Node IDs are normalized and tracking
parameters are removed. `version-id` pins file, node and rendered-image requests;
library metadata, image fills and variables endpoints return current data only.
Community, FigJam and non-file links are not supported.

The UI agent's full tool reads file trees, nodes, PNG/SVG renders, image fills, published components,
component sets/styles and local variables. PNG renders are available as model image
content. Whole-file discovery defaults to depth 2; focused node reads can fetch full
subtrees. Needed export assets should be downloaded into the repository rather than
shipping expiring CDN URLs. No authenticated asset downloads are exposed.

Every source must actually be inspected by the UI agent's tool before a successful
handoff: a linked node requires a successful node read; a whole-file link requires
a file read. Missing nodes, permission failures and inaccessible required designs
block the run. Optional variables/library access failures may be reported as
limitations when resolved node styles are sufficient. Rate-limit errors are surfaced;
there is no automatic polling or retry loop. Cancellation reaches REST requests.

This integration does **not** edit the Figma canvas, publish libraries, or create
Figma variables. Design-system creation and maintenance happen in repository code.
It does not add a browser UI or an additional user approval gate.

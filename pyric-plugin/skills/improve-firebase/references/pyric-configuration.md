# Pyric configuration audit

Read this reference whenever Pyric is installed or referenced by build configuration, development scripts, Rules workflows, or agent tooling. Audit the installed version. Do not upgrade or rewrite configuration during recon.

## Package and API surface

Check package manifests, lockfiles, imports, scripts, and overrides:

- use `@pyric/cli` for the CLI and build integrations
- import `{ pyric }` from `@pyric/cli/vite`
- use `pyric()` as the Vite plugin name
- use `withPyric` from `@pyric/cli/next` for a Next.js integration
- treat `pyric-tools`, `pyricSandbox`, and `pyric/rules/node` as retired names
- flag absolute `file:/...` dependencies that point to a global installation
- flag overrides or downgrades added only to make a retired name resolve

Confirm versions from the lockfile and installed package. If `pyric` and `@pyric/cli` disagree, inspect their actual exports and report the concrete failure risk. Do not choose an older version to force compatibility.

## Launcher and bridge

Identify one development launcher:

- Vite should keep one existing `plugins` array with one `pyric({ bridge: true })` when agent access is needed, then use the normal Vite dev script.
- A project launched by `pyric dev` should place Pyric flags before the `--` child-command separator.
- Next.js should use `withPyric` and the project's documented local CLI launch. Read the installed wrapper types before proposing options because Vite-only options do not automatically apply to Next.

Flag duplicate `plugins` properties, duplicate Pyric plugin entries, Vite and `pyric dev` running as competing launchers, or a static MCP URL that bypasses the plugin's stdio discovery.

When a server is already running, inspect `/__pyric/health`. Agent data-plane work requires `sandboxConnected: true`; a listening server alone is not enough. Do not start or restart a server solely to increase audit depth.

## Vite options

Inspect the options supported by the installed `@pyric/cli/vite`. Current surfaces may include:

- `root` and `rules` for project and Rules discovery
- `persist`, `fresh`, and `seed` for local state
- `capture` for `.pyric/last-session.json`
- `bridge`, `ui`, and `runtimeChip` for development access
- `functions` for supported local Functions discovery
- `swapInBuild` for deliberate sandbox builds
- `ai` for scripted, OpenAI-compatible, or production-pass-through AI Logic

Report options only when they change an application outcome or create a misleading local/production boundary. Read [ai-logic.md](ai-logic.md) whenever `ai` or a `PYRIC_AI_*` key is present.

## Rules and Firebase configuration

Confirm:

- `firestore.modules.rules` and `storage.modules.rules` are authored sources when those services are active
- `firestore.rules` and `storage.rules` are generated deployment artifacts
- `firebase.json` points at the generated artifacts
- the build script resolves modules before lint, simulation, verification, or deployment
- explicit `root` or `rules` values still resolve the intended project and authored source

Compare source and generated artifacts without overwriting either during an audit.

## Keep development out of production

A normal Vite production build keeps the real Firebase SDK. A non-production build swaps in Pyric, and `swapInBuild: true` deliberately produces a sandbox build that Firebase Hosting must not receive.

Inspect exact build and deploy scripts for:

- production commands using a development Vite mode
- `swapInBuild: true` on a deployable build path
- local seed, persisted state, bridge, or proxy assumptions in release checks
- ambiguous Firebase project selection
- AI production pass-through enabled in a shared development environment

Record the command and configuration path that forms the boundary. Do not run a deploy or enable a production service to prove it.

## Report capability limits

Use local `--help`, installed types/exports, MCP tool discovery, and health output as the source of truth. A tool described by newer documentation is unavailable when the installed package does not expose it. Report the missing capability and its effect; do not install a new CLI, invent a command, or silently replace the project's configuration.

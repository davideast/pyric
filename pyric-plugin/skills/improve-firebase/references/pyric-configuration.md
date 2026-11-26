# Pyric configuration audit

Read this reference whenever Pyric is installed or referenced by build configuration, development scripts, Rules workflows, or agent tooling. Audit the installed version. Do not upgrade or rewrite configuration during recon.

## Package and API surface

Check package manifests, lockfiles, imports, and scripts:

- use `@pyric/cli` for the CLI and build integrations
- import `{ pyric }` from `@pyric/cli/vite`
- use `pyric()` as the Vite plugin name (`hosted: true` for Node host, `bridge: true` for browser SharedWorker bridge)
- use `withPyric` from `@pyric/cli/next` for a Next.js integration
- use `@pyric/rules` for standalone rules unit-testing when installed without the rest of Pyric
- use `@pyric/live` (`pyric-live`, `@pyric/live/vite`, `@pyric/live/register`) only for deliberate live-mode observation against a real Firebase project
- flag direct `@google-cloud/firestore` or `@google-cloud/storage` imports in sandboxed Node/SSR code (stopped with `PYRIC_REAL_SDK_STOPPED` under `@pyric/cli/register` and Vite SSR; use `firebase/*` or `firebase-admin/*`)
- flag `bun`, `bunx`, or `deno` child commands launched under `pyric sandbox` or `pyric run` (refused with `PYRIC_UNSUPPORTED_RUNTIME` because they cannot evaluate Node loader hooks)
- flag absolute `file:/...` dependencies that point to a global installation

Confirm versions from the lockfile and installed package. Inspect the exports used by the project and report any concrete mismatch without changing package versions during the audit.

## Launcher and bridge

Identify one development launcher:

- Vite should keep one existing `plugins` array with one `pyric({ bridge: true })` when agent access is needed, then use the normal Vite dev script.
- A project launched by `pyric sandbox` should place Pyric flags before the first child command token. Use `--` as an explicit separator when needed.
- Next.js should use `withPyric` and the project's documented local CLI launch. Read the installed wrapper types before proposing options because Vite-only options do not automatically apply to Next.

Flag duplicate `plugins` properties, duplicate Pyric plugin entries, Vite and `pyric sandbox` running as competing launchers, or a static MCP URL that bypasses the plugin's stdio discovery.

When a server is already running, inspect `/__pyric/health`. Agent data-plane work requires `sandboxConnected: true`; a listening server alone is not enough. Do not start or restart a server solely to increase audit depth.

## Vite options

Inspect the options supported by the installed `@pyric/cli/vite`. Current surfaces may include:

- `root` and `rules` for project and Rules discovery (including named Firestore databases and per-bucket Storage rules in `firebase.json`)
- `hosted` for the Node-hosted sandbox (`.pyric/state/hosted/state.sqlite`, no open browser tab required)
- `persist`, `fresh`, and `seed` for local state
- `capture` for `.pyric/last-session.json`
- `bridge`, `ui`, and `runtimeChip` for development access
- `remoteAccess` (`allowedHosts`, `allowPeers`, `trustProxy`, `browserUnlock`) for reverse-proxy and two-hop proxy access; note that Vite `server.allowedHosts: true` is deliberately ignored on `/__pyric/*`, remote browsers pair via `/__pyric/unlock#code=<token>` (port-scoped `__pyric_session_<port>` cookie), and live mode requires a separate `--allow-remote-live` / `allowLiveRemotePeers: true` gate
- `functions` for local Functions discovery (HTTP, Callable, Firestore, RTDB, Storage, Identity, Pub/Sub, Scheduler, and Tasks triggers)
- `swapInBuild` for deliberate sandbox builds
- `ai` for scripted, OpenAI-compatible, or production-pass-through AI Logic (and `pyric/app-check` when App Check is enforced)
- `pyric/crashlytics` when client Crashlytics telemetry is wired (persisted across checkpoints and SQLite restarts)

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

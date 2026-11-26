# Pyric agent plugin

Drive a local Firebase sandbox from a coding agent with zero manual MCP wiring.

The plugin declares a stdio MCP server that runs `pyric mcp` (`@pyric/cli@latest`).
`pyric mcp` serves the ten-tool product surface (`firestore`, `database`,
`storage`, `auth`, `messaging`, `functions`, `rules`, `sandbox`, `assurance`,
`ai_logic`), where each call takes `{ method, args }`. It discovers a running
host from the project's `.pyric/serve.json` pointer (never auto-attaching via a
port scan that could belong to another project) and falls back to an in-process
sandbox persisted in `.pyric/state/in-process.json` when no host is running. If
the running host is a browser SharedWorker host (`pyric sandbox --bridge` or
Vite `pyric({ bridge: true })`), `pyric mcp` relays to `http://<addr>:<port>/__pyric/mcp`
(the 47-tool browser-bridge transport surface). There is no fixed port to
configure.

## What it provides

- **`pyric` MCP server** (`.mcp.json`) serves the ten service tools (`sandbox`
  `inspect`, `rules` `lint`/`simulate`/`set`, `firestore`, `database`,
  `storage`, `auth`, `messaging`, `functions`, `assurance`, `ai_logic`), routing
  to the project's Node host, browser bridge, or local in-process sandbox.
- **`pyric` skill** installs `@pyric/cli@latest`, configures the current `pyric`
  Vite plugin, Next.js `withPyric`, or `pyric sandbox` launcher (in-page or
  Node-hosted), handles remote workstation `/__pyric/unlock` pairing when
  configured, and checks `/__pyric/health`.
- **`improve-firebase` skill** audits a Firebase application using Pyric's
  analyzers, sandbox, captured journeys, and `pyric verify`, writes
  self-contained plans, verifies before/after builds, and records evidence
  videos when requested.
- **`pyric-inpage-sandbox` skill** embeds `pyric/*` mirrors directly into
  standalone HTML pages or browser artifacts with no CLI or dev server.
- **`pyric` agent** provides sandbox operating knowledge for common Pyric workflows.

## Install

```bash
npx plugins add davideast/pyric
```

For local development against this checkout:

```bash
npx plugins add ./pyric-plugin
```

## Start Pyric

Use the syntax for your agent:

| Agent | Invoke the skill |
|---|---|
| Codex | `$pyric` |
| Claude Code | `/pyric:pyric` |
| Antigravity CLI | `/pyric` |
| OpenCode | `/pyric` |

The leading `$` or `/` is part of the invocation. Codex uses `$` for skills.
Claude Code uses `/` and namespaces skills installed through a plugin.
Antigravity CLI and OpenCode install `pyric` as a standalone skill and use
`/pyric`.

## How it connects (no manual steps)

1. Start one launcher: `pyric({ hosted: true })` / `pyric sandbox --hosted` for
   the Node host (recommended when you want zero browser-tab requirement and
   SQLite persistence), `pyric({ bridge: true })` / `pyric sandbox --bridge` for
   the browser SharedWorker sandbox, or no host at all to let `pyric mcp` use
   its persisted in-process sandbox in `.pyric/state/in-process.json`.
2. Running hosts write `.pyric/serve.json` with the bound port and session
   metadata. `pyric mcp` reads that pointer and routes calls automatically.
3. Claude Code auto-reconnects if `pyric sandbox` restarts.

Only the browser SharedWorker mode (`bridge: true` / `--bridge`) requires an
open app tab so the in-page sandbox stays connected; Node-hosted mode
(`hosted: true` / `--hosted`) and `pyric mcp`'s in-process fallback work with no
browser page open.

## Status

Pre-release.

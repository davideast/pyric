# Pyric agent plugin

Drive a local Firebase sandbox from a coding agent with zero manual MCP wiring.

`pyric dev --bridge` exposes an MCP endpoint, but at a runtime port
(`http://localhost:<PORT>/__pyric/mcp`) that a static `.mcp.json` can't name.
The agent plugin bridges that with a **stdio MCP proxy**: it declares a stdio
server that runs `pyric mcp`, which discovers the live serve (from the
`.pyric/serve.json` pointer serve writes, else a port scan) and relays the
protocol. There is no fixed port to configure.

## What it provides

- **`pyric` MCP server** (`.mcp.json`) — auto-connects to the running serve
  via the stdio proxy. Gives the agent the sandbox tools (data plane, rules
  lint/simulate, `pyric_sandbox_inspect`).
- **`pyric` skill** — installs `@pyric/cli@latest`, configures the
  current `pyric` Vite plugin, starts one bridge, and opens the app so the
  in-page sandbox connects.
- **`pyric` agent** — sandbox operating knowledge for common Pyric workflows.

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

1. `pyric` configures the current `@pyric/cli` Vite plugin or runs the
   project-local `pyric dev --bridge`. The dev server writes
   `.pyric/serve.json` with the bound port.
2. The plugin's stdio server (`pyric mcp`) reads that pointer and relays
   stdio ↔ `http://<addr>:<port>/__pyric/mcp`.
3. Claude Code auto-reconnects if `pyric dev` restarts.

Requirement the plugin can't remove: the served **page must be open** (the
sandbox lives in it). The start skill opens it; if data tools do nothing,
re-open the page.

## Status

Pre-release.

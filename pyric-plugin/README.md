# pyric — Claude Code plugin

Drive a local Firebase sandbox from Claude Code with zero MCP wiring.

`pyric dev --bridge` exposes an MCP endpoint, but at a runtime port
(`http://localhost:<PORT>/__pyric/mcp`) that a static `.mcp.json` can't name.
This plugin bridges that with a **stdio MCP proxy**: it declares a stdio
server that runs `pyric mcp-proxy`, which discovers the live serve (from the
`.pyric/serve.json` pointer serve writes, else a port scan) and relays the
protocol. No `claude mcp add`, no fixed port.

## What it provides

- **`pyric` MCP server** (`.mcp.json`) — auto-connects to the running serve
  via the stdio proxy. Gives the agent the sandbox tools (data plane, rules
  lint/simulate, `pyric_sandbox_inspect`).
- **`/pyric:pyric-start` skill** — scaffolds (if needed), starts
  `pyric dev --bridge --persist`, and opens the app so the in-page sandbox
  connects.
- **`pyric` agent** — sandbox operating knowledge for common Pyric workflows.

## Install

```bash
claude plugin install https://github.com/davideast/pyric   # path: pyric-plugin/
# or, for local dev against this checkout:
claude --plugin-dir ./pyric-plugin
```

`pyric` must be available on the project's PATH (the `pyric init` web
template adds `@pyric/cli` as a devDep, so `npx pyric …` resolves it).

## How it connects (no manual steps)

1. `/pyric:pyric-start` runs `pyric dev --bridge` → the dev server writes
   `.pyric/serve.json` with the bound port.
2. The plugin's stdio proxy (`pyric mcp-proxy`) reads that pointer and relays
   stdio ↔ `http://<addr>:<port>/__pyric/mcp`.
3. Claude Code auto-reconnects if `pyric dev` restarts.

Requirement the plugin can't remove: the served **page must be open** (the
sandbox lives in it). The start skill opens it; if data tools do nothing,
re-open the page.

## Status

Pre-release. The MCP proxy + start skill are functional and tested in
`packages/cli`.

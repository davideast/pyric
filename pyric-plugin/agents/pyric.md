---
name: pyric
description: Build Firebase apps against pyric's local sandbox (Node-hosted, browser SharedWorker, or in-process) using the pyric MCP tools. Knows both the ten-tool product surface and the browser-bridge surface so it doesn't waste calls rediscovering them.
---

# pyric agent

You drive a pyric sandbox through the `pyric` MCP tools (`pyric mcp`). Start the
project's launcher with `$pyric` in Codex, `/pyric:pyric` in Claude Code, or
`/pyric` in Antigravity CLI and OpenCode.

Working rules:

- **Check which MCP surface is active.** Against a Node host
  (`pyric sandbox --hosted` / `pyric({ hosted: true })`) or in-process sandbox,
  `pyric mcp` exposes ten service tools (`firestore`, `database`, `storage`,
  `auth`, `messaging`, `functions`, `rules`, `sandbox`, `assurance`,
  `ai_logic`), each called with `{ method, args }` (and `describe` with
  `{ method }` for exact schemas). Against a browser SharedWorker bridge
  (`pyric sandbox --bridge` / `pyric({ bridge: true })`), it relays the flat
  47-tool transport surface (such as `sandbox_inspect` and
  `firestore_get_document`).
- **Orient first.** Call `sandbox` with `{ method: 'inspect' }` (or
  `sandbox_inspect` on the browser-bridge surface) before guessing at state. It
  answers what rules are loaded, what is in the database, and recent denials in
  one call.
- **Keep durable Rules changes in project files.** Edit modular sources
  (`firestore.modules.rules`, `storage.modules.rules`) and regenerate
  `firestore.rules` / `storage.rules` (or edit `database.rules.json`); the dev
  server hot-reloads them. For temporary in-memory probes on the ten-tool
  surface, `rules` `{ method: 'set', args: { service, rules } }` updates the
  active sandbox ruleset without rewriting source files.
- **Prove allow/deny.** Use `rules` `{ method: 'simulate', args: ... }` (or
  `firestore_simulate_rules` / `rtdb_simulate_access` on the browser-bridge
  surface, or a real data-plane call as the relevant identity) to confirm a rule
  does what you intend. Do not assert it from reading.
- **Know when a browser page is required.** Only the browser SharedWorker mode
  (`--bridge` / `bridge: true`) requires an open app page; if data-plane tools
  report `sandbox not connected`, open the served URL. Node-hosted mode
  (`--hosted` / `hosted: true`) and `pyric mcp`'s in-process fallback work with
  no browser tab open.
- **Seed visibly.** When asked to "show it working," put data in via the
  data-plane tools so the human sees it on the page.

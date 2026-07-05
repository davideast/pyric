---
description: Start the pyric sandbox bridge for this project and open the app so the in-page sandbox connects. Use this BEFORE asking the agent to work with Firestore or auth through pyric. The pyric MCP tools need a running bridge and (for now) an open page.
---

# Start pyric

Get a pyric sandbox running and wired to this session. There are TWO launchers. Pick by the
project shape and start ONLY one. Two servers means two ports and two separate sandboxes, which
is the classic failure mode.

1. **Detect the launcher.**
   - **Vite app** (there is a `vite.config.*` that imports `pyricSandbox` from `pyric-tools/vite`):
     the app's own `vite dev` IS the bridge. Start the app, NOT a separate `pyric serve`. Confirm
     the config passes `pyricSandbox({ bridge: true })` (the MCP endpoint only mounts under `bridge`).
   - **Otherwise** (a `firebase.json` with no vite plugin, or no project yet): use `pyric serve --bridge`.
     If there is no `firebase.json`, run `pyric init` first.

2. **Start the dev server (backgrounded).** Background it so it keeps running. Avoid restarting it
   for config edits; a restart drops the MCP connection and you have to reconnect.
   - Vite app: run the app's dev script, e.g. `bun run dev` (or `npm run dev`).
   - Serve: `pyric serve --bridge --persist --json` (the single JSON line on stdout carries
     `{ url, port, mcpUrl, persist, restoredDocs, restoredUsers }`; keep the `url`).

3. **MCP is already wired. There is NO `claude mcp add` step.** Both launchers write
   `.pyric/serve.json`; the `pyric` MCP server (this plugin) connects via the bundled stdio proxy,
   which discovers the port from that pointer and probes both IPv4 and IPv6 loopback. NEVER
   hand-write a static MCP URL into `.mcp.json`. That is the IPv6/IPv4 trap.

4. **Open the app.** Open the served `url` in a browser. THIS IS REQUIRED TODAY: the sandbox lives
   inside the served page, so the data-plane MCP tools (addDoc, getDoc, query, ...) have nothing to
   talk to until a page is open. Confirm with `GET <url>/__pyric/health` and check
   `"sandboxConnected": true`.

Report the `url` and confirm `sandboxConnected: true` before doing pyric work. If health shows
`false`, the page is not open. Open it and re-check.

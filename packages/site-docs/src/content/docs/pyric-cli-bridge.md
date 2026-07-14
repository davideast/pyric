---
title: "@pyric/cli/bridge"
group: "@pyric/cli"
section: "Bridge"
order: 9012
---
# `@pyric/cli/bridge`

Bridge between an external MCP client (Claude Code, Cursor) and a browser-resident pyric sandbox.

Most users never import this directly. They use the `pyric` CLI (`pyric bridge`
or `pyric dev --bridge`). This module is the implementation underneath.

## What this does

Pyric's headline value is that an AI agent can see and act on the **same browser context** the developer sees: the in-page sandbox, its state, its rules, its event log. External MCP clients (Claude Code, Cursor) run in a terminal, not a browser tab. This bridge connects the two:
```
external MCP client ──HTTP MCP──► pyric bridge (Node) ◄──WebSocket── browser tab (sandbox)
```
The bridge process exposes:

- `POST /mcp`: MCP-over-HTTP using `@modelcontextprotocol/sdk`.
- `GET /sandbox` (WebSocket Upgrade): the browser tab connects here.
- `GET /health`: diagnostic endpoint returning `{ mode, sandboxConnected, ... }`.

Bound to `127.0.0.1` only. The CLI starts the bridge in **sandbox** mode: data-plane
tool calls forward to the connected browser. Control-plane / production Firebase
operations are not registered.

## Two entry points, one package

Conditional exports route to the right bundle based on runtime:
```jsonc
{
  "exports": {
    "./bridge": {
      "node":    { "import": "./dist/bridge/server.js" },
      "browser": { "import": "./dist/bridge/client.js" }
    }
  }
}
```
- **Node** (`import { startServer } from '@pyric/cli/bridge'`): gets `createBridge`, `startServer`. (The Vite integration is `pyricSandbox({ bridge })` in `@pyric/cli/vite`.)
- **Browser**: gets `connectBridge`.

The wire format (shared types) lives in `protocol.ts` and is referenced from both bundles.

## CLI
```bash
pyric bridge                          # sandbox bridge on 127.0.0.1:5174
pyric bridge --port 6000 --project demo
pyric dev --bridge                    # mount MCP on the dev-server origin
```
## Programmatic use
```ts
import { startServer } from '@pyric/cli/bridge';

const handle = await startServer({ mode: 'sandbox', port: 5174 });
// later
await handle.stop();
```
For Vite users, the bridge is folded into the `pyricSandbox` plugin: one plugin
does the `firebase/*` → sandbox swap **and** the bridge:
```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { pyricSandbox } from '@pyric/cli/vite';

export default defineConfig({ plugins: [pyricSandbox({ bridge: true })] });
```
The plugin mounts the bridge on Vite's own dev server at `/__pyric/mcp`,
`/__pyric/health`, and `/__pyric/sandbox` (WS), so the bridge shares Vite's port
instead of running as a sidecar. The agent's tool-calls route through the
SharedWorker, so the app, Pyric Studio, and the agent all share one sandbox. See
[Use the Vite plugin](../pyric-cli-how-to-use-the-vite-plugin/#drive-the-sandbox-from-an-agent-bridge).

## Browser side
```ts
import { initializeSandbox } from 'pyric/sandbox';
import { connectBridge } from '@pyric/cli/bridge';

const sandbox = initializeSandbox();
// ... app uses sandbox normally ...

// Connect to the running bridge (no-op in production builds).
if (import.meta.env.DEV) {
  connectBridge(sandbox);
}
```
## See also

- Agent tool inventory
- [Wire Claude Code](../pyric-cli-tutorials-wire-claude-code/)

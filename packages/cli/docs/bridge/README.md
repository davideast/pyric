# `@pyric/cli/bridge`

Bridge between an external MCP client (Claude Code, Cursor) and a browser-resident pyric sandbox.

Most users never install this directly. They install [`pyric`](../../../pyric/), which surfaces the bridge through the `pyric` CLI. This package is the implementation underneath.

## What this does

Pyric's headline value is that an AI agent can see and act on the **same browser context** the developer sees: the in-page sandbox, its state, its rules, its event log. External MCP clients (Claude Code, Cursor) run in a terminal, not a browser tab. This bridge connects the two:

```
external MCP client ──HTTP MCP──► pyric bridge (Node) ◄──WebSocket── browser tab (sandbox)
```

The bridge process exposes:

- `POST /mcp`: MCP-over-HTTP using `@modelcontextprotocol/sdk`.
- `GET /sandbox` (WebSocket Upgrade): the browser tab connects here.
- `GET /health`: diagnostic endpoint returning `{ mode, sandboxConnected, ... }`.

Bound to `127.0.0.1` only.

## Two entry points, one package

Conditional exports route to the right bundle based on runtime:

```jsonc
{
  "exports": {
    ".": {
      "node":    { "import": "./dist/server.js" },
      "browser": { "import": "./dist/client.js" }
    }
  }
}
```

- **Node** (`import { ... } from '@pyric/cli/bridge'`): gets `createBridge`, `startServer`. (The Vite integration is `pyricSandbox({ bridge })` in `@pyric/cli/vite`.)
- **Browser**: gets `connectBridge`.

The wire format (shared types) lives in `protocol.ts` and is referenced from both bundles.

## Mode

The bridge is sandbox-only.

```bash
pyric bridge
```

- Data-plane tool calls forward to the connected browser.
- Sandbox-management tools such as undo, redo, and event history are available.
- Production project administration is not registered.

The mode is visible in `/health` and in every tool result's metadata so the MCP client (and the human reading the conversation) can always see which target was hit.

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
[Use the Vite plugin](../how-to/use-the-vite-plugin.md#drive-the-sandbox-from-an-agent-bridge).

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

- [`pyric`](../../../pyric/): the parent package that ships the `pyric` CLI.
- [`@pyric/cli` docs](../README.md): CLI and library entry points.

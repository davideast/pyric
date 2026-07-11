---
title: "Wire Claude Code to your pyric sandbox (manual MCP wiring)"
navLabel: "Wire Claude Code"
group: "pyric-tools"
section: "Tutorials"
order: 38
---
# Wire Claude Code to your pyric sandbox (manual MCP wiring)

> **Most users want the plugin instead.** `claude plugin install` +
> `/pyric:pyric-start` does everything below automatically, see
> [getting-started.md](../start-building/). This tutorial is the
> manual path: wiring Claude Code to a bridge yourself, e.g. for a
> sandbox embedded in your own dev server, a custom port layout, or an
> MCP client other than Claude Code.


By the end of this tutorial you will have:

- A running pyric bridge on `127.0.0.1:5174`.
- Your existing Firebase app's in-browser pyric sandbox connected to the bridge.
- Claude Code configured to talk to the bridge via MCP-over-HTTP.
- A successful end-to-end tool call from Claude Code into your browser-resident Firestore sandbox.

Should take ~10 minutes.

## Prerequisites

- An existing Firebase app already retrofitted to use pyric, i.e. you've replaced the relevant `firebase/*` imports with `@pyric/*` adapter SDKs and your app boots against `initializeSandbox()` in dev. (If you haven't done the retrofit yet, do that first: see the per-package READMEs under `packages/*/README.md`.)
- Claude Code installed and working. Verify with `claude --version`.
- Node 22+ and `npm` / `bun`. This tutorial uses `npm` in commands; `bun` works equivalently.

## Step 1: Install pyric

In your app's repo:
```bash
npm install --save-dev pyric
```
This pulls in the bridge implementation (`pyric-tools/bridge`) as a transitive dependency. You don't install it separately: it ships inside `pyric-tools`.

Verify:
```bash
npx pyric --version
```
Expected output: a version string (e.g. `0.0.0`).

## Step 2: Connect your app to the bridge

The bridge waits for a browser tab to register a sandbox over WebSocket. Your app needs to call `connectBridge()` from `pyric-tools/bridge` (browser entry) in dev mode.

**Vite users**: the simplest path. Use the `pyricSandbox` plugin with `bridge: true`. One plugin does the `firebase/*` → sandbox swap **and** the bridge, so you don't even add the `connectBridge` snippet below:
```ts
import { defineConfig } from 'vite';
import { pyricSandbox } from 'pyric-tools/vite';

export default defineConfig({
  plugins: [pyricSandbox({ bridge: true })],
});
```
The plugin attaches the bridge to Vite's own dev server (so it shares Vite's port instead of running as a sidecar) AND wires the browser side automatically via the served init payload. You can skip Step 3 and 4: your app is already wired. `bridge: true` routes the agent's tool-calls through the **SharedWorker**, so the agent, your app, and Pyric Studio all share one sandbox (keep a tab open while the agent works); see [Use the Vite plugin](../pyric-tools-how-to-use-the-vite-plugin/#drive-the-sandbox-from-an-agent-bridge).

**Non-Vite users**: add a small dev-mode snippet wherever your app initializes the sandbox:
```ts
// e.g. src/main.ts or wherever you call initializeSandbox()
import { initializeSandbox } from 'pyric/sandbox';
import { connectBridge } from 'pyric-tools/bridge';

const sandbox = initializeSandbox();

if (import.meta.env.DEV /* or NODE_ENV === 'development' */) {
  connectBridge(sandbox);
}
```
The conditional gate is important: `connectBridge` opens a WebSocket to `127.0.0.1:5174`, which doesn't exist in production. Without the gate, your production build would attempt a failed WebSocket handshake on page load.

## Step 3: Start the bridge (non-Vite users only)

Open a new terminal in your app's directory and run:
```bash
npx pyric bridge
```
Expected output:
```
pyric bridge 0.0.0 — mode: sandbox, project: sandbox
  listening on http://127.0.0.1:5174
  health:  http://127.0.0.1:5174/health
  mcp:     http://127.0.0.1:5174/mcp
  sandbox: ws://127.0.0.1:5174/sandbox
  audit:   /Users/you/.pyric/projects/sandbox/events.ndjson

Waiting for browser tab to connect. Ctrl-C to stop.
```
Leave this terminal running.

> Vite users: skip this step, the bridge already runs as part of `npm run dev`.

## Step 4: Verify the bridge is reachable

In a third terminal:
```bash
curl http://127.0.0.1:5174/health
```
Expected:
```json
{
  "status": "ok",
  "mode": "sandbox",
  "project": "sandbox",
  "sandboxConnected": false,
  "version": "0.0.0",
  "startedAt": "2026-05-24T..."
}
```
The `sandboxConnected: false` is correct: no browser tab has registered yet. Vite users with the plugin: the URL is your Vite dev server's, with `/__pyric/health` as the path (e.g. `http://localhost:5173/__pyric/health`).

## Step 5: Open your app in a browser

Run your usual dev command (`npm run dev`, `bun run dev`, …) and open the app in a browser. Your `connectBridge(sandbox)` call (Step 2) will run and open the WebSocket.

Verify with another curl:
```bash
curl http://127.0.0.1:5174/health
```
Expected: `"sandboxConnected": true`.

If it's still `false`, check the browser devtools console for WebSocket errors. The most common cause is the dev-mode gate (Step 2 conditional) being false. Add a `console.log('pyric: connecting')` line above `connectBridge(...)` to confirm it runs.

## Step 6: Register the bridge with Claude Code
```bash
claude mcp add pyric --transport http \
  --url http://127.0.0.1:5174/mcp \
  --scope project
```
`--scope project` writes the MCP config to `.mcp.json` in the current directory (checked into git, shared with your team). Other scopes:

- `--scope user`: `~/.claude.json`, personal only.
- `--scope local`: this machine, this project, not checked in.

Verify the registration:
```bash
claude mcp list
```
Expected: `pyric` shows in the list with `transport: http` and the URL.

## Step 7: Confirm Claude Code sees the bridge

Inside Claude Code (in your terminal or IDE), run:
```
/mcp
```
Expected: `pyric` appears as a configured MCP server, status `connected`. If status shows `disconnected`, check the bridge process is still running (Step 3 terminal) and the URL matches.

If Claude Code was already running when you ran `claude mcp add`, you may need to restart it to pick up new project-scoped MCP config.

## Step 8: Make an end-to-end tool call

Ask Claude Code:

> "Use the pyric MCP to seed my Firestore sandbox with a `users/u1` document containing `{ name: 'Alice' }`, then read it back."

Expected behavior:

1. Claude Code calls `pyric__firestore_simulator_create` and `pyric__firestore_simulator_execute` (the tools are namespaced by the MCP server name `pyric`).
2. The bridge forwards both calls over WebSocket to your browser tab.
3. Your browser's `connectBridge()` dispatches them into `LocalEnvironment`.
4. Results flow back to Claude Code.
5. Claude Code reports success with the seeded + read document.

Open the browser devtools and check the sandbox's state: `users/u1` should be present.

You can also verify via the audit log (sandbox events flow through the bridge's `onToolEvent` hook):
```bash
tail -n 5 ~/.pyric/projects/sandbox/events.ndjson
```
Each line is a JSON object with `tool`, `args`, `result`, `mode`, `timestamp`.

## Step 9: Try a sandbox-management tool

Ask Claude Code:

> "Undo the last write, then redo it."

Expected: two tool calls (`firestore_simulator_undo`, `firestore_simulator_redo`) round-trip through the bridge. The undo restores prior state; redo re-applies.

## Troubleshooting

**`sandboxConnected: false` even after opening the page.** Either `connectBridge()` isn't being called (dev-mode gate or path issue), or the WebSocket can't reach the bridge (firewall, browser security policy on a non-localhost domain, port mismatch). Browser devtools Network tab → WS filter shows the handshake attempt and failure mode.

**Tool call returns `"sandbox not connected"`.** The browser tab disconnected (page closed, crashed, navigated away). Reopen the page; the bridge auto-accepts new connections (last-wins).

**Multiple tabs open against the same app.** Last-wins. The most recently connected tab is the active sandbox; previous tabs are inactive (their `connectBridge` keeps reconnecting and replaces). For v1 this is acceptable; multi-tab is a v1.1 question.

**Port 5174 already in use.** Another `pyric bridge` instance is running, OR another tool. Either kill the other process (`lsof -ti:5174 | xargs kill`) or run with `--port 5180` (and update your Claude Code MCP config to match).

**Prod mode.** This tutorial covered sandbox mode only. Prod mode wires the bridge to real Firebase via the Admin SDK; needs additional setup (`GOOGLE_APPLICATION_CREDENTIALS` or `PYRIC_SA_PATH` env vars). See `pyric bridge --help` for the CLI surface. Prod-mode tool wiring through the CLI is a v1.1 follow-up; for v1 use the programmatic `startServer({ mode: 'prod', prodTools })` API.

## Prod-mode security: terminal confirmation

This part doesn't apply to sandbox mode (where the threat model is "you trust your own dev machine"), but matters as soon as you wire the bridge to a real Firebase project.

**Every write, delete, or deploy tool call in prod mode prompts you in the terminal where `pyric bridge` is running.** The bridge does not execute the call until you press `y`. Reads auto-approve.

The prompt looks like this:
```
─────────────────────────────────────────────────────────
[pyric prod 14:32:08]  ⚠  CONFIRM TOOL CALL
─────────────────────────────────────────────────────────
Project:  my-firebase-project
Tool:     firestore_update_document
Args:     {
            "path": "users/u123",
            "data": { "email": "new@example.com" }
          }
─────────────────────────────────────────────────────────
  [y]   approve this call
  [n]   deny this call                          (default after 45s)
  [a]   approve all `firestore_update_document` for this session
  [D]   DENY everything for the rest of this session
─────────────────────────────────────────────────────────
> _
```
The prompt reads from `/dev/tty` directly (not from inherited stdin), so a malicious local process can't fake your keystroke. This is the **first real defense** the bridge has against same-user attacks (it's the reason there's no Bearer-token gate).

**Why no token?** Bearer tokens on a localhost HTTP endpoint stop browser cross-origin attacks but not anything else: a process running as your user can read the token from your config file, env vars, terminal output, or process memory. The token would have been security theater. Terminal confirmation is what actually works.

**CLI flags to tune the prompt:**

| Flag | Effect |
|---|---|
| `--auto-approve foo,bar` | Tools listed bypass confirmation (lowered to `never`) |
| `--require-confirm foo,bar` | Tools listed always prompt (force `always` even for reads) |
| `--require-confirm-all` | Every tool prompts, including reads (paranoid) |
| `--confirm-timeout 60000` | Override the default 45s timeout |
| `--non-interactive` | Run prod without TTY (CI). Requires `--auto-approve <list>` for every tool you want callable; everything else denies silently. |

The confirmation decision lands in the audit log alongside the tool call:
```jsonc
{
  "tool": "firestore_update_document",
  "args": { /* ... */ },
  "confirmation": {
    "policy": "always",
    "decision": "approved",
    "reason": "user-approved",
    "elapsed_ms": 4187,
    "prompt_shown_at": "..."
  },
  "result": { /* ... */ }
}
```
Even if a confirmation is somehow bypassed (it shouldn't be), the audit log shows exactly what was approved and when.

## Next steps

- Read [the bridge README](../pyric-tools-bridge/) for the bridge architecture.
- Read design rationale for the v1 design decisions.
- The bridge audit log at `~/.pyric/projects/<project>/events.ndjson` is the durable record of every tool call: review it after agent sessions.

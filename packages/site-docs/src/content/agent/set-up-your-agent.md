---
title: "Connect an agent to the sandbox"
navLabel: "Connect an agent"
group: "Work with an agent"
section: ""
order: 10
description: "Connect Claude Code, Cursor, Codex, Antigravity CLI, OpenCode, or any MCP client to your backend in minutes."
---

# Connect an agent to the sandbox

One connection and your agent has the whole backend as tools. It can read and write documents as any user, run queries, lint and simulate rules, seed data, and inspect everything, against the same sandbox your app and Studio see. Nothing it does leaves your machine.

## Install the plugin

Install the Pyric plugin from any terminal:

```bash
npx plugins add davideast/pyric
```

Antigravity CLI and OpenCode use the standalone skill installer:

```bash
# Antigravity CLI
npx skills add https://github.com/davideast/pyric/tree/main/pyric-plugin/skills/pyric --agent antigravity-cli

# OpenCode
npx skills add https://github.com/davideast/pyric/tree/main/pyric-plugin/skills/pyric --agent opencode
```

Then invoke the skill:

| Agent | Enter |
|---|---|
| Codex | `$pyric` |
| Claude Code | `/pyric:pyric` |
| Antigravity CLI | `/pyric` |
| OpenCode | `/pyric` |

The leading `$` or `/` is part of the command. The skill scaffolds a project if needed, selects the correct launcher, starts the sandbox (Node-hosted or browser bridge), pairs remote browsers when configured, and checks that the sandbox is connected. To expose the backend as tools, configure the client below.

When using the default browser SharedWorker bridge (`pyric sandbox --bridge` or `pyric({ bridge: true })`), keep the app open in a browser tab while the agent works; if data tools report `sandbox not connected`, open the page and try again. In Node-hosted mode (`pyric sandbox --hosted` or `pyric({ hosted: true })`), or when `pyric mcp` runs its in-process fallback (`.pyric/state/in-process.json`), no browser tab is required.

## Configure a client manually

`pyric mcp` serves the ten-tool product surface (`firestore`, `database`, `storage`, `auth`, `messaging`, `functions`, `rules`, `sandbox`, `assurance`, `ai_logic`, called with `{ method, args }`), routing calls to the running Node host named in `.pyric/serve.json` or to its persisted in-process sandbox when no host is running. Against a browser SharedWorker host (`pyric sandbox --bridge`), `pyric mcp` relays to `/__pyric/mcp` (the flat 47-tool browser-bridge transport surface).

Start a host (either Node-hosted or browser bridge):

```bash
pyric sandbox --hosted
# or for the in-page SharedWorker sandbox:
pyric sandbox --bridge
```

### Claude Code

Register the stdio server:

```bash
claude mcp add pyric -- npx --package @pyric/cli pyric mcp
```
`pyric mcp` attaches to a running `pyric sandbox --bridge` by reading the `.pyric/serve.json` pointer the sandbox server writes. If nothing is running, it hosts an in-process sandbox of its own and persists it to `.pyric/state/in-process.json`. If you pin the port, you can point Claude Code at the HTTP endpoint directly:
```bash
pyric sandbox --bridge --port 5173
claude mcp add pyric --transport http --url http://localhost:5173/__pyric/mcp
```
First thing to ask: "Inspect the sandbox." One tool call comes back with the current rules, a lint summary, a document census, and recent denials.

### Cursor

Cursor reads MCP servers from `.cursor/mcp.json`. Use the stdio server so the port is never your problem:
```json
{
  "mcpServers": {
    "pyric": { "command": "npx", "args": ["--package", "@pyric/cli", "pyric", "mcp"] }
  }
}
```
Start `pyric sandbox --bridge`, open the app, then ask Cursor to inspect the sandbox.

### Codex

Same shape, Codex config. In `~/.codex/config.toml`:
```toml
[mcp_servers.pyric]
command = "npx"
args = ["--package", "@pyric/cli", "pyric", "mcp"]
```
Start `pyric sandbox --bridge`, open the app, and ask it to inspect the sandbox.

### Antigravity CLI

Antigravity CLI reads workspace MCP servers from `.agents/mcp_config.json`:

```json
{
  "mcpServers": {
    "pyric": {
      "command": "npx",
      "args": ["--package", "@pyric/cli", "pyric", "mcp"]
    }
  }
}
```

Start `pyric sandbox --bridge`, open the app, then use `/mcp` in Antigravity CLI to confirm that `pyric` is connected. Ask it to inspect the sandbox.

### OpenCode

Add Pyric to the workspace `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "pyric": {
      "type": "local",
      "command": ["npx", "--package", "@pyric/cli", "pyric", "mcp"],
      "enabled": true
    }
  }
}
```

Start `pyric sandbox --bridge`, open the app, then run `opencode mcp list` to confirm that `pyric` is connected. Ask it to inspect the sandbox.

### Any MCP client

The generic recipe is two options, and every client above is one of them applied:

- **stdio**: run `npx --package @pyric/cli pyric mcp` as the server command (or bare `pyric mcp` from a project-local install). It finds the running dev server, or hosts an in-process sandbox when there is none.
- **HTTP**: point the client at `http://localhost:<port>/__pyric/mcp` on a running `pyric sandbox --bridge`.

Whatever your client's config file looks like, one of those two lines is the whole setup. Then ask it to inspect the sandbox and read what comes back.

## Connect through the Vite plugin

One option in `vite.config.ts` makes your own `vite dev` the bridge:
```ts
plugins: [pyric({ bridge: true })],
```
Do not start `pyric sandbox` next to it. Two servers mean two sandboxes, and your agent may connect to the wrong one. The endpoints are the same. Vite serves `/__pyric/mcp` on its port, and `npx --package @pyric/cli pyric mcp` finds it the same way.

## Where to go next

No project yet? [Start building](../get-started/start-building.md) gets you a backend in one command first. Then give the connection a real task in [Work with an agent](./work-with-an-agent.md).

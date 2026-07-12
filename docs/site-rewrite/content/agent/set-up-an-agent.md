---
title: Connect an agent to the sandbox
navLabel: Set up an agent
outcome: Connect Claude Code, Cursor, Codex, or any MCP client to your backend in minutes.
status: draft
---

# Connect an agent to the sandbox

One connection and your agent has the whole backend as tools. It can read and write documents as any user, run queries, lint and simulate rules, seed data, and inspect everything, against the same sandbox your app and Studio see. Nothing it does leaves your machine.

The seam is one endpoint. `pyric dev --bridge` mounts an MCP server on your dev server at `/__pyric/mcp`, and every client below connects to it, directly or through a small stdio proxy that finds it for you.

```bash
pyric dev --bridge
```

One requirement to know up front: the sandbox lives inside the served page, so keep the app open in a browser tab while the agent works. If data tools return nothing, the page is not open. Open it and try again.

## Claude Code

The plugin does the whole thing, including finding the port.

```bash
claude plugin install https://github.com/davideast/pyric   # path: pyric-plugin/
```

Then, inside Claude Code, run `/pyric:pyric-start`. It scaffolds a project if you need one, starts `pyric dev --bridge --persist`, opens the app so the sandbox connects, and wires MCP through a stdio proxy that discovers the running server on its own. There is no `claude mcp add` step and no port to configure.

Prefer manual wiring? Register the stdio server:

```bash
claude mcp add pyric -- npx pyric-tools mcp
```

`pyric mcp` attaches to a running `pyric dev --bridge` by reading the `.pyric/serve.json` pointer the dev server writes. If nothing is running, it hosts a headless sandbox of its own and persists it to `.pyric/state/headless.json`. Or, if you pin the port, point Claude Code at the HTTP endpoint directly:

```bash
pyric dev --bridge --port 5173
claude mcp add pyric --transport http --url http://localhost:5173/__pyric/mcp
```

First thing to ask: "Inspect the sandbox." One tool call comes back with the current rules, a lint summary, a document census, and recent denials.

## Cursor

Cursor reads MCP servers from `.cursor/mcp.json`. Use the stdio server so the port is never your problem:

```json
{
  "mcpServers": {
    "pyric": { "command": "npx", "args": ["pyric-tools", "mcp"] }
  }
}
```

Start `pyric dev --bridge`, open the app, then ask Cursor to inspect the sandbox.

## Codex

Same shape, Codex config. In `~/.codex/config.toml`:

```toml
[mcp_servers.pyric]
command = "npx"
args = ["pyric-tools", "mcp"]
```

Start `pyric dev --bridge`, open the app, and ask it to inspect the sandbox.

## Any MCP client

The generic recipe is two options, and every client above is one of them applied:

- **stdio**: run `npx pyric-tools mcp` as the server command (or bare `pyric mcp` if you installed the CLI globally). It finds the running dev server, or hosts a headless sandbox when there is none.
- **HTTP**: point the client at `http://localhost:<port>/__pyric/mcp` on a running `pyric dev --bridge`.

Whatever your client's config file looks like, one of those two lines is the whole setup. Then ask it to inspect the sandbox and read what comes back.

## Bridge through the Vite plugin

One option in `vite.config.ts` makes your own `vite dev` the bridge:

```ts
plugins: [pyricSandbox({ bridge: true })],
```

Do not start a second `pyric dev` next to it. Two servers means two sandboxes, and your agent will be working in the one you are not looking at. The endpoints are the same, `/__pyric/mcp` on Vite's port, and `npx pyric-tools mcp` finds it the same way.

## Where to go next

No project yet? [Start building](../get-started/start-building.md) gets you a backend in one command first. Then see what the connection buys you in [the MCP tools an agent gets](./agent-mcp-tools.md).

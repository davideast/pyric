---
title: "CLI reference"
navLabel: "CLI"
group: "API reference"
section: "@pyric/cli"
order: 100000
description: "Syntax, flags, configuration, and command selection for pyric sandbox."
---

# CLI reference

## Syntax

```text
pyric sandbox [flags] [--] [command...]
```

Put every Pyric flag before the first child command token. After the first child command token, every remaining argument belongs to the child. A bare `--` makes the boundary explicit.

```bash
pyric sandbox --bridge -- npm run dev -- --port 3000
```

## Command selection

Pyric selects what to run in this order:

1. `--no-run` skips an explicit or configured child application command.
2. An explicit `[command...]` runs as the child process.
3. `--json` with no explicit command skips the configured child application command.
4. `command` in `pyric.json` runs as the child process.
5. With no command, Pyric starts the sandbox host without a child application command.

A Functions source declared in `firebase.json` can still run when the child application command is skipped.

The child receives `PYRIC_SANDBOX` and a `NODE_OPTIONS` import for `@pyric/cli/register`. This routes supported `firebase/*` and `firebase-admin/*` imports to the local sandbox.

## Flags

| Flag | Meaning |
|---|---|
| `--port <number>` | Set the first port to try. The default is `3473`. Pyric scans forward if it is taken. |
| `--host <host>` | Set the bind host. The default is `localhost`. |
| `--bridge` | Mount MCP at `/__pyric/mcp`. |
| `--ui` | Open Studio instead of the served application. Studio is served by default. |
| `--no-ui` | Do not serve Studio, docs, workspace, or project routes. |
| `--no-open` | Do not open a browser. Browser opening is also disabled for `--json`, CI, and non-interactive output. |
| `--seed <file>` | Load a JSON document map or a Pyric state file. |
| `--persist` | Save documents and auth users to `.pyric/state/state.json`. |
| `--fresh` | With `--persist`, discard existing saved state before startup. |
| `--no-watch` | Disable Firestore Rules hot reload. |
| `--no-capture` | Do not write `.pyric/last-session.json`. |
| `--no-cache` | Rebuild browser SDK bundles. |
| `--no-run` | Do not run an explicit or configured child command. |
| `--json` | Print one machine-readable readiness line. A configured command is skipped unless it is also supplied explicitly. |
| `--project <id>` | Set the project label. |
| `--permissive` | Allow unauthenticated RTDB access when no RTDB rules file exists. Use only for local prototypes. |
| `--allowed-host <host>` | Add allowed Host headers. Use commas for multiple hosts. |
| `--only hosting` | Accepted for Firebase CLI compatibility. Hosting is the only supported value. |

## Project configuration

Create `pyric.json` in the project root to define defaults:

```json
{
  "command": "next dev",
  "port": 3473,
  "project": "demo-app",
  "rules": {
    "firestore": "firestore.rules",
    "database": "database.rules.json",
    "storage": "storage.rules"
  }
}
```

`rules` can also be a string when only one rules file is needed.

Command-line values override `pyric.json`. `--project` overrides `PYRIC_PROJECT`, and `PYRIC_PROJECT` overrides the configured project.

## Environment variables

`PYRIC_GUARD` selects what the network guard does when a Pyric-launched process opens a connection to a live Google or Firebase endpoint. A sandboxed app routes all of its Firebase traffic to the local `/__pyric/*` namespace, so such a connection means that process escaped the sandbox and is reading or writing production data. The value is `warn` (the default: report the connection on stderr, let it through), `block` (report it and fail the request), or `off` (install no hooks at all and print one notice saying so). The GCE metadata server is refused under `warn` and `block` in every case, because a development process has no legitimate reason to fetch credentials from it.

`PYRIC_GUARD_ALLOW` permits specific hosts that the guard would otherwise flag. It takes a comma-separated or whitespace-separated list of hostnames or URLs, matched on label boundaries, so `cloudfunctions.net` also permits `us-central1-demo.cloudfunctions.net`. Set it when a project deliberately calls a Google endpoint that Pyric does not mirror, such as a Vertex AI base URL. An allowed host is still reported once. The GCE metadata server cannot be allowed.

`PYRIC_BEACON_TOKEN` is set by `pyric sandbox` on every child it starts. A child that has loaded `@pyric/cli/register` presents it when it reports that interception is installed, and the server rejects a report without it. Export it alongside `PYRIC_SANDBOX` when you start a process yourself, using the block `pyric sandbox` prints for that purpose.

## Output and readiness

With `--json`, stdout contains one JSON object with the URL, port, MCP URL, rules hash, persistence state, and restored item counts. The normal banner is written to stderr.

Check `GET <url>/__pyric/init.json`. A `200` response means the server is ready and includes the current rules hash.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Invalid command or options. |
| `2` | Runtime failure. |

## Examples

Start the sandbox host and serve the configured hosting directory:

```bash
pyric sandbox
```

Run a Next.js development server inside the sandbox:

```bash
pyric sandbox -- next dev
```

Start a machine-readable MCP bridge without a child command:

```bash
pyric sandbox --bridge --json
```

Run an explicit command while keeping machine-readable output:

```bash
pyric sandbox --bridge --json -- npm run dev
```

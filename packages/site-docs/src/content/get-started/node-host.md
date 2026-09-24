---
title: "Node host mode"
navLabel: "Node host"
group: "Get started"
section: ""
order: 25
description: "Run Pyric's Firebase sandbox in a single shared, durable Node process."
---

# Node host mode

Node host mode runs Pyric's Firebase sandbox in a single, durable Node process rather than in the browser's SharedWorker. Every browser tab, child process, Studio instance, service CLI, and MCP tool shares one consistent state backed by SQLite.

## SharedWorker vs. Node host

| Feature | SharedWorker sandbox (default) | Node host mode |
| --- | --- | --- |
| **Execution** | SharedWorker per browser profile | Dedicated Node process |
| **Scope** | Tabs within the same browser profile | All browsers, Studio, child processes, CLI, and MCP tools |
| **Persistence** | Browser storage or `.pyric/state/state.json` (opt-in) | `.pyric/state/hosted/state.sqlite` (always durable) |
| **Readiness** | `sandboxConnected: true` once a browser tab opens | `sandboxConnected: true` immediately on startup |
| **Concurrency** | One per browser profile | Single writer per project directory (lock-enforced) |
| **Admin child processes** | Requires browser tab to connect first | Connects directly to Node host |

Choose **Node host mode** when you want:
- Multiple browser profiles or devices (e.g. Chrome, Safari, mobile simulators) sharing the same state.
- Backend child processes (`firebase-admin`) reading and writing state without needing a browser page open.
- Immediate durability across server restarts.
- Full parity between Studio, agent MCP tools, and runtime clients.

Stay on **SharedWorker** if you require Bun, the Pyric standalone binary, or isolated sandboxes per browser profile.

---

## How to enable Node host mode

### CLI: `pyric sandbox`

Pass `--hosted` to `pyric sandbox`:

```bash
# Run host-only
pyric sandbox --hosted

# Run host and execute your application command with automatic interception
pyric sandbox --hosted -- npm run dev
```

When running `-- <command>`, Pyric automatically activates `@pyric/cli/register` in the child environment via `NODE_OPTIONS`. Unchanged `firebase-admin` and `firebase` imports in your child command resolve directly to the local sandbox.

### Vite plugin: `pyric({ hosted: true })`

In `vite.config.ts`, set `hosted: true`:

```ts
import { defineConfig } from 'vite';
import { pyric } from '@pyric/cli/vite';

export default defineConfig({
  plugins: [
    pyric({
      hosted: true,
    }),
  ],
});
```

When `hosted: true` is set, Vite starts the Node host internally, mounting both your application and the sandbox routes onto Vite's HTTP server.

---

## System requirements

- **Node.js**: Version **22.15** or later is required for native `node:sqlite` support.
- **Experimental Warning**: Node emits `ExperimentalWarning: SQLite is an experimental feature`. This warning is expected and normal.
- **Unsupported runtimes**: Node host mode requires Node's built-in SQLite engine. It is not currently supported under Bun or in the standalone single-executable binary.

---

## Persistence, locks, and recovery

### State location

All data for the host is stored at:
```
.pyric/state/hosted/state.sqlite
```
This file contains your Firestore documents, Auth accounts, and Storage objects. Add `.pyric/` to your `.gitignore`.

### Single-host project lock

Only one hosted sandbox can own a project directory at a time. If a second process attempts to start a hosted sandbox in the same project, startup is refused:
```
A hosted sandbox already owns this project's hosted state. Attach to its bridge or stop it before starting another hosted sandbox.
```

An in-process MCP server (`pyric mcp --in-process`) uses a separate lock (`in-process.lock`) and is admitted alongside the running host.

### Starting clean: `--fresh`

To archive existing state and start with an empty database, pass `--fresh` (or `fresh: true` in Vite):

```bash
pyric sandbox --hosted --fresh -- npm run dev
```

Pyric moves the existing database directory to `.pyric/state/hosted.archive-<timestamp>-<uuid>` and opens a brand-new database.

### Recovery: `pyric sandbox salvage`

If the database is damaged by an abrupt OS shutdown or corrupted filesystem:

```bash
pyric sandbox salvage --source .pyric/state/hosted --out .pyric/state/recovered
```

`salvage` copies and inspects readable records without altering the original database, producing an offline report.

---

## Ports and topology

### With `pyric sandbox --hosted -- <child>`
- Your application runs on its own port (e.g., Next.js on 3000).
- The Pyric host runs on port **3473** by default (or the next free port in the scan window). The active host port is written to `.pyric/serve.json`.
- **Pyric Studio**: Accessible at `http://localhost:<host-port>/__pyric/ui/studio`.
- **Docs**: Available at `http://localhost:<host-port>/__pyric/ui/docs/`.
- **MCP Endpoint**: Located at `http://localhost:<host-port>/__pyric/mcp`.

### With the Vite plugin
- Your application, Pyric Studio, docs, and MCP endpoints all share Vite's single port (default 5173).
- Studio is served at `/__pyric/ui/studio`.

---

## Interacting with the host

### Agent MCP tools (`pyric mcp`)
Agent MCP servers automatically discover and follow the active Node host via `.pyric/serve.json`. If a host starts while an MCP session is open, tool calls seamlessly route to the host (per ADR 0016), prepending an informative notice.

### Service CLI
Inspect and manipulate data directly from the command line:

```bash
# List users on the running host
pyric auth listUsers

# Inspect documents
pyric firestore getDoc --collection users --id alice

# Create user
pyric auth createUser --email dev@example.com --password Secret123!
```

### Backend scripts with `firebase-admin`
Run backend scripts against the host by starting them through Pyric:

```bash
pyric sandbox --hosted -- node seed-data.js
```

The script's `firebase-admin` imports are intercepted and connect to the local sandbox without credentials or network access.

---

## Storage capabilities & limits

- **HTTP byte route**: Storage bytes move over HTTP at `/__pyric/storage/v0/b/<bucket>/o/<path>`, never over the WebSocket. The web SDK, `pyric-admin`, and the Node remote client all use it. Objects can be up to **512 MiB**.
- **Ranges and streams**: A `GET` supports `Range`, so an `<audio>` or `<video>` element streams and seeks an object by its download URL. `pyric-admin` downloads honor `start` and `end`, and `createReadStream` and `createWriteStream` work.
- **Resumable uploads**: An upload is a `PUT` that continues from an offset with `Content-Range`, so `uploadBytesResumable` reports real progress and can pause and resume.

### Storage metadata repair warning

On startup, Pyric validates that stored byte counts match recorded metadata. If a previous run was abruptly halted mid-operation, you may see:
```
  ⓘ [pyric] Repaired Storage metadata that disagreed with the stored bytes
```
This warning indicates that Pyric's automated self-healing synchronized the byte count and metadata in SQLite without dropping your data.

---

## Migrating from SharedWorker

To migrate an existing Pyric project to Node host mode:

1. **Verify Node version**: Ensure `node --version` is 22.15 or later.
2. **Export existing data (optional)**:
   ```bash
   pyric snapshot --out pyric-carryover.json
   ```
3. **Update configuration**:
   - In `vite.config.ts`, change `pyric()` to `pyric({ hosted: true, seed: 'pyric-carryover.json' })`.
   - Or update your start script to: `pyric sandbox --hosted --seed pyric-carryover.json -- <command>`.
4. **Remove legacy flags**: Remove `bridge: true` and `persist: true` (both are default and automatic in hosted mode).
5. **Start your server**: Launch your development command. Data will seed on first boot into `.pyric/state/hosted/state.sqlite`.

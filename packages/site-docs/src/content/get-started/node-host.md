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
- **Download URLs**: `getDownloadURL` from `firebase-admin/storage` returns the host's URL for a file, minting a token into its `firebaseStorageDownloadTokens` metadata when it has none. A token you set yourself, with `file.save(data, { metadata: { metadata: { firebaseStorageDownloadTokens: token } } })` or `file.setMetadata`, grants `/__pyric/storage/v0/b/<bucket>/o/<path>?alt=media&token=<token>` the same way. `file.setMetadata({ metadata: { firebaseStorageDownloadTokens: null } })` revokes the URL, as it does in production.
- **Buckets**: `storage.bucket()` is the bucket your app's `storageBucket` option names, and the page's `getStorage(app)` names it the same way. That bucket is the host's default bucket, so its byte route URLs work under either name. `storage.bucket('<name>')` is a bucket of its own: its objects stay apart from the default bucket's, and `file.copy()` copies between buckets with the object's metadata.
- **Resumable upload sessions**: `file.createResumableUpload({ metadata, origin })` returns a session URL on the byte route. A browser sends the bytes with one `PUT`, or with `Content-Range` slices whose first slice names the total size. The object is created with `metadata` when the last byte arrives. The URL accepts cross-origin requests from `origin`. A slice whose total is `*` is refused with `400`, because the session needs its size up front.
- **References from URLs**: `ref(storage, url)` takes the host's download URL, a `gs://` URL, or a production download URL and gives the reference at the URL's path, so `deleteObject(ref(storage, url))` deletes the object an app kept the URL for. In the page, the reference is on the default bucket whichever bucket the URL names.
- **Resumable uploads**: An upload is a `PUT` that continues from an offset with `Content-Range`, so `uploadBytesResumable` reports real progress and can pause and resume.

### Storage metadata repair warning

On startup, Pyric validates that stored byte counts match recorded metadata. If a previous run was abruptly halted mid-operation, you may see:
```
  ⓘ [pyric] Repaired Storage metadata that disagreed with the stored bytes
```
This warning indicates that Pyric's automated self-healing synchronized the byte count and metadata in SQLite without dropping your data.

---

## Capture and share a repro

When the host misbehaves, capture a repro file instead of describing the problem. The Node host keeps a bounded log of the recent operations on every connection, so you can capture after the problem appears without restarting anything.

1. Reproduce the problem in your app while the host runs.
2. In the project directory, write the repro file:
   ```bash
   pyric serve repro capture --out repro.json
   ```
3. Check that it reproduces on a fresh host:
   ```bash
   pyric serve repro replay repro.json
   ```
4. Attach `repro.json` to your bug report.

A repro file contains:

- The starting state: Firestore documents, the tree of every RTDB instance, Storage objects with their bytes, and Auth accounts.
- The rules each service and each RTDB instance enforced.
- The user each connection was signed in as, and the listeners it held.
- Every operation since, with its RTDB instance, path, arguments, and result or error, and every listener event each connection received.

`replay` runs the file on a fresh Node host and on a fresh SharedWorker host. For each, it reports the first result or listener event that differs from the recording. It also reports every frame where the two hosts disagree. It exits with code 1 on any difference. Pass `--json` for the full report.

To keep a repro as a regression test, replay it in a test that runs on Node 22.15 or later:

```ts
import { readFileSync } from 'node:fs';
import { replayRepro } from '@pyric/cli/repro';

const report = await replayRepro(JSON.parse(readFileSync('repro.json', 'utf8')));
assert.ok(report.ok, JSON.stringify(report.planes, null, 2));
```

Keep these limits in mind:

- **Secrets**: A JSON Web Token keeps its header and claims and loses its signature. Private keys and service account records are removed. Sandbox account passwords and your data are included, so share the file only where your test data may go.
- **Bounded log**: The log holds the most recent 1,000 to 2,000 entries. When older entries are dropped, the file starts from a later state and says so.
- **Not replayed**: Changes made by `pyric <tool> <method>` commands are listed as warnings and are not replayed. Storage bytes that an app uploads over the HTTP byte route are not in the log.
- **Order**: Replay sends operations one at a time in the order the host handled them. A problem that depends on two connections' operations running at the same moment appears as the first operation whose result differs.

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

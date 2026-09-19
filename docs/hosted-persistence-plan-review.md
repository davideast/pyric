# Review of the unified Node-hosted persistence plan

Reviewed 2026-09-16, revised twice the same day after the implementing agent's responses, against branch `hosted-live-mode` at `470ba3d4`. The plan under review is the "Unified Node-hosted persistence" document. This review lists required amendments, gate additions, and decisions that need the project owner. Apply the amendments to the plan before implementation starts. Items marked "decision" wait for the owner's answer.

Facts from the branch that the plan must account for:

- `packages/cli/src/serve/hosted/project-ownership.ts` already loads `bun:sqlite` or `node:sqlite` by runtime. A runtime-neutral SQLite adapter exists in the codebase today.
- The standalone `pyric` binary is built with `bun build --compile` (`packages/cli/scripts/compile.ts`). Its runtime is Bun.
- The repository test runner is `bun test`. There is one `node --test` file today, `scripts/packaging-processes.test.mjs`.
- Hosted persistence today is `packages/cli/src/serve/hosted/persistence.ts`: a sectioned JSON state file, Firestore as one blob through `recordBackendOverBlob`, Storage as base64 snapshot records.
- The MCP host persists separately to `.pyric/state/in-process.json` (`packages/cli/src/bridge/server/in-process.ts`). The SharedWorker path mirrors to `state.json`.
- Firestore records are already bucketed by FNV-1a hash of the document path into 256 buckets (`packages/pyric/src/sandbox/persistence/chunk-format.ts`).
- `.pyric/` is gitignored.
- The ledger `docs/hosted-review-ledger.md` items A3, C5, C9, D2, and D4 touch the same files as this work.

## Required amendments

### 1. Ship the Bun adapter with the Node adapter

Change "Reject hosted startup under Bun" to "Implement both adapters behind the one interface."

Reason: the standalone binary runs on Bun, so the plan as written refuses hosted mode for every user of the compiled CLI. The lock code already proves the dual-runtime pattern. The adapter interface in the plan (`exec`, `prepare`, `close`, statements with `run`, `get`, `all`, `Uint8Array` binding) maps directly onto `bun:sqlite`.

Gate: the step 1 contract tests run under both `bun test` and Node, against the same database file, and a database written by one runtime opens under the other.

### 2. Bound commit cost on the event loop

The driver is synchronous and `synchronous=FULL` fsyncs the WAL on every commit. The host serves every client from that loop. Acknowledgments wait for their commit, so the design must choose between one fsync per mutation and a coalescing window that every acknowledgment pays. Add to the design:

- Measure before choosing a window. Whichever is chosen, one structured flush stays one transaction. Never split a flush; a batch or transaction spanning buckets must not partially persist.
- Record commit duration in the connection diagnostics already exposed over HTTP and the CLI, so a stalled loop is visible.
- Set `PRAGMA busy_timeout` on persistence connections. The ownership lock keeps `busy_timeout=0` so a second owner is rejected immediately; do not change it.

Gate addition for step 5: define the workload (hundreds of writes per second from one browser for sixty seconds) and the reference environment, measure a baseline on the current JSON persistence, then freeze numeric ceilings for p95 mutation latency and event-loop delay before implementation begins. The gate fails when a ceiling is exceeded. Thresholds chosen after seeing results are not a gate. The plan's fixed workload with unrelated stored files does not exercise this.

### 3. Validate the filesystem at open and warn on synced folders

WAL requires a shared-memory file and honored POSIX locks. Network filesystems are incompatible; a Docker mount or a Windows path alone proves nothing.

- Validate that WAL activates at open and refuse with an actionable message when it does not.
- Warn once, do not refuse, when the project path is under iCloud Drive, Dropbox, or OneDrive. This is best-effort recognition of known locations. It does not claim that other paths are safe or that a synced folder always corrupts; it says the locks are not honored across the sync client, so WAL validation cannot catch it.
- Run `PRAGMA quick_check` at open for physical corruption. It cannot detect a stale but structurally valid database, so do not claim that.
- Document the supported storage.

Gate: WAL activation failure refuses startup with the documented message; a synced-folder path produces one warning and continues.

### 4. Make the degraded state visible

Step "Failure" preserves `committed-but-not-durable` and blocks subsequent mutations. Add: the host reports the degraded state through the existing runtime-status channel so the runtime chip and Studio show it, and the message names the recovery step. Restarting the host must not be the only exit the user can discover.

Gate: an injected commit failure through the SDK, then the chip and Studio each show the degraded state within the existing status latency.

### 5. Enforce the existing 8 MiB Storage limit at every hosted entry point

The worker protocol and the support contract already cap Storage operations at 8 MiB decoded. Storage bytes now share the WAL, the checkpoints, and the synchronous read path with structured state, so the cap must hold on the hosted path too, before any bytes are written. Record it as a measured limitation in the deferred-work section until streaming exists.

Gate: an upload at 8 MiB recovers byte-for-byte after restart; an upload over it is refused before any bytes are written, on every hosted entry point.

### 6. Shutdown ordering with a large commit in flight

Step 4 says drain, complete healthy pending persistence, then close. Add the interrupt case: a blob commit is in flight when the process receives SIGINT. State whether the commit completes or the upload is reported as not durable, and make the drain timeout name the outcome.

Gate: kill during a large blob commit, restart, and assert either the object is present in full or the upload is absent with no partial row. No third state.

### 7. Checkpoint healthy databases before a physical copy; preserve corrupt ones regardless

Step 4 archives the closed database directory for `fresh`. Add: run a full checkpoint and close before any physical copy of a healthy database. If corruption prevents the checkpoint, still preserve the closed directory including the `-wal` and `-shm` sidecars. Recovery must never depend on reading the damaged database. Logical exports need no checkpoint; a read transaction is a consistent snapshot in WAL mode. Document that copying `state.sqlite` alone while the host runs produces a stale copy.

Gate: archive after a burst of writes reopens with the last write present; archive of a database that fails `quick_check` preserves every file in the directory.

### 8. Windows handle contention on `fresh`

Renaming the directory fails with EBUSY when another process holds the `-shm` file. Add retry with bounded backoff on the rename and include a Windows run in the step 4 gate.

### 9. The `node:sqlite` experimental warning moves to the ledger

Node 22 prints `ExperimentalWarning` for `node:sqlite` at first use. The ownership lock already triggers it on the branch, so this slice does not introduce it, and Node can only disable the whole category, not one module. It leaves this slice and becomes a first-run item in the ledger: every hosted start prints it today, and the priorities file measures the season by time-to-first-win.

### 10. Test runner placement

Keep Bun as the orchestrator and launch Node subprocesses for the Node adapter's integration tests. Selecting an adapter by environment variable does not change the runtime, so it does not prove Node. Do not create a second test framework.

## Gate additions summary

| Step | Add |
| --- | --- |
| 1 | Both runtimes pass the contract tests; cross-runtime open; `busy_timeout` set; `quick_check` at open; WAL activation refusal; synced-folder warning |
| 2 | One flush is one transaction; commit duration in diagnostics |
| 3 | 8 MiB cap enforced before write on every hosted entry point |
| 4 | Checkpoint-before-archive test; corrupt-archive preservation test; Windows EBUSY retry preserving the original on failure; degraded-state visibility in chip and Studio; SIGINT during blob commit |
| 5 | Baseline measured and ceilings frozen before implementation; sustained-write workload fails the gate above those ceilings |

## Decisions for the project owner

These change the plan's shape. The implementing agent must not decide them.

1. **One store or three.** The plan leaves the MCP host on `in-process.json` and the SharedWorker path on `state.json`, and documents that modes do not share data. The sequence document says one authoritative sandbox per project directory. Options: accept three stores for this slice and add a startup message that names the other store when the lock refuses, or move the MCP host onto the SQLite store in this slice. Recommendation: accept three now, message at the lock, and ledger the MCP move as follow-up work. Moving it now widens the change into the in-process bridge.
2. **Bun adapter now or Node only.** Amendment 1 reverses the plan's deferral. The implementing agent treats the original plan as the ruling; the owner has not ruled. Recommendation: now, for the standalone binary. If the ruling is Node only, the support contract must state that hosted mode is unavailable in the standalone binary until the Bun adapter lands. Silent unavailability is what the contract forbids.
3. **Corrupt versus malformed.** Physical corruption fails closed, as the plan says. For a malformed application record, the implementing agent holds that starting with missing records changes subsequent behavior and writes, so automatic partial recovery needs its own contract, and recommends fail-closed for this slice with the database preserved for repair. That is defensible. Its cost: until a repair tool exists, one malformed record blocks the host entirely and `fresh` is the only remedy in practice. If the ruling is fail-closed, add a salvage command to the ledger now so A3 stays open with a path to close, and the refusal message must name that path rather than present `fresh` as the remedy.

## What the plan gets right and must keep

- One transaction per structured flush; bytes and metadata together for Storage.
- Clean break, no legacy importer, no dual writes.
- `PRAGMA user_version` for schema, payload versions kept separate.
- Existing codecs and bucket identities preserved; no engine rewrite.
- Storage injection seam before service initialization.
- Refuse corrupt or unsupported databases without resetting them.
- No claim that this resolves the slow-client memory budget.

## Ledger coordination

Ledger item A3 stays open under decision 3's fail-closed ruling and gains a companion item: a salvage command that reads a preserved database, reports unreadable records by namespace and id, and writes a repaired copy without touching the original. The experimental warning becomes a ledger first-run item per amendment 9. Items C5, C9, D2, and D4 touch `hosted/runtime.ts` and the capture store; land them before or after this slice, not interleaved with it.

## Addendum: revised plan accepted with one gate correction

The revised plan ("Unified Node-hosted persistence and recovery") absorbs every amendment above and records the two owner rulings: Node only, with the standalone-binary limitation stated in the support contract, and fail-closed on malformed records with the salvage command as a release requirement shipped in the same series. Ledger items A3 and H1 are governed by that ruling.

One correction before step 0 runs:

**The performance gate must not use the JSON baseline's mutation latency as the ceiling.** JSON persistence acknowledges before its debounced write lands; the new contract acknowledges after an fsync'd commit. Measured against the old number, SQLite either fails on day one or the metric gets redefined. Split the metrics:

- Event-loop delay: like-for-like, keep the baseline ceiling as written.
- Acknowledgment latency: an absolute budget frozen before implementation, derived from measured fsync cost on the reference machine plus existing request overhead, not from the JSON baseline.
- Throughput and error counts: as written, so dropped work cannot mask a pass.

Two notes for the step 4 gate, not blocking:

- Record startup time at the baseline data size. Full payload validation before admitting clients is the right fail-closed choice, and its cost must stay visible as data grows.
- The legacy-JSON refusal must check only the hosted state file. The in-process MCP store is JSON in the same tree and remains unchanged; tripping on it would block every project that has used the MCP host.

# Hosted persistence contract

Implementation target; validation evidence is tracked in the implementation plan.

## Ownership and format

The Node host owns `.pyric/state/hosted/`: `state.sqlite` and the object files
under `objects/`. The existing project lock
admits one writer. Clients mutate state through the host, never direct SQL.
SharedWorker and the in-process MCP host keep their existing stores; no data
transfer occurs automatically. Old JSON files are neither inspected nor removed.

SQLite schema version is `PRAGMA user_version`; service payload versions are
independent. Structured records retain existing portable value codecs. A
Storage object is a row of metadata keyed by bucket and object path, naming its
bytes by SHA-256; the bytes are one immutable file, `objects/<ab>/<sha256>`, so
identical objects share a file (ADR 0018). No Node object serialization is
persisted. Newer/unknown versions fail closed. An
older version is upgraded in place on the first writable open, and only after
its contents validate, so a store that is refused is left unchanged. Read-only
opens, the offline export and salvage, read an older version as it is.
Upgrading version 1 or 2 writes every object's bytes to its file first, then
replaces the table in one transaction and reclaims the database pages the bytes
held; an interruption before that commit leaves the store as it was. Upgrading
version 3 drops its table of staged upload parts.

Hosted mode requires Node >=22.15 and is unavailable in the Bun standalone
binary until a Bun adapter ships. SharedWorker remains supported.

## Commit and failure

One structured flush commits changed records and deletions in one transaction.
One Storage operation writes its bytes to a temporary file, `fsync`s it, renames
it to its hash, `fsync`s the directory, and only then commits the row that names
it, so no committed row names bytes that are missing. An interruption leaves at
most an unreferenced file. A deleted or replaced object's file stays on disk
until the next start: once the store validates, a sweep runs in the background
and removes object files that no row names and that were modified more than two
seconds before it began, so it never races a write whose row has yet to commit.
It never waits on the database and never delays a request; closing the host
stops it between shard directories.

A chunked upload appends its parts, in order, to one file under
`objects/.staging/` and hashes them as they arrive. Finishing it is the engine's
upload of that file: the file is `fsync`ed and renamed to its hash, and no byte
of it is read, so host memory does not grow with the object. An upload lives
only as long as the host that began it; the next host discards what it left
staged. Separate Firebase
operations have no new cross-service transaction guarantee. A successful mutation
acknowledgment follows its required persistence commit. A lost acknowledgment
does not prove the operation was absent; do not promise exactly-once requests.

Persistence connections let SQLite retry lock contention for up to 250 ms per
statement. The project-ownership lock retains its zero timeout. Contention that
clears within the window does not mark persistence unhealthy. An exhausted retry
is a persistence failure under the fail-closed policy below.

WAL uses `synchronous=FULL`. Durability assumes the filesystem and device honor
SQLite's synchronization. SQL failures roll back. If an in-memory mutation cannot
be persisted, report `committed-but-not-durable`, mark the host unhealthy, and
refuse further mutations. Diagnostics, Studio and the runtime chip expose that
state; reads may reflect changes that were not persisted.

Shutdown stops admission, drains accepted work, completes healthy persistence,
then closes services/database and releases ownership. Forced termination leaves
a transaction's previous or committed state, not partially written rows.

## Restoration and repair

Normal startup validates the database and application payloads before admitting
clients. It refuses corrupt, malformed and unsupported data rather than silently
dropping records. For each Storage row it checks that the file exists at the
recorded size, without reading it. Full validation has a measured startup cost.

`pyric sandbox salvage --source <hosted-directory> --out <new-directory>` is an
offline, explicit recovery operation. It works on a copy of the database, reads
object files in place, never changes the original, reports excluded records,
copies an object file whose content does not hash to its name to `quarantine/`
in the output and names it in the report, and validates its output with normal startup
rules. It refuses existing output directories and unsupported formats. It never
automatically activates a repaired database. The user must review the report;
recovered data may be incomplete. It cannot promise recovery from arbitrary
physical SQLite corruption. An unrecoverable input is an error, not empty success.

Archives preserve the full closed directory including WAL/SHM sidecars. Healthy
databases checkpoint first; damaged ones remain archivable without checkpointing.
Never copy only the main file while a host is writing. Logical JSON exports use
a consistent read transaction, without stopping the host.

A logical export carries every Storage object inline as base64 in one JSON
document, and V8 caps a string near 512 MiB, so an export holds at most about
360 MiB of object bytes (`MAX_INLINE_EXPORT_STORAGE_BYTES`). Past that the
export is refused by name, with a 413 from `GET /__pyric/state` and a message
from `pyric snapshot`, before any object is read. The host keeps running and
its data is unaffected. Host startup never reads object bytes.

## Transport backlog and recovery

Each WebSocket has one 24 MiB output backlog shared by all frames. When sending
the next encoded frame would exceed the limit, the bridge fails the operation
that frame belongs to and keeps the socket open. A request that was never sent
is refused to its caller, who may retry it. A response larger than 4 KiB is
replaced by a `resource-exhausted` error under the same correlation id, which
says the response was not delivered and the operation may have completed. A
response of 4 KiB or less is delivered.

A frame with no operation behind it, such as a pushed snapshot or observation
batch, has nothing to fail, so the bridge closes that socket with code `1013`.
A stalled observation consumer therefore still interrupts its own socket;
healthy consumers on other sockets can continue. Frames written past the limit
are capped at 1 MiB per socket until the backlog has room again, after which
the socket closes with `1013`. This bounds buffered socket output, not total
host memory.

Mutations already sent may have completed even if their acknowledgments are
lost. Reconnect restores observations, including Firestore, RTDB, presence and
event streams, without replaying writes. Callers must check state before
retrying a mutation whose outcome is unknown.

Per-consumer observation queues with drop reporting are not part of this
release. The release policy is a shared socket cutoff and reconnect, not
independent scheduling of operation and observation traffic.

The backlog acceptance is
the policy test in `packages/cli/test/e2e/hosted/section-five-slow-client.pw.ts`;
the separate resident-growth test tracks the host memory budget. Observation
restoration is covered separately by
`packages/cli/test/e2e/hosted/restart-subscriptions.pw.ts`.

## Peer reply correlation

A peer reply with a missing or non-string request id is discarded without
settling any pending operation or tool call. A snapshot with a missing or
non-string subscription id is discarded without closing any subscription.
Each discarded frame emits one bridge error diagnostic naming the frame type
and unusable id; the payload is not logged.

Other valid replies continue normally. A call that receives no usable reply
remains subject to its existing deadline; no write is automatically retried.
A malformed result with a valid known id still fails only its matching caller.
Peer disconnection and replacement retain their existing failure behavior for
in-flight calls.

This policy is pinned by
`packages/cli/test/bridge/ledger/c8-malformed-peer-isolation.test.ts`.

## Limits and verification

Storage bridge operations retain the 8 MiB decoded frame limit, while whole-object
persistence supports chunked transfers up to 512 MiB (`MAX_STORAGE_OBJECT_BYTES`, ADR 0015).
AI/Traffic history, delivery queues and browser identity sessions acquire no additional durability guarantee.
WAL requires supported local storage. Known synced-directory warnings are
heuristics, not filesystem safety certification.

Required evidence: record and Storage restart/rollback tests, cross-bucket atomic
batch tests, real-Node adapter tests, healthy/degraded client status, ownership and
shutdown tests, untouched-source salvage tests, browser/packaging regressions,
and frozen performance gates. Salvage must ship before hosted mode is announced.

## Resident memory ceiling and soak verification

A long-running Node host maintains bounded memory under continuous, sustained developer traffic.
Verified via `scripts/diagnostics/host-memory-soak.ts` under a multi-surface workload:
- Continuous Firestore mutations (15–20 writes/sec) with active snapshot listeners.
- Sustained chunked Storage transfers near the 8 MiB per-frame boundary (6 MiB files).
- Ongoing Auth user creation, claim assignment, and session churn.
- Multiple client WebSockets connecting, handshaking, and disconnecting.

### Memory bounds

- **Collected Heap Ceiling**: Plateaued between 45 MiB and 60 MiB with near-zero retained slope across extended soak runs.
- **Resident Set Size (RSS)**: Stays bounded under 400 MiB (typically 320–370 MiB under high SQLite WAL write pressure).
- **Diagnostics Inspection**: The host exposes real-time memory metrics at `GET /__pyric/diagnostics` (`server.memory: { rss, heapUsed, heapTotal, external }`). Passing `?gc=1` forces garbage collection prior to inspection when running Node with `--expose-gc`.

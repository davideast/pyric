# Hosted persistence contract

Implementation target; validation evidence is tracked in the implementation plan.

## Ownership and format

The Node host owns `.pyric/state/hosted/state.sqlite`. The existing project lock
admits one writer. Clients mutate state through the host, never direct SQL.
SharedWorker and the in-process MCP host keep their existing stores; no data
transfer occurs automatically. Old JSON files are neither inspected nor removed.

SQLite schema version is `PRAGMA user_version`; service payload versions are
independent. Structured records retain existing portable value codecs. Storage
objects use raw bytes plus metadata, keyed by bucket and object path. No Node
object serialization is persisted. Newer/unknown versions fail closed.

Hosted mode requires Node >=22.15 and is unavailable in the Bun standalone
binary until a Bun adapter ships. SharedWorker remains supported.

## Commit and failure

One structured flush commits changed records and deletions in one transaction.
One Storage operation commits bytes and metadata together. Separate Firebase
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
dropping records. Full validation has a measured startup cost.

`pyric sandbox salvage --source <hosted-directory> --out <new-directory>` is an
offline, explicit recovery operation. It works on a copy, never changes the
original, reports excluded records, and validates its output with normal startup
rules. It refuses existing output directories and unsupported formats. It never
automatically activates a repaired database. The user must review the report;
recovered data may be incomplete. It cannot promise recovery from arbitrary
physical SQLite corruption. An unrecoverable input is an error, not empty success.

Archives preserve the full closed directory including WAL/SHM sidecars. Healthy
databases checkpoint first; damaged ones remain archivable without checkpointing.
Never copy only the main file while a host is writing. Logical JSON exports use
a consistent read transaction, without stopping the host.

## Transport backlog and recovery

Each WebSocket has one 24 MiB output backlog shared by all frames. The bridge
closes that socket with code `1013` when sending the next encoded frame would
exceed the limit. A stalled observation consumer therefore interrupts its own
operations on that socket; healthy consumers on other sockets can continue.
This bounds buffered socket output, not total host memory.

Mutations already sent may have completed even if their acknowledgments are
lost. Reconnect restores observations, including Firestore, RTDB, presence and
event streams, without replaying writes. Callers must check state before
retrying a mutation whose outcome is unknown.

Per-consumer observation queues with drop reporting are not part of this
release. The release policy is a shared socket cutoff and reconnect, not
independent scheduling of operation and observation traffic.

The backlog acceptance is
`packages/cli/test/e2e/hosted/section-five-slow-client.pw.ts`; observation
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

Storage operations retain the 8 MiB decoded limit. AI/Traffic history, delivery
queues and browser identity sessions acquire no additional durability guarantee.
WAL requires supported local storage. Known synced-directory warnings are
heuristics, not filesystem safety certification.

Required evidence: record and Storage restart/rollback tests, cross-bucket atomic
batch tests, real-Node adapter tests, healthy/degraded client status, ownership and
shutdown tests, untouched-source salvage tests, browser/packaging regressions,
and frozen performance gates. Salvage must ship before hosted mode is announced.

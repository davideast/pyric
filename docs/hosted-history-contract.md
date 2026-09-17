# Hosted history and backups

Node hosted mode keeps history in the same SQLite database as current state.
Schema 2 upgrades schema 1 transactionally and records that earlier history is
unavailable. The store has a stable UUID; records have increasing integer
sequences and a session identifier. SharedWorker storage is unchanged.

## What is durable

Structured state changes, the corresponding mutation record and Firestore undo
position commit together. Storage bytes, metadata and its mutation record also
commit together. Undo stores exact before/after values for affected documents;
redo does not rerun transforms. A new write clears the active redo path without
deleting its audit records. Reset, seed/import and salvage establish explicit
undo boundaries. `--fresh` retains the previous hosted directory through the
existing archive mechanism and creates a new store identity.

The journal captures the host's existing SandboxEvent stream across services,
plus bounded engine inspection records. It does not invent browser-only activity,
missing request bodies or provider responses that were never observed. The engine
inspection tool returns a recent window; the CLI pages the durable journal.

Observations flush at 250 ms, 256 queued records or 4 MiB, whichever comes first.
An accepted oversized observation bypasses the queue. Explicit flush, export and
healthy shutdown are barriers. A forced stop can lose an uncommitted observation
tail; an unclean-restart boundary reports that possibility. This does not weaken
the state/mutation acknowledgment contract. Recording failures share the host's
persistence failure latch. Further mutations are refused; status reports pending
bytes, unrecorded observations, durable sequence and undo/cache counters.

The undo cache retains at most 1,000 records and 4 MiB of encoded payload.
Oversized entries bypass it. Pending undo payloads and cursor changes have a
24 MiB admission budget. Inspection pages contain at most 1,000 records and
4 MiB, with one accepted oversized record allowed to occupy its own page.
Eviction removes cached values, never SQLite history. Disk usage remains unbounded
until an explicit future pruning policy is implemented; full-disk errors fail
persistence rather than silently discarding history.

Startup validates current state, store identity and undo indexes. Historical
payloads are decoded and checksum-validated when requested. Unreadable records
fail inspection/export/undo explicitly. Salvage copies readable history, reports
exclusions, replaces unreadable journal records with explicit boundary records,
and starts a new store identity with an empty active undo chain. It never writes
to the original. An unreadable source identity is reported as an exclusion; the
repaired copy still gets a new identity and must reopen successfully. Missing sequence rows or physical corruption require manual
recovery; salvage refuses to guess which history was lost.

## CLI checkpoint

Run from the project directory with Node 22.15 or later. Substitute the actual
local hosted port for `5217`:

```sh
pyric sandbox history status --port 5217
pyric sandbox history list --port 5217 --limit 25
pyric sandbox history list --port 5217 --service firestore --after 25 --limit 25
pyric sandbox history export --port 5217 --out ./history-backup
pyric sandbox history verify --out ./history-backup
pyric sandbox history export --port 5217 --out ./history-backup --watch
```

Use the returned `next` cursor when paging; cursors belong to the returned
`storeId`. A requested high-water mark beyond the current durable sequence is
rejected, so an empty filtered page cannot skip future records. Service keys include `firestore`, `auth`, `rtdb`, `storage`, `ai`,
`messaging` and `runtime`. Stop a watch with Ctrl-C; it finalizes its current
segment. Rerunning export resumes from verified segments. Stop the host and omit
`--port` for offline status, list or export. Offline access holds the project
ownership lock and opens the state database read-only. Live access uses the
existing host/session capability checks and refuses a different project.

A practical checkpoint is to sign into Orbit in two browser profiles, send a
message, confirm the second profile receives it, then run status/list/export/
verify. Reload the second profile and confirm the message remains. Stop and
restart the host, then confirm the same store ID and increasing durable sequence.
Use a disposable project for reset/import/salvage checks.

## Portable archive contract

A backup is JSONL with format `pyric/history/1`. The header gives store identity,
previous segment and starting cursor. Each record contains sequence, session,
kind, service, canonical `encodedPayload` and its SHA-256 checksum. That payload
is a version-1 envelope declaring `pyric/firestore-values/1`; consumers should
use the declared value codec rather than treating decoded display fields as the
portable representation. The footer gives final sequence, record count and the
SHA-256 of header and record lines including their newlines.

Segments target 64 MiB or 60 seconds of activity, preserve complete records, and
are finalized on a one-shot export or graceful watch stop. Export writes a
private temporary file, fsyncs it, verifies checksums and sequence continuity,
renames it and syncs the directory before atomically advancing the checkpoint.
An OS-owned SQLite lock prevents concurrent exporters from sharing a destination;
process termination releases it. A restart verifies the complete segment chain,
including finalized segments whose checkpoint was not written. It neither
overwrites finalized files nor trusts an incomplete chain. Temporary files from
an interrupted export are ignored, not promoted or mistaken for backups.

Exports use bounded pages and release each database read before filesystem work;
they do not pin a long WAL read transaction. Export errors stop that exporter and
leave SQLite authoritative. Rotation never deletes older segments or prunes the
database. These archives preserve recorded history; they are not a full sandbox
snapshot, an automatic restore facility or an exactly-once request protocol.

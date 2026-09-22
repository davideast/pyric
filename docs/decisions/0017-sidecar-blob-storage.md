# 0017: Hosted Storage keeps object bytes beside the database, not inside it

Status: Proposed

Date: 2026-09-22

## Context

Hosted mode stores every Storage object as a `BLOB` column in
`.pyric/state/hosted/state.sqlite`:

```sql
CREATE TABLE storage_objects (
  bucket TEXT NOT NULL,
  path TEXT NOT NULL,
  metadata TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY (bucket, path)
) STRICT;
```

That layout buys real properties. Bytes and metadata commit in one transaction,
so they cannot tear apart. A delete reclaims its bytes with no reference
counting. Snapshot, archive, `--fresh`, and `salvageHostedState` each reason
about a single directory holding a single file.

It was chosen when objects were bounded at 8 MiB by the bridge's single-frame
limit. ADR 0015 raised the object ceiling to 512 MiB via chunked transfer but
left the storage layout alone. An application that stores audio or video now
routinely writes objects two orders of magnitude past what the layout was
designed for, and Pyric runs on a developer's laptop, where the disk is theirs
and the process is long-lived.

Measured against a real workload — 24 narration objects between 4 and 29 MiB,
382 MiB total, the shape `tts-flash` actually produces:

| | bytes in SQLite | bytes beside SQLite |
| --- | --- | --- |
| Ingest | 1278 ms (299 MiB/s) | **1018 ms (375 MiB/s)** |
| Peak footprint while ingesting | 411.7 MiB | **382.0 MiB** |
| Footprint after deleting half | 382.5 MiB | **195.0 MiB** |
| Space stranded by that delete | **187.5 MiB** | 0 MiB |
| Reclaiming it | `VACUUM`, 598 ms, exclusive lock, ~2x free disk | free, 5 ms sweep |
| 1 MiB ranged read at 20 MiB offset | 3.78 ms | **0.13 ms** |

Sidecar ingest is faster *including* SHA-256 over every byte and an explicit
`fsync` per object. The database never pays the write amplification of copying
blob pages through the WAL.

Two findings decide this.

**Deleted bytes are not returned to the developer's disk.** SQLite marks freed
pages reusable within the file; it does not shrink the file. After deleting 12
of 24 objects the database still occupies 382.5 MiB to hold 195.0 MiB of live
data. A developer iterating on generated audio — create, listen, discard,
regenerate — grows `state.sqlite` monotonically inside their project directory
and has no signal that it is happening. `VACUUM` is not a fix: it rewrites the
whole database, takes an exclusive lock that stalls the sandbox every client is
attached to, and needs roughly twice the live size in free space at the moment
it runs.

**Ranged reads are O(total object size), not O(range).** ADR 0015 states that
"SQLite reads a range with `substr(bytes, offset, length)` without materializing
the whole blob." That is not true of `node:sqlite` (#715). Holding the read at
4 MiB and varying only the object:

| Object size | Cost of an identical 4 MiB ranged read |
| --- | --- |
| 10 MiB | 1.95 ms |
| 50 MiB | 7.25 ms |
| 200 MiB | 28.47 ms |

Cost tracks the object, so `substr()` materializes the blob and then slices.
RSS reached 323 MiB while reading 4 MiB. The zero-copy path SQLite offers for
this is incremental blob I/O (`sqlite3_blob_open`), and `node:sqlite` exposes no
such API — `DatabaseSync.prototype` carries `open, close, prepare, exec,
function, createTagStore, aggregate, createSession, applyChangeset,
enableLoadExtension, loadExtension, serialize, deserialize, setAuthorizer` and
nothing for blobs. Chunked download therefore reads every object once per part:
a 30 MiB object costs eight full materializations, and the whole-object cost of
a download is quadratic in its size.

The layout is not wrong. It has outgrown its range.

## Decision

Keep metadata in SQLite. Move bytes to a content-addressed store beside it.

```
.pyric/state/hosted/
  state.sqlite          records, auth, storage METADATA
  objects/
    3f/3fa1c8...e7      one immutable file per distinct content hash
    9b/9b02de...41
```

```sql
CREATE TABLE storage_objects (
  bucket   TEXT NOT NULL,
  path     TEXT NOT NULL,
  metadata TEXT NOT NULL,
  mime     TEXT NOT NULL,
  sha256   TEXT NOT NULL,   -- replaces `bytes`
  size     INTEGER NOT NULL,
  PRIMARY KEY (bucket, path)
) STRICT;
```

**Durability comes from ordering, not from a shared transaction.** A write is
only committed after its bytes are durable:

1. Write to `objects/.tmp-<uuid>`.
2. `fsync` the file descriptor.
3. `rename()` into `objects/<ab>/<hash>` — atomic on POSIX and NTFS.
4. `COMMIT` the SQLite row naming that hash.

Every interruption lands on a safe side. Crash before step 4 and an
unreferenced file remains: invisible to every reader, removed by the next
sweep. There is no ordering that produces a row pointing at bytes that are not
there, which is the failure the single-transaction layout exists to prevent.
Content addressing makes step 3 idempotent, so a retry after a partial write
cannot corrupt a good object.

**Reclamation is a sweep, not a rewrite.** Deleting a row leaves its file
unreferenced. A sweep — `SELECT DISTINCT sha256`, unlink anything absent from
that set — runs at startup and on idle, takes no exclusive lock, and needs no
free space. Measured at 5 ms for this workload.

**Reads open the file.** `storage.readRange` becomes a positional read;
`getBlob` streams. Neither touches the SQLite connection, so a large download no
longer contends with Firestore writes on the single hosted connection or its
`busy_timeout=250`.

Rules, generations, and ownership do not move. A read still resolves its path
through a rules-checked operation; only the bytes travel outside the database.

## Consequences

`MAX_STORAGE_OBJECT_BYTES` stops being a property of SQLite. The 512 MiB
ceiling was set by `SQLITE_MAX_LENGTH` and by the need to hold an object in one
`Buffer`. A file store bounded by streaming has neither constraint, and the cap
becomes a policy number that can move toward Cloud Storage's without changing
the layout again.

Content addressing deduplicates. Regenerating identical audio stores one file,
and a superseded generation stays readable as long as a row names its hash.

Immutable blob files change what backup and sync tools do. A monolithic
`state.sqlite` is rewritten on every change, so Time Machine, Dropbox, and rsync
re-copy the whole database each time. Immutable content-addressed files are
copied once, ever. Pyric already warns when hosted state sits in a synced
directory; this narrows what that warning has to be afraid of.

`salvageHostedState` gains a case and loses a risk. It must now report a row
whose blob file is missing or whose bytes do not hash to their name — but a
corrupt database page can no longer take an object's bytes with it, and a
readable object survives a database that does not. Archive and snapshot already
copy the directory recursively, so they keep working unchanged.

The cost is that hosted state is two things instead of one. A developer copying
`state.sqlite` alone now gets metadata without bytes. Keeping blobs inside the
same `hosted/` directory that every existing tool already treats as the unit of
state is what keeps that from becoming routine, and salvage naming the missing
files is what makes it legible when it happens.

An object under roughly 100 KiB is faster inside SQLite than beside it, which is
SQLite's own published guidance. Writing every object to a file spends an inode
and an `fsync` on payloads that would have been cheaper inline. A size threshold
that inlines small objects would recover that, at the price of two read paths
and two write paths; this ADR does not adopt one, and leaves the measurement to
whoever finds small-object throughput matters.

## Alternatives considered

**Incremental blob I/O via `better-sqlite3`.** Keeps single-file atomicity and
fixes ranged reads with `sqlite3_blob_open`. Viable, and not blocked by the
concern usually raised against it: hosted mode already refuses to run under Bun
and the standalone binary, `node:sqlite` is resolved lazily through
`process.getBuiltinModule` so no bundler follows it, and `@pyric/cli` already
ships a platform-native binary through `esbuild` → `@esbuild/darwin-arm64`. The
real objection is narrower. `esbuild` delivers prebuilt per-platform packages
through `optionalDependencies` and never needs a compiler; `better-sqlite3`
falls back to `node-gyp` when no prebuild matches the running ABI, which puts a
C++ toolchain on the install path for anyone on a new Node major. It also
leaves every other finding in place: deleted bytes still strand, `VACUUM` still
locks, the database still absorbs blob write amplification, and the HTTP byte
endpoint still copies through JS instead of handing the kernel a descriptor. It
buys one of the five problems at the cost of a compile step.

**Raise `MAX_STORAGE_OBJECT_BYTES` and leave the layout alone.** Makes the
stranded-space and quadratic-read behavior worse in proportion to the new
ceiling.

**`VACUUM` on a schedule.** Treats the symptom, and does so with an exclusive
lock on the sandbox every client shares plus a transient doubling of disk use.

## Open questions

1. When does the sweep run? Startup is certain but delays a large project's
   first byte. Idle is invisible but needs a definition of idle the host does
   not currently have.
2. Does salvage quarantine a blob whose content does not match its name, or
   exclude it? Quarantine keeps a partially-readable audio file the developer
   may still want; exclusion keeps the recovered state provably consistent.
3. Should the HTTP byte endpoint proposed for `getDownloadURL` (ADR 0015, open
   question 3) land in the same change? Sidecar files are what make it
   worthwhile — the route can hand a descriptor to the kernel rather than
   assembling a `data:` URI — but it is a separable transport decision.

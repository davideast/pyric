# 0018: Storage object bytes travel and rest by reference

Status: Accepted

Date: 2026-09-23

Supersedes the unmerged proposal to keep hosted Storage bytes in sidecar files
beside the database. Its layout, write order, sweep, and reasoning about
`better-sqlite3` are carried into part 1 below.

## Context

Pyric carries a Storage object's bytes inline wherever they appear. They sit in a
`BLOB` column in the Node host's SQLite store. They are base64 inside every
state document: `/__pyric/state`, `pyric snapshot`, checkpoints, branches, the
in-process `storage.json`, and a browser `--persist` state file. They are base64
inside every RPC frame that moves them. And they are one whole buffer in memory
whenever an upload finishes or a download URL is made.

Each representation assumed an object was small. ADR 0015 raised the per-object
limit from 8 MiB to 512 MiB by splitting transfers into parts, and changed none
of them. Each now fails at its own threshold, and each failure was reported as
a separate defect:

| Representation | What breaks | Evidence |
| --- | --- | --- |
| `BLOB` column, read by `substr` | A ranged read costs the whole object, because `node:sqlite` has no incremental blob I/O. A download in parts reads the object once per part. | A 4 MiB read: 1.85 ms from a 10 MiB object, 45.52 ms from a 200 MiB one. |
| `BLOB` column, finished by assembling parts | Host memory scales with the object. | A 200 MiB object: 836 MiB resident on upload, 1,124 MiB on read. |
| `BLOB` column, deleted or replaced | Freed pages stay in the file. The database never shrinks without `VACUUM`, which locks the host and needs twice the space. | One 200 MiB upload left 200 MiB of free pages in a 420 MiB file. |
| Base64 in one JSON document | The whole project's Storage is capped by V8's string length. | About 384 MiB in total, now refused by name at `MAX_INLINE_EXPORT_STORAGE_BYTES`. Checkpoints and branches hit the same wall with the raw error. |
| Base64 in RPC frames | A third more bytes on the wire, a slow encoder in the browser, and serial round trips. | Base64 writes 3 bytes as 4: a 29 MiB object crosses as 38.7 MiB. |
| A `data:` URI from `getDownloadURL` | The page holds the whole object as a string. `<audio>` cannot stream or seek it. | A 29 MiB file becomes a 39 MiB string. |

The in-browser store is the exception at rest: IndexedDB stores each object as
a native `Blob`, which is already a reference. Its exports still inline.

Raising a limit or streaming one serializer would move one threshold and leave
the rest. The common fix is to stop carrying bytes inline.

## Decision

An object's bytes are never embedded in a row, a document, or a frame that is
not a byte stream. Everything else refers to them by content hash. Four parts
follow from that.

**1. At rest: a content-addressed file store for the Node host.** Metadata
stays in SQLite. Bytes move beside it:

```
.pyric/state/hosted/
  state.sqlite
  objects/
    3f/3fa1c8…e7        one immutable file per distinct SHA-256
    .staging/<uploadId>  parts of uploads in progress
```

`storage_objects` replaces `bytes` with `sha256` and `size`. A write is
committed only after its bytes are durable, in this order: write a temporary
file, `fsync` it, `rename` it into `objects/<ab>/<sha256>`, `fsync` the
directory, then commit the row. Every interruption leaves either nothing or an
unreferenced file; no ordering produces a row naming bytes that are not there.
Content addressing makes the rename idempotent and deduplicates identical
objects.

A chunked upload appends its parts to one staging file and hashes it as it
goes, so finishing an upload is a rename, not an assembly in memory. A ranged
read is a positional read of the file.

Unreferenced files are removed by a sweep. The sweep keeps every hash named by
a live row, a checkpoint, a branch, or an upload in progress, and skips any file
modified after the sweep began, so it cannot delete a file whose row is about
to commit. It takes no lock on the database and needs no free space. It runs in
the background once startup has validated the store, and never delays a
request.

Every object is a file, whatever its size; there is no inline path for small
objects. One read path and one write path are worth more here than the speed
SQLite would give objects under about 100 KiB.

Salvage checks each file against its hash. A file that does not match is left
out of the recovered state, copied to a `quarantine/` directory in the salvage
output, and named in the recovery report, so the result is consistent and
nothing readable is destroyed.

The schema moves to version 3. The first writable open migrates version 2 by
writing each row's bytes to its file, one object in memory at a time, and then
replacing the table in one transaction, so an interruption leaves an intact
version-2 store. As with every hosted migration, it runs only after the store
validates, and a test opens a database from every earlier version.

**2. In documents: references, not payloads.** A state document's Storage
entry becomes `{ path, sha256, size, metadata }`. The bytes live in an
`objects/` directory beside the document, laid out as the store's.

- `pyric snapshot` writes a directory holding `state.json` and `objects/`, not
  an archive, so its contents can be read and small fixtures committed.
- `GET /__pyric/state` returns references; bytes are fetched by hash.
- Checkpoints and branches on the Node host record the hashes they keep in
  SQLite, so the sweep's roots are one query, capturing one copies no bytes,
  and restoring one is a metadata write. Checkpoints of an in-process sandbox
  keep their current files. Checkpoints moved in phase 1; branches are
  deferred and still carry their bytes inline.
- Seeds accept both forms: the current inline form for small fixtures, and the
  directory form.

This removes the aggregate export ceiling and makes a checkpoint as cheap as
its metadata.

**3. On the wire: an HTTP byte route on the Node host.** Rules and identity
stay on the existing RPC; only bytes move to HTTP. The route shares the page's
origin, because the host is mounted on the dev server, and its paths follow
Firebase's: `/__pyric/storage/v0/b/<bucket>/o/<path>`.

- An `<audio src>` request cannot carry headers, so a URL must carry its own
  authority. Uploads and downloads get it differently.
- `storage.beginUpload` returns, besides its upload id, a URL carrying a
  capability token bound to that upload. The client streams the object to it
  with `PUT`, and can continue an interrupted upload from the offset the host
  reports with `Content-Range`, since staging already appends in order. That
  makes pause, resume, and progress real. Finishing commits over RPC.
- `getDownloadURL` evaluates read rules over RPC and returns
  `/__pyric/storage/v0/b/<bucket>/o/<path>?alt=media&token=<token>`, as
  production does: the token is kept in the object's metadata
  (`downloadTokens`), does not expire, and is revoked by removing it from the
  metadata. `GET` on the path supports `Range`, so media streams and seeks.
- A `GET` is authorized by a download token or by the session token, so the
  SDKs' own reads (`getBytes`, `getBlob`, and Studio's previews through them)
  mint no tokens.
- The route is advertised as a capability in the WebSocket `attach-ack`. Every
  hosted client uses it whenever it is advertised: the web SDK, `pyric-admin`,
  and the Node remote client. The hosted base64 transfer operations are
  deleted. With HTTP underneath, `pyric-admin` downloads honour `start` and
  `end`, and `createReadStream` and `createWriteStream` work.
- A SharedWorker sandbox has no HTTP host and keeps its frames. MCP stays
  in-process: it keeps JSON, and moves large objects as project file paths, as
  `uploadBytes` already does with `sourcePath`.

**4. One write path.** Every upload, whether one frame, parts, or the byte
route, is committed by the engine's `uploadBytes` from a staged blob reference:
the engine builds the metadata from the sandbox clock, evaluates rules when the
object is created, and emits the one mutation event. The backend's part is to
stage bytes and adopt a finished blob. A chunked upload already commits this
way; the byte route must too.

**Limits.** `MAX_STORAGE_OBJECT_BYTES` becomes a policy number about disk, no
longer tied to SQLite's value length or to one buffer. Host memory per transfer
is bounded by the stream buffer, and a test asserts it for an object many times
that size. The in-browser store, the in-process MCP `storage.json`, and a
browser `--persist` state file keep their inline form: they are single-user
development stores that rarely hold large media. Each gets a named limit and a
refusal that says what was exceeded, as the Node host's export has. They move to
references only if that limit is reached in practice.

## Consequences

Reads cost the range they ask for. Host memory no longer grows with object
size. Deleting an object gives its space back at the next sweep. A project's
total Storage is bounded by disk, not by a string. Media streams from a real
URL. A 29 MiB upload crosses the wire as 29 MiB.

Hosted state becomes a directory with two parts. Copying `state.sqlite` alone
gives metadata without bytes. Archive, `--fresh`, and salvage already treat the
`hosted/` directory as the unit, which keeps that from happening by accident.
Salvage gains a case, a row whose file is missing or does not hash to its name,
and loses one: a damaged database page can no longer take an object's bytes
with it.

`pyric snapshot` output changes from one file to a directory. Tools that read
the Storage section of a state file must follow references. Pyric is in alpha,
so the old form is not kept alongside.

Every object costs an inode and an `fsync`. Under roughly 100 KiB, SQLite is
faster than a file.

## Alternatives considered

**Keep the column, add incremental blob I/O through `better-sqlite3`.** Fixes
ranged reads and keeps a single file. It needs a native module that falls back
to compiling when no prebuilt binary matches the running Node, and it leaves
stranded space, `VACUUM`, write amplification through the WAL, and every inline
document as they are.

**Store each object as rows of 4 MiB chunks in SQLite.** Fixes ranged reads and
finishing without assembly, and keeps one file and one transaction. Deleted
space still strands in the file, the WAL still carries every byte twice, and
documents and frames are unchanged. This is the strongest alternative for the
at-rest part alone.

**Stream the JSON export.** Removes the V8 limit for the HTTP endpoint only.
Clients still parse a document the size of the project, and checkpoints are
unchanged.

**Raise the limits, or `VACUUM` on a schedule.** Moves thresholds and makes the
stranded-space and ranged-read costs grow with them.

## Rulings

The questions left open when this record was proposed, and how they were
settled on 2026-09-23:

| Question | Ruling |
| --- | --- |
| `pyric snapshot` output | A directory holding `state.json` and `objects/`. |
| When the sweep runs | In the background after startup validation, never blocking a request. |
| A file that does not match its hash, in salvage | Left out of the recovered state, copied to `quarantine/`, and named in the report. |
| Small objects inline in SQLite | No. Every object is a file. |
| Byte route authority | Tokens bound to one operation. |
| Where checkpoint and branch manifests live | In SQLite for the Node host; in-process checkpoints keep their files. |
| In-process and browser stores | Stay inline under a named limit. |
| File store and documents by reference | Land together, as phase 1. |

The questions phase 2 raised, settled on 2026-09-23. The first amends the
byte-route ruling above for downloads.

| Question | Ruling |
| --- | --- |
| Download URL lifetime | As production: a persistent token in the object's metadata, revoked by removing it. Upload tokens stay bound to one upload. |
| Route paths | `/__pyric/storage/v0/b/<bucket>/o/<path>`, Firebase's segments under the pyric namespace. |
| Upload protocol | `PUT`, continuable from an offset with `Content-Range`. |
| Who may read bytes | A download token, or the session token. |
| How clients learn of the route | A capability in `attach-ack`. |
| Which clients switch | Every hosted client, always; the hosted base64 transfer operations are deleted. |
| `pyric-admin` ranges and streams | Included. |
| Branches by reference | Deferred; branches still carry their bytes inline. |
| Who parses the route's URLs | Only pyric. The real Firebase SDK never sees a `/__pyric/storage/v0/` URL: under `pyric sandbox`, the page's import map serves pyric's client for `firebase/storage`, and the Node register maps `firebase/storage` to `pyric/storage` and `firebase-admin` to `pyric-admin`, so every `ref(storage, url)` in app code runs pyric's own `ref()`. |

## Order of work

| Phase | Work |
| --- | --- |
| 1 | Schema version 3 and the blob store with its migration; chunked staging to one file; the sweep and salvage quarantine; documents by reference, and the Node host's checkpoints in SQLite. Each lands and is green before the next. |
| 2 | The loopback guard compares ports as documented; the byte route and its tokens; the web SDK on the route; the Node clients on it, deleting the hosted base64 transfer operations; `getDownloadURL` conformance. Each lands and is green before the next. |
| 3 | Named limits for the in-process and browser stores. |

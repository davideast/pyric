# 0015: Chunked transfer for Storage objects over the bridge

Status: Proposed

Date: 2026-09-21

## Context

A Storage object crosses the bridge as one operation: `storage.putBytes` carries
the whole object as base64 in a JSON frame, and `storage.getBytes` returns it the
same way. Three limits follow from that shape. `MAX_STORAGE_OP_BYTES` is 8 MiB of
raw bytes, which is about 11 MiB of base64. `MAX_BRIDGE_FRAME_BYTES` is 12 MiB,
sized to hold one such frame. `MAX_QUEUED_OPERATION_BYTES` is 24 MiB of queued
output per socket, sized to hold two.

Cloud Storage accepts objects up to 5 TiB, and an application that stores audio
or video passes 8 MiB routinely. One project raised all three limits to 512 and
768 MiB with a post-install patch so that 19.5 MB narration files would store.
That works, and it is the wrong fix to ship: every object is then held whole, as
a string a third larger than itself, by the sender, by each socket buffer it
waits in, by the JSON parser, and by the receiver. Host memory scales with the
largest object times the number in flight, and one slow reader holds all of it.

The limits are not the defect. The defect is that an object is one frame.

## Decision

Transfer an object in parts. Each part is an ordinary operation under the
existing frame and backlog limits, which do not change.

**Upload.** Three operations replace one for an object over the single-part
threshold:

- `storage.beginUpload { path, size, contentType?, metadata? }` returns an
  `uploadId`. The host checks rules once here, with `request.resource.size` set
  to the declared size, so an upload the rules deny never sends a byte.
- `storage.putPart { uploadId, index, dataB64 }` carries at most 4 MiB of raw
  bytes. Parts arrive in order on one connection. The host appends each part to
  a staging row and keeps a running byte count.
- `storage.finishUpload { uploadId }` checks that the staged byte count equals
  the declared size, then moves the staged bytes and the metadata into
  `storage_objects` in one transaction. The object becomes visible only here.
  It returns the same `FullMetadata` that `storage.putBytes` returns today.

An object at or under 4 MiB keeps using `storage.putBytes`. Nothing changes for
the common case.

**Download.** `storage.getBytes` gains optional `offset` and `length`. The
client first reads metadata for the size and generation, then requests 4 MiB
ranges and passes the generation it expects with each one. The host refuses a
range whose object generation differs with `storage/object-changed`, so a
download never splices two versions of an object. SQLite reads a range with
`substr(bytes, offset, length)`.

> **Correction (2026-09-23).** This section originally said `substr` reads a
> range "without materializing the whole blob." Under `node:sqlite` it does not.
> `node:sqlite` exposes no incremental blob I/O (`sqlite3_blob_open`), so
> `substr` builds the whole BLOB value and then slices it. A ranged read costs
> the size of the object, not the size of the range, and a download in parts
> reads the whole object once per part. The same 4 MiB read, measured on Node
> 22.18:
>
> | Object | 4 MiB `substr` read |
> | --- | --- |
> | 10 MiB | 1.85 ms |
> | 50 MiB | 11.05 ms |
> | 200 MiB | 45.52 ms |

**Staging.** Staged parts live in a `storage_uploads` table in the host's SQLite
file, keyed by `uploadId`, with the owning connection, the declared size, and a
created time. The host deletes an upload's rows when its connection closes, when
`storage.abortUpload` is called, and at startup for anything older than one
hour. The SharedWorker host stages in memory, since its store is in the page.

**Object size limit.** With parts, the per-operation cap no longer bounds an
object. The host enforces one new limit, `MAX_STORAGE_OBJECT_BYTES`, at
`beginUpload`. Proposed value: 512 MiB, configurable in `pyric.json` as
`storage.maxObjectBytes`. It is a disk and SQLite limit, not a memory limit:
host memory per transfer is one part.

> **Correction (2026-09-23).** Host memory per transfer is not one part. Besides
> the ranged-read cost above, finishing an upload assembles the whole object
> before it is written. Measured host peaks with objects in the `storage_objects`
> BLOB column: a 200 MiB upload reached 836 MiB resident, and reading it back
> reached 1,124 MiB. Host memory scales with the object, as it did before parts.

**Callers that change.** `pyric-admin`'s `file.save` and `file.download`, the
served client's `uploadBytes`, `uploadString`, `getBytes`, and `getBlob`, and the
Node conveniences in `packages/cli/src/remote`. Each picks the single-part or
multi-part path by size. `uploadBytesResumable` can report real progress from
the same parts.

## Consequences

Parts bound what one frame carries, about 4 MiB raw and 5.4 MiB encoded,
whatever the object size. They do not bound host memory; see the corrections
above. The 12 MiB frame limit and the 24 MiB backlog
stay as they are, and the per-operation refusal added for a full backlog now
costs a caller one part to retry, not a whole object.

A failed or abandoned upload leaves no object and no partial object: nothing is
visible before `finishUpload`. A reader during an upload sees the previous
version, as with Cloud Storage.

Startup validation stops treating an object over 8 MiB as fatal and checks
`MAX_STORAGE_OBJECT_BYTES` instead. A database written by a build with raised
limits then opens on a stock build.

An upload costs two extra round trips plus one per part. A 20 MiB object is
seven operations where it was one.

The base64-in-JSON encoding stays, with its one-third overhead. A binary frame or
an HTTP byte endpoint would remove it. That is a larger change to the transport
and is not needed to make large objects work; it can follow without changing
these operations' meaning.

## Open questions

1. Is 512 MiB the right default object limit, and should exceeding it fail at
   `beginUpload` with `storage/quota-exceeded` or a pyric-specific code?
2. Rules are evaluated once, at `beginUpload`, against the declared size and
   metadata. Cloud Storage evaluates at finalization. If a rules change between
   begin and finish should be honored, `finishUpload` evaluates again.
3. Should `getDownloadURL` for a served page be backed by an HTTP range endpoint
   on the host, so `<audio src>` streams without the client assembling a Blob?
   That is the first place an HTTP byte path would pay for itself.

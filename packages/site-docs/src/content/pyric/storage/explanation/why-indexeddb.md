# Why IndexedDB

`pyric/storage`'s sandbox backend persists blobs and metadata in IndexedDB. This page explains why, and what the choice implies.

## What we needed

The driving consumer is the playground: a browser app that lets users iterate on Firebase data + rules in-page. The session archive lives in the browser too, completed sessions stored locally and optionally uploaded to production later.

That meant three constraints:

- **Browser-native.** No Node `fs`, no native binaries, no Java emulator.
- **Persistent across reloads.** A user who tweaks rules, uploads a few sessions, and refreshes the page should find them still there.
- **Asynchronous.** The browser's main thread can't block on disk I/O.

IndexedDB ticks all three. It's the only browser API that's both standardised and persistent for arbitrary blobs.

## The alternatives we considered

### `localStorage`

Synchronous, capped at roughly 5 to 10 MB, strings only. A 1 MB JSON session would dominate the quota immediately. Ruled out.

### The Cache API

Better quota, persistent, async, but designed for HTTP request/response pairs. Storing arbitrary objects via it requires shoehorning a `Request` and `Response` around every blob. The fit is wrong.

### In-memory only

Simplest. Fast. Lost on every reload. The playground UX depended on persistence; an in-memory-only backend would have been hostile to iteration.

### Origin Private File System (OPFS)

Newer, more file-system-shaped, persistent. We didn't pick it because:

- Browser support is recent. IndexedDB is universal.
- The API is less ergonomic for "store a blob with metadata keyed by path". OPFS wants directories, sync access handles, more ceremony.
- IndexedDB's transaction model maps cleanly to Storage operations (each upload is one tx, each download is one tx).

OPFS is a future option if IndexedDB hits limits. For now, IndexedDB is doing the job.

## How the data is laid out

Two object stores:

- **`blobs`**: keyed by `fullPath`, value is the binary payload (`ArrayBuffer`).
- **`metadata`**: keyed by `fullPath`, value is the `FullMetadata` record.

An upload is one transaction that writes to both stores. A delete is one transaction that removes from both. Listing reads from the metadata store and walks its key range.

The two-store split is deliberate. Metadata is small and frequently read (every list, every `getMetadata`); blobs are large and read only on explicit download. Splitting them lets the browser cache metadata aggressively without paging blobs through the same heap.

## What this implies

### Quota

IndexedDB's quota is browser-dependent. Chrome / Edge / Firefox allow a percentage of free disk (single-digit GB on most machines). Safari is more conservative. Users hitting the quota get a `QuotaExceededError`.

The v1 scope doesn't surface a quota-checked API. Consumers worried about quota should `try/catch` and surface the error to the user.

### Concurrency

IndexedDB's transaction model is single-writer-per-store. Two simultaneous `uploadBytes` calls serialise behind the scenes. For the sandbox use case (one user, one tab) this is fine. For a hypothetical multi-tab scenario, the second tab's writes would wait briefly.

### Lifetime

IndexedDB persists until the user clears site data. Sandbox `reset()` does *not* clear it: `reset()` is about the sandbox's in-memory state, not the storage backend. To wipe a storage handle's data, build a new sandbox with a different `dbName`, or call `deleteObject` per item.

This separation is deliberate but occasionally surprising. The README and the [`StorageOptions`](../reference/storage-options.md) page call out the `dbName` idiom for test isolation.

### Browser-only

The IndexedDB path runs in browsers and in test runners that emulate IndexedDB (Bun has reasonable polyfills; Vitest with `happy-dom` or `jsdom` works). It does not run in plain Node.

The IndexedDB sandbox does not run in plain Node. Production Node code imports Firebase directly; that is not a sandbox substitute. A pure-Node Storage sandbox backend is not in scope today.

## Where this leaves us

IndexedDB hits the constraints, the data layout is simple, the API maps naturally to Storage operations. The few rough edges (quota errors, browser-only) are bounded and documented.

If the package grows beyond the session-archive use case (into large-file workflows, multi-GB sets, server-side stores) the backend choice will probably split. The sandbox handle would gain an in-memory option for tests; a hypothetical filesystem option for Node-side use. The API shape stays the same.

For now, IndexedDB is what the v1 scope needs.

# Implementation scope and deferred features

`pyric/storage` is a deliberate v1 scope. The scope is what the session-archive use case needed; anything beyond that is deferred. This page is the canonical list of what's not in the package and why.

## What's in scope

The bounded subset:

- `getStorageSandbox`, `getStorageProd`.
- `ref` with both overloads.
- `uploadBytes`, `uploadString`.
- `getBytes`, `getBlob`, `getDownloadURL`.
- `getMetadata`, `updateMetadata`.
- `listAll`.
- `deleteObject`.
- `parseStorageRules`, `evaluateStorageRules`.
- A Storage rules subset: service header, path matching, umbrella and granular allow verbs (`read`/`write`, `get`/`list`/`create`/`update`/`delete`), user-defined functions with `let`, `request.time` and `timestamp.date()`, `matches()`, dotted and bracket `customMetadata` access, `firestore.get()`/`firestore.exists()` cross-service lookups, and standard operators.

End-to-end coverage: see `packages/pyric/test/storage/session-archive.test.ts`.

### The sandbox `getDownloadURL` boundary

Prod handles return Firebase's token-signed HTTPS URL. Sandbox handles return a page-local `blob:` URL over the same rules-checked bytes:

```ts
const url = await getDownloadURL(ref(storage, 'sessions/n1'));
// ... use url ...
URL.revokeObjectURL(url);  // free the memory when done
```

The sandbox URL is a snapshot, not a Firebase download token. It cannot be shared outside the page and expires when revoked or when the page unloads.

## What's deferred

### Paginated `list`

`list(ref, { maxResults, pageToken })` from the upstream API isn't implemented. `listAll` covers every v1 scope scenario; pagination is reserved for future compatibility (the `nextPageToken: undefined` field in `ListResult` is there for that day).

### `uploadBytesResumable`

Resumable uploads with pause/resume/progress are a substantial piece of code that didn't serve the use case. Synchronous `uploadBytes` is what the package ships.

### Admin SDK shape

A sibling `pyric/storage-admin` package could mirror `firebase-admin/storage` the way `pyric-admin` mirrors `firebase-admin/firestore`. Not built yet; not blocking the v1 scope.

### Recorded production parity testing

Storage's behavior is not yet pinned to recorded production observations the way Auth and Firestore are. The rules engine is verified against the engine spec; the data plane is verified against the documented API. Pinning Storage to recorded production behavior is future work.

### `resource` content-hash fields

The engine doesn't yet expose `md5Hash`, `crc32c`, or `etag` on `resource`. The object-identity and time fields (`name`, `bucket`, `timeCreated`, `updated`, `generation`, `metageneration`) and the content fields (`size`, `contentType`, `metadata`) all work, sourced from the persisted object record.

### Gated `listAll`

`listAll` enforces the rules engine (ST-B2). Firebase's `read` (or granular `list`) permission governs list, and list is evaluated against the scanned prefix path, so `listAll` requires `read`/`list` on the listed folder. A `read` rule scoped to `match /sessions/{id}` does NOT grant list on `/sessions`; the folder needs its own read rule (the session-archive ruleset adds `match /sessions { allow read: if request.auth != null; }`). This matches prod: in real Firebase you'd hit the same requirement. With no rules configured, `listAll` is open-by-default like every other operation.

### Cross-bucket isolation

The `bucket` option round-trips through metadata but doesn't actually partition data. v1 has a single implicit bucket. Real multi-bucket support is reserved for when a consumer needs it.

### Cloud Functions Storage triggers

Triggers on upload / delete are out of scope. They're not data-plane concerns. The closest analog would be a sandbox-side event channel; not built.

### Image transformations / Firebase Extensions

Not modelled. Production-only.

## How to know if your use case is in scope

Three questions:

1. **Is your operation in the in-scope list above?** If yes, it works.
2. **Does your rule use only the subset in [`Storage rules subset`](../reference/rules-subset.md)?** If yes, it'll parse and enforce correctly.
3. **Are you on a sandbox handle (IndexedDB), or a prod handle (real Cloud Storage)?** The sandbox-only options affect only the sandbox path.

If your answer to any is "no", check the deferred list. Often there's a narrower API or a different backend (prod for unbounded features).

## When to upgrade the v1 scope

The package will graduate from v1 scope to stable when consumers ask for the deferred features in concrete use cases. Until then, the scope reflects what was needed; expanding it speculatively would add surface that nobody runs through tests.

If you have a use case the v1 scope doesn't cover, file an issue with the operation, the rule, and the expected behaviour. That's the input that drives v1 scope graduation.

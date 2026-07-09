---
title: "Implementation scope and deferred features"
navLabel: "Implementation scope"
group: "pyric / storage"
section: "Explanation"
order: 126
---
# Implementation scope and deferred features

`pyric/storage` is a deliberate v1 scope. The scope is what the session-archive use case needed; anything beyond that is deferred. This page is the canonical list of what's not in the package and why.

## What's in scope

The bounded subset:

- `getStorageSandbox`, `getStorageProd`.
- `ref` with both overloads.
- `uploadBytes`, `uploadString`.
- `getBytes`, `getBlob`.
- `getMetadata`, `updateMetadata`.
- `listAll`.
- `deleteObject`.
- `parseStorageRules`, `evaluateStorageRules`.
- A Storage rules subset — service header, path matching, `read` / `write` allow verbs, request/resource bindings, standard operators.

End-to-end coverage: see `packages/pyric/test/storage/session-archive.test.ts`.

## What's deferred

### `getDownloadURL`

The v1 scope has no browser-renderable URL scheme for sandbox-stored blobs. If you need one, use `getBlob` and `URL.createObjectURL`:
```ts
const blob = await getBlob(ref(storage, 'sessions/n1'));
const url = URL.createObjectURL(blob);
// ... use url ...
URL.revokeObjectURL(url);  // free the memory when done
```
On the prod backend, the upstream `firebase/storage` package's `getDownloadURL` is available directly through its own import path.

### Paginated `list`

`list(ref, { maxResults, pageToken })` from the upstream API isn't implemented. `listAll` covers every v1 scope scenario; pagination is reserved for future compatibility (the `nextPageToken: undefined` field in `ListResult` is there for that day).

### `uploadBytesResumable`

Resumable uploads with pause/resume/progress are a substantial piece of code that didn't serve the use case. Synchronous `uploadBytes` is what the package ships.

### Admin SDK shape

A sibling `pyric/storage-admin` package could mirror `firebase-admin/storage` the way `pyric-admin` mirrors `firebase-admin/firestore`. Not built yet; not blocking the v1 scope.

### Storage emulator parity testing

We didn't run parity tests against the official Firebase Storage Emulator. The rules engine is verified against the engine spec; the data plane is verified against the documented API. Bit-for-bit comparison with the emulator is future work.

### Granular allow verbs

The upstream rules grammar supports `allow get`, `allow list`, `allow create`, `allow update`, `allow delete`. The v1 scope supports only `read` and `write`. The granular verbs would require splitting the rule's evaluation path per method, which the engine doesn't do today.

The parser explicitly rejects the granular forms so consumers don't accidentally write rules that would compile against production and silently behave differently in the sandbox.

### `request.time` and time-based rules

`request.time` is in the grammar but not yet plumbed through to the evaluator. Date-gated rules can't be expressed today.

### `matches()` / regex predicates

The upstream grammar supports regex matches on strings. Rare in practice for Storage rules; deferred.

### Rule function definitions
```
function isOwner() { return request.auth.uid == resource.metadata['owner']; }
```
Not parsed. Inline the predicate where you need it.

### Deep dotted access into `customMetadata`

`resource.metadata.sessionId` is a parse error. Use the bracket form: `resource.metadata['sessionId']`.

### Gated `listAll`

`listAll` enforces the rules engine (ST-B2). Firebase's `read` permission governs both download and list, and list is evaluated against the scanned prefix path — so `listAll` requires `read` on the listed folder. A `read` rule scoped to `match /sessions/{id}` does NOT grant list on `/sessions`; the folder needs its own read rule (the session-archive ruleset adds `match /sessions { allow read: if request.auth != null; }`). This matches prod: in real Firebase you'd hit the same requirement. With no rules configured, `listAll` is open-by-default like every other operation. (Granular `allow list` as a distinct verb is still deferred — the two-verb `read`/`write` model collapses get+list into `read`.)

### Cross-bucket isolation

The `bucket` option round-trips through metadata but doesn't actually partition data. v1 has a single implicit bucket. Real multi-bucket support is reserved for when a consumer needs it.

### Cloud Functions Storage triggers

Triggers on upload / delete are out of scope — they're not data-plane concerns. The closest analog would be a sandbox-side event channel; not built.

### Image transformations / Firebase Extensions

Not modelled. Production-only.

## How to know if your use case is in scope

Three questions:

1. **Is your operation in the in-scope list above?** If yes, it works.
2. **Does your rule use only the subset in [`Storage rules subset`](../pyric-storage-reference-rules-subset/)?** If yes, it'll parse and enforce correctly.
3. **Are you on a sandbox handle (IndexedDB), or a prod handle (real Cloud Storage)?** The sandbox-only options affect only the sandbox path.

If your answer to any is "no", check the deferred list. Often there's a workaround (e.g. `URL.createObjectURL` for `getDownloadURL`) or a different backend (prod for unbounded features).

## When to upgrade the v1 scope

The package will graduate from v1 scope to stable when consumers ask for the deferred features in concrete use cases. Until then, the scope reflects what was needed; expanding it speculatively would add surface that nobody runs through tests.

If you have a use case the v1 scope doesn't cover, file an issue with the operation, the rule, and the expected behaviour. That's the input that drives v1 scope graduation.

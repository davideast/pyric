---
title: Store files
navLabel: Store files
outcome: Upload, list, download, and delete files locally, with storage rules enforced in-process.
status: draft
---

# Store files

> **Experimental.** Storage works and is documented, but most of its behavior is not yet pinned to a recorded production observation the way Auth and Firestore are. Read [how we know it matches Firebase](../trust/how-we-know-it-matches-firebase.md) before you rely on it.

Files land in your sandbox the way documents do: locally, with rules deciding what gets in.

## Upload and download

```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getStorageSandbox, ref, uploadBytes, getBlob } from 'pyric/storage';

const sandbox = initializeSandbox();
const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }));

const bytes = new TextEncoder().encode(JSON.stringify({ task: 'build a notes app' }));
await uploadBytes(ref(storage, 'sessions/s1'), bytes, { contentType: 'application/json' });

const blob = await getBlob(ref(storage, 'sessions/s1'));
console.log(JSON.parse(await blob.text()));
```

`uploadString` covers text without the encoder, and `getBytes` returns an `ArrayBuffer` when you want raw bytes instead of a `Blob`. Under `pyric dev`, a served page's `firebase/storage` imports resolve to the sandbox's shared object store, so uploads show up across tabs like every other write. `pyric dev` enforces `storage.rules` the same as `firestore.rules` and `database.rules.json` — but unlike those two, storage rules load at server boot and don't hot-reload. Edit `storage.rules` and you need to restart the dev server to pick up the change.

## List and delete

```ts
import { listAll, deleteObject } from 'pyric/storage';

const listing = await listAll(ref(storage, 'sessions'));
console.log(listing.items.map((item) => item.name)); // ['s1']

await deleteObject(ref(storage, 'sessions/s1'));
```

## Metadata rides along

Set it at upload, read it back, patch it later:

```ts
import { getMetadata, updateMetadata } from 'pyric/storage';

await uploadBytes(ref(storage, 'sessions/s1'), bytes, {
  contentType: 'application/json',
  customMetadata: { sessionId: 's1', version: '1.0' },
});

const meta = await getMetadata(ref(storage, 'sessions/s1'));
console.log(meta.size, meta.customMetadata?.sessionId);

await updateMetadata(ref(storage, 'sessions/s1'), {
  customMetadata: { ...meta.customMetadata, version: '1.1' },
});
```

Two contracts worth knowing, both matching the upstream SDK:

- `updateMetadata` replaces the settable fields rather than merging. Fetch first and spread, as above.
- `customMetadata` is string-to-string, so numbers and objects need serializing.

## Enforce storage rules in-process

Pass rules when you configure the handle, and every operation evaluates against them, no deploy anywhere:

```ts
const RULES = `service firebase.storage {
  match /b/{bucket}/o {
    match /sessions/{id} {
      allow read: if request.auth != null;
      allow write: if request.auth != null
                   && (request.resource == null
                       || (request.resource.size < 10 * 1024 * 1024
                           && request.resource.contentType == 'application/json'));
    }
  }
}`;

const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), { rules: RULES });
```

An anonymous upload now throws `FirebaseError` with `storage/unauthenticated`. An 11 MiB payload throws `storage/unauthorized`, the signed-in-but-not-allowed code.

Notice the `request.resource == null` carve-out. `deleteObject` carries no payload, so without it every delete would fail the size check. The pattern is standard in production Storage rules, and it is enforced identically here.

One rule-shape gotcha carried over faithfully from production: `listAll` requires `read` on the listed folder itself. A rule scoped to `match /sessions/{id}` grants nothing on `/sessions`, so give the folder its own read rule.

## The boundaries, plainly

The v1 scope is deliberate. What is not in it:

- **No `getDownloadURL`.** For a renderable URL in dev, use `getBlob` and `URL.createObjectURL`. In production the upstream `firebase/storage` has the real one.
- **No resumable uploads.** `uploadBytesResumable`, with its pause and progress machinery, is deferred. `uploadBytes` and `uploadString` are the write path.
- **No paginated `list`.** `listAll` only.
- **`resource.timeCreated` / `resource.updated` aren't exposed on `resource`.** Everything else on `resource` and `request` — including `request.time`, `matches()`, rule functions, and the granular verbs (`get`, `list`, `create`, `update`, `delete`) — works.
- **One implicit bucket.** The `bucket` option round-trips through metadata but does not partition data.

Each of these fails loudly at the call site instead of drifting quietly.

## Where to go next

If the data is structured rather than binary, [which data service should I use?](./which-data-service.md) sorts it out. And [how we know it matches Firebase](../trust/how-we-know-it-matches-firebase.md) says exactly what experimental costs you.

---
title: "How to switch between sandbox and prod backends"
navLabel: "Switch backends"
group: "pyric / storage"
section: "How-to"
order: 146
---
# How to switch between sandbox and prod backends

`pyric/storage` has two entry points: `getStorageSandbox(target, options?)` and `getStorageProd(app, options?)`. Pick by where you need the data to land.

## Sandbox
```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getStorageSandbox, ref, uploadBytes } from 'pyric/storage';

const sandbox = initializeSandbox();
const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }));

await uploadBytes(ref(storage, 'sessions/n1'), bytes);
```
Backed by IndexedDB. Sub-millisecond per op. Browser-safe. Lifetime tied to the sandbox.

## Prod
```ts
import { initializeApp } from 'firebase/app';
import { getStorageProd, ref, uploadBytes } from 'pyric/storage';

const app = initializeApp({ /* config */ });
const storage = getStorageProd(app);

await uploadBytes(ref(storage, 'sessions/n1'), bytes);
```
Backed by `firebase/storage`. Network-bound. Operations against real Cloud Storage.

## What's identical

Once you have a `FirebaseStorage`, every other function in the package works against either:

- `ref(storage, path)`
- `uploadBytes(ref, data, metadata?)` / `uploadString(ref, value, format?, metadata?)`
- `getBytes(ref)` / `getBlob(ref)`
- `getMetadata(ref)` / `updateMetadata(ref, patch)`
- `listAll(ref)`
- `deleteObject(ref)`

The dispatch is hidden inside each function. Same call sites; the backend choice happens once.

## What only the sandbox does

- **`rules` option** at config time. Prod deploys rules separately, via `firebase deploy --only storage:rules` or `pyric-tools/deploy`'s control plane (when Storage admin support lands).
- **`dbName` option** for IndexedDB partition. Doesn't apply on prod.
- **Synchronous rule changes**. The sandbox enforces rules from the `rules` option immediately. Prod has propagation time.

## What only prod does

- **Real bucket isolation**. Multi-bucket scenarios work as expected.
- **`getDownloadURL`** when it's added to this package. It's deferred for the v1 scope.
- **Resumable uploads**, progress events. Deferred.
- **Storage triggers**, image transformations, Firebase Extensions. Out of scope.

## Both at once
```ts
const sandbox = initializeSandbox();
const sandboxStorage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }));

const app = initializeApp({ /* config */ });
const prodStorage = getStorageProd(app);

await uploadBytes(ref(sandboxStorage, 'sessions/n1'), bytes);
await uploadBytes(ref(prodStorage, 'sessions/n1'), bytes);
```
Two backends, two handles, one process. Sometimes useful for replication-style tests.

## Use it in code written against `firebase/storage`

To use `pyric/storage` in a project whose code imports `firebase/storage`, the rename targets the entry point only:
```diff
- import { getStorage, ref, uploadBytes } from 'firebase/storage';
+ import { getStorageProd as getStorage, ref, uploadBytes } from 'pyric/storage';
```
Application code that calls `getStorage(app)` keeps working. Tests can import `getStorageSandbox` separately.

Note that not every `firebase/storage` symbol is re-exported. See [Implementation scope and deferred features](../pyric-storage-explanation-implementation-scope/) for what's missing.

## Where to look next

- For the data and rules wiring, see [Enforce Storage rules](../pyric-storage-how-to-enforce-rules/).
- For why the prod entry has fewer options, see [`StorageOptions`](../pyric-storage-reference-storage-options/).

---
title: "How to use pyric/firestore in existing code"
navLabel: "Use in existing code"
group: "pyric / firestore"
section: "How-to"
order: 11004
---
# How to use `pyric/firestore` in existing code

Point an existing codebase at the sandbox by importing `pyric/firestore` where it imports `firebase/firestore`. Your Firestore code stays your Firestore code.

## Two import changes

The minimum change is two import edits.

### Before

```ts
import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  collection,
  query,
  where,
  onSnapshot,
} from 'firebase/firestore';
```

### After

```ts
import { initializeApp } from 'firebase/app';   // unchanged
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  collection,
  query,
  where,
  onSnapshot,
} from 'pyric/firestore';
```

The function names and signatures match. Application code calling these functions does not change.

## What is identical

- All free functions: `doc`, `collection`, `getDoc`, `setDoc`, `updateDoc`, `deleteDoc`, `addDoc`, `query`, `where`, `or`, `and`, `orderBy`, `limit`, `limitToLast`, `startAt`, `startAfter`, `endAt`, `endBefore`, `getDocs`, `getCountFromServer`, `getAggregateFromServer`, `count`, `sum`, `average`, `onSnapshot`, `runTransaction`, `writeBatch`, `refEqual`, `queryEqual`, `snapshotEqual`, `connectFirestoreEmulator`.
- All sentinels: `serverTimestamp`, `increment`, `arrayUnion`, `arrayRemove`, `deleteField`, `FieldValue`, `Timestamp`.
- All types: `Firestore`, `DocumentReference`, `CollectionReference`, `Query`, `DocumentSnapshot`, `QueryDocumentSnapshot`, `QuerySnapshot`, `DocumentChange`, `DocumentChangeType`, `SnapshotMetadata`, `WriteBatch`, `Transaction`, `Unsubscribe`.
- Converters: `withConverter`.

If your existing code imports a name from `firebase/firestore` and it's not in the list, file an issue. The surface should be complete.

## What is different

### `Firestore` is opaque

`pyric/firestore`'s `Firestore` is `{ readonly [TARGET_SYMBOL]: Target }`. Don't read or modify properties on it directly. Pass it to free functions instead. Application code that only calls `getFirestore(app)` and forwards the handle is fine.

### Sandbox-only operations exist

`sandbox.setRules`, `sandbox.seedDocuments`, `sandbox.snapshotState` are not in `firebase/firestore`. They throw `failed-precondition` on prod handles, so adding `pyric/firestore` to a codebase that only ever calls `getFirestore(app)` doesn't risk accidental use.

### Metadata on sandbox

`snap.metadata.fromCache` and `snap.metadata.hasPendingWrites` are always `false` on the sandbox backend. Code that branches on these flags will see one branch only when running against the sandbox.

This matters for code that displays "syncing..." or "offline" UI. The branches don't fire in tests. That's not a regression, only an inert path.

### Listener semantics

Sandbox listeners re-evaluate when rules change (via `sandbox.setRules`). Prod listeners don't; they keep their original rule context until detached and re-attached. Tests that exercise this difference need to choose which behaviour they want to assert.

## Side-by-side imports

Two strategies for codebases that want both surfaces at once.

### Strategy 1: aliased import

```ts
import * as upstream from 'firebase/firestore';
import { getFirestore, doc, setDoc } from 'pyric/firestore';

const upstreamDb = upstream.getFirestore(app);  // unchanged upstream code path
const wrapped = getFirestore(app);              // new path through pyric/firestore
```

### Strategy 2: module-level swap

Swap one file at a time. Each file imports exclusively from one source. Less mixing, less risk of confusion.

## What to do about the bundle

Adding `pyric/firestore` adds the package's own surface plus `pyric/sandbox` and `pyric-admin` (transitively). The prod-backend code path still bottoms out at `firebase/firestore`, so the upstream SDK is still in the bundle.

For browser bundles where size matters, the bundler will tree-shake the sandbox-side code if your build only ever reaches the prod backend. Modern bundlers handle this correctly, but it's worth confirming with a bundle analysis for production builds.

## Where to look next

- For the choice between sandbox and prod at runtime, see [Pick a backend at init time](../pyric-firestore-how-to-pick-a-backend/).
- For the two-backend design rationale, see [Why two backends behind one surface](../pyric-firestore-explanation-two-backends-one-surface/).

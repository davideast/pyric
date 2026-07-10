---
title: "pyric-admin"
navLabel: "Overview"
group: "pyric-admin / firestore"
section: ""
order: 165
---
# `pyric-admin`

Admin-SDK-shaped Firestore adapter for the Pyric sandbox. Mirrors `firebase-admin/firestore` (`db.collection(p).doc(p).get()`, `db.batch()`, `db.runTransaction()`) over `pyric/sandbox`'s in-process substrate. Streaming reads are covered too: a production-shaped `onSnapshot` ships as both a free function and a chainable `.onSnapshot(...)` method on refs and queries.

Use this package when your production code uses `firebase-admin/firestore` (Node services, Cloud Functions). For the modular Web SDK shape, use [`pyric/firestore`](../pyric-admin-firestore/) instead.

## Install
```bash
bun add pyric-admin pyric/sandbox
# or
npm install pyric-admin pyric/sandbox
```
## A 30-second example
```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric-admin';

const sandbox = initializeSandbox();
const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));

db.setRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read, write: if request.auth != null;
    }
  }
}`);

await db.collection('notes').doc('n1').set({ title: 'hello' });
const snap = await db.collection('notes').doc('n1').get();
console.log(snap.exists, snap.data());
```
Alongside the production-shaped surface, the `db` handle carries three sandbox-only methods: `setRules(src)`, `seed({ documents })`, and `snapshot()`. The package also re-exports the foundation and production-shaped types (`SandboxError`, `FieldValue`, `Timestamp`, the snapshot types) so consumers can import everything from `pyric-admin`.

## Where to go next

- Tutorials: guided lessons.
- How-to guides: task-focused recipes.
- Reference: exact signatures and types.
- Explanation: why the API is shaped this way.

## Position in the Pyric stack

`pyric-admin` is a **data-plane adapter**. It depends on `pyric/sandbox` for the substrate and exposes a Firebase-Admin-SDK-shaped surface. Sibling package `pyric/firestore` provides the same substrate access through the modular Web SDK shape. Both can run side-by-side against one sandbox.

## Licence

Same as the parent workspace.

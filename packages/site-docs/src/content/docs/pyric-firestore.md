---
title: "pyric/firestore"
navLabel: "Overview"
group: "pyric / firestore"
section: ""
order: 77
---
# `pyric/firestore`

Modular Web SDK Firestore adapter for the Pyric sandbox. Mirrors `firebase/firestore`'s tree-shakable shape (`getDoc`, `setDoc`, `query`, `where`, `onSnapshot`, `runTransaction`) with two backends picked at init time:

- **Sandbox** (`pyric/sandbox` via `pyric-admin`): in-process, browser-safe, no network.
- **Prod** (`firebase/firestore`): the real Firebase Firestore.

Same call sites, two different backends. Swap by changing what you pass to `getFirestore`.

## Install
```bash
bun add pyric/firestore pyric/sandbox firebase
# or
npm install pyric/firestore pyric/sandbox firebase
```
`firebase` is required because the prod backend dispatches to it. Bundlers tree-shake away the prod path when only the sandbox backend is reached.

## A 30-second example

Sandbox backend:
```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore, doc, setDoc, getDoc } from 'pyric/firestore';

const sandbox = initializeSandbox();
const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));

await setDoc(doc(db, 'notes', 'n1'), { title: 'hello' });
const snap = await getDoc(doc(db, 'notes', 'n1'));
console.log(snap.exists, snap.data());
```
> On the sandbox backend `snap.exists` is a boolean property; on the prod backend it is a method (`snap.exists()`), matching `firebase/firestore`. Code that must run unchanged on both backends should normalise with `typeof snap.exists === 'function' ? snap.exists() : snap.exists`.

Prod backend, the same code with a different `getFirestore` argument:
```ts
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc, getDoc } from 'pyric/firestore';

const app = initializeApp({ /* your Firebase config */ });
const db = getFirestore(app);

await setDoc(doc(db, 'notes', 'n1'), { title: 'hello' });
const snap = await getDoc(doc(db, 'notes', 'n1'));
```
Every Firestore call between `getFirestore(...)` and the next swap is identical across backends.

The package mirrors the full modular surface: reads and writes, composite filters (`or`/`and`), `collectionGroup`, aggregates (`count`/`sum`/`average`), cursor pagination, `onSnapshot`, `runTransaction`/`writeBatch`, `withConverter`, and the sentinel set (`serverTimestamp`, `increment`, `arrayUnion`, …).

## Sandbox lifecycle and tool factories

Two named exports sit alongside the production-shaped surface:

- `sandbox`, the sandbox-only lifecycle object: `sandbox.setRules(db, src)`, `sandbox.seedDocuments(db, docs)`, `sandbox.snapshotState(db)`. These throw on a prod-backed `db`.
- `createFirestoreDataTools`, a `ToolHandler[]` factory that wraps the data-plane operations as agent tools for an `@inbrowser/agent` registry.

## Where to go next

- Tutorials: guided lessons.
- How-to guides: task-focused recipes.
- Reference: exact signatures.
- Explanation: design rationale.

## Position in the Pyric stack

`pyric/firestore` is the **modular-shape data-plane adapter**. Sibling to `pyric-admin` (admin-shape). Both run on top of `pyric/sandbox`. Rules tooling lives in `pyric/rules`. Deploy primitives live in `pyric-tools/deploy`.

## Licence

Same as the parent workspace.

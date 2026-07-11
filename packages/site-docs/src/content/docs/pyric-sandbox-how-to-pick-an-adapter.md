---
title: "How to pick between pyric-admin and pyric/firestore"
navLabel: "Pick an adapter"
group: "pyric / sandbox"
section: "How-to"
order: 124
---
# How to pick between `pyric-admin` and `pyric/firestore`

Two adapter packages sit on top of `pyric/sandbox`. Both expose Firestore. They look the same from a distance and shape differently up close. This guide helps you pick.

## The two surfaces

**`pyric-admin`** mirrors `firebase-admin/firestore`: chainable, class-shaped.
```ts
import { getFirestore } from 'pyric-admin';

const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));

await db.collection('notes').doc('n1').set({ title: 'hello' });
const snap = await db.collection('notes').where('owner', '==', 'alice').get();
await db.runTransaction(async (tx) => { /* ... */ });
```
**`pyric/firestore`** mirrors `firebase/firestore` (the modular Web SDK): function-shaped, tree-shakable.
```ts
import { initializeFirestore, getDoc, setDoc, doc, query, where, getDocs } from 'pyric/firestore';

const db = initializeFirestore(sandbox.withAuth({ uid: 'alice' }));

await setDoc(doc(db, 'notes', 'n1'), { title: 'hello' });
const q = query(db.collection('notes'), where('owner', '==', 'alice'));
const snap = await getDocs(q);
```
Both back onto the same `LocalEnvironment` under the hood. The runtime behaviour is identical; only the API shape differs.

## Decision matrix

| Pick | When |
|---|---|
| `pyric-admin` | Your production code uses `firebase-admin/firestore` (Node services, Cloud Functions). |
| `pyric-admin` | You prefer chainable / OO-style APIs. |
| `pyric-admin` | You're writing tests that need to mirror admin SDK semantics. |
| `pyric/firestore` | Your production code uses `firebase/firestore` (web app, React Native). |
| `pyric/firestore` | You want tree-shaking; the modular SDK is designed for it. |
| `pyric/firestore` | You're sharing test code with browser-side components that import `firebase/firestore`. |

## Rule of thumb

The right choice is whatever shape your *production* code already uses. The sandbox is a development tool, and keeping the test code's surface identical to production avoids translation bugs.

If you're working in both environments (a hybrid app, a Cloud Functions backend with a web frontend), use both. They share the same sandbox cleanly:
```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore as getAdmin } from 'pyric-admin';
import { initializeFirestore } from 'pyric/firestore';

const sandbox = initializeSandbox();

const adminDb = getAdmin(sandbox.withAuth({ uid: 'backend' }));
const webDb = initializeFirestore(sandbox.withAuth({ uid: 'alice' }));

// Both see the same data.
await adminDb.collection('notes').doc('n1').set({ title: 'from backend' });
const snap = await getDoc(doc(webDb, 'notes', 'n1'));
console.log(snap.data());  // { title: 'from backend' }
```
## Can I use both inside one test?

Yes. Each adapter is a thin wrapper over `SandboxContext` and `LocalEnvironment`. The two adapters don't conflict, and their objects don't interfere with each other.

The only thing to remember: `setRules` exists only on `pyric-admin`'s handle (it's an admin-shaped operation). Use the admin handle to deploy rules, then both handles see them.

## Where to look next

- For a hands-on intro that uses `pyric-admin`, see [Your first sandbox session](../pyric-sandbox-tutorials-01-your-first-sandbox-session/).
- For the rationale behind the two-adapter design, see [Why service adapters live in sibling packages](../pyric-sandbox-explanation-why-adapters-are-siblings/).

---
title: "Write a sandbox-backed demo"
navLabel: "Sandbox-backed demo"
group: "pyric / firestore"
section: "Tutorials"
order: 75
---
# Write a sandbox-backed demo

Build a tiny notes app with `pyric/firestore` against the sandbox backend. By the end you'll have set rules, seeded data, written, read, watched a query, and seen a denial, all in-process.

## Set up
```bash
mkdir notes-demo && cd notes-demo
bun init -y
bun add pyric/sandbox pyric/firestore
```
## Step 1: Boot the sandbox and a Firestore handle

Create `demo.ts`:
```ts
import { initializeSandbox, SandboxError } from 'pyric/sandbox';
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  collection,
  query,
  where,
  onSnapshot,
  sandbox as sandboxOps,
} from 'pyric/firestore';

const sandbox = initializeSandbox();
const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));

console.log('Sandbox-backed Firestore ready.');
```
Run with `bun run demo.ts`. You should see the line and nothing else.

## Step 2: Deploy rules
```ts
const lint = sandboxOps.setRules(db, `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read: if request.auth != null;
      allow write: if request.auth.uid == request.resource.data.ownerId;
    }
  }
}`);

if (lint.warnings.some((w) => w.severity === 'error')) {
  throw new Error('rules failed to lint');
}
console.log('Rules deployed.');
```
We use `sandboxOps.setRules` (aliased from `sandbox` on import to avoid colliding with the local `sandbox` variable). Lint warnings are visible. Surface them if any are errors.

## Step 3: Write and read
```ts
await setDoc(doc(db, 'notes', 'n1'), {
  ownerId: 'alice',
  title: 'My first note',
});

const snap = await getDoc(doc(db, 'notes', 'n1'));
console.log('Read back:', snap.data());
```
Output: `Read back: { ownerId: "alice", title: "My first note" }`.

## Step 4: Query
```ts
import { getDocs } from 'pyric/firestore';

await setDoc(doc(db, 'notes', 'n2'), {
  ownerId: 'alice',
  title: 'Second note',
  archived: true,
});
await setDoc(doc(db, 'notes', 'n3'), {
  ownerId: 'alice',
  title: 'Third note',
});

const q = query(
  collection(db, 'notes'),
  where('archived', '!=', true),  // null and false both qualify
);
const results = await getDocs(q);
console.log(`Found ${results.size} unarchived notes:`);
results.forEach((d) => console.log(' ', d.id, d.data().title));
```
Output:
```
Found 2 unarchived notes:
  n1 My first note
  n3 Third note
```
The query runs against the sandbox's `LocalEnvironment`, no network. The filter evaluates correctly on `getDocs`.

## Step 5: Watch with `onSnapshot`
```ts
const changes: string[] = [];
const unsubscribe = onSnapshot(
  query(collection(db, 'notes')),
  (snap) => {
    for (const change of snap.docChanges()) {
      changes.push(`${change.type} ${change.doc.id}`);
    }
  },
);

await setDoc(doc(db, 'notes', 'n4'), {
  ownerId: 'alice',
  title: 'Watched note',
});

await new Promise((resolve) => setTimeout(resolve, 10));  // let the listener fire

console.log('Saw changes:', changes);
unsubscribe();
```
Output something like:
```
Saw changes: [
  'added n1', 'added n2', 'added n3',  // initial fire
  'added n4',                          // write
]
```
## Step 6: Try a denied write
```ts
const bob = getFirestore(sandbox.withAuth({ uid: 'bob' }));

try {
  await setDoc(doc(bob, 'notes', 'b1'), {
    ownerId: 'alice',  // Bob lies about ownership
    title: 'tamper',
  });
} catch (e) {
  if (e instanceof SandboxError && e.code === 'permission-denied') {
    console.log('Bob was denied:', e.denialContext?.reasons?.[0]);
  }
}
```
Output: `Bob was denied: Rule #1 (write) → deny`. The write rule checks `request.auth.uid == request.resource.data.ownerId`. Bob's UID doesn't match Alice's, so the rule denies and `SandboxError` surfaces with full context.

## Step 7: Dump the state
```ts
console.log('Final state:', sandboxOps.snapshotState(db));
```
Every stored document, including Alice's writes and excluding Bob's denied one.

## What you have learned

- `getFirestore(sandbox.withAuth(...))` produces a sandbox-backed handle.
- The function shape (`doc`, `setDoc`, `getDoc`, `onSnapshot`) matches `firebase/firestore`.
- `sandbox.setRules`, `sandbox.seedDocuments`, and `sandbox.snapshotState` are sandbox-only and live under a namespace export.
- `SandboxError` with `denialContext` is the same shape you see from `pyric-admin` and from `Sandbox.onDenial`.

## What to do next

The same code runs against the prod backend with one line changed. Follow [Swap the demo to the prod backend](../pyric-firestore-tutorials-02-swap-to-prod-backend/) to see how.

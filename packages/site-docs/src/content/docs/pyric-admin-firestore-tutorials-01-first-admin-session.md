---
title: "Your first admin-shaped Firestore session"
navLabel: "First admin session"
group: "pyric-admin / firestore"
section: "Tutorials"
order: 170
---
# Your first admin-shaped Firestore session

In this tutorial you will use `pyric-admin` to write, read, batch, transact, and watch documents in a sandbox. By the end you will have seen every piece of the surface in action.

## Before you start
```bash
mkdir admin-tutorial && cd admin-tutorial
bun init -y
bun add pyric/sandbox pyric-admin
```
## Step 1: Boot the sandbox and deploy rules

Create `session.ts`:
```ts
import { initializeSandbox, SandboxError } from 'pyric/sandbox';
import { getFirestore, FieldValue, onSnapshot } from 'pyric-admin';

const sandbox = initializeSandbox();

const adminCtx = sandbox.withAuth({ uid: 'admin', token: { admin: true } });
const adminDb = getFirestore(adminCtx);

const lint = adminDb.setRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read: if request.auth != null;
      allow create: if request.auth.uid == request.resource.data.ownerId;
      allow update, delete:
        if request.auth.uid == resource.data.ownerId;
    }
    match /counters/{id} {
      allow read, write: if request.auth.token.admin == true;
    }
  }
}`);

if (lint.warnings.some((w) => w.severity === 'error')) {
  throw new Error('rules failed to lint');
}
console.log('Rules deployed.');
```
Run with `bun run session.ts`. You should see `Rules deployed.` and no warnings.

## Step 2: Write as one user
```ts
const aliceCtx = sandbox.withAuth({ uid: 'alice' });
const aliceDb = getFirestore(aliceCtx);

await aliceDb.collection('notes').doc('n1').set({
  ownerId: 'alice',
  title: 'My first note',
});

const snap = await aliceDb.collection('notes').doc('n1').get();
console.log('Alice reads back:', snap.data());
```
Output:
```
Alice reads back: { ownerId: "alice", title: "My first note" }
```
## Step 3: Try a denied write
```ts
const bobDb = getFirestore(sandbox.withAuth({ uid: 'bob' }));

try {
  await bobDb.collection('notes').doc('n1').update({ title: 'Bob hijacks' });
} catch (e) {
  if (e instanceof SandboxError && e.code === 'permission-denied') {
    console.log('Bob denied:', e.denialContext?.reasons?.[0]);
  }
}
```
Bob is not Alice; the update rule requires `request.auth.uid == resource.data.ownerId`. The denial fires with full context.

## Step 4: Run a transaction
```ts
const result = await adminDb.runTransaction(async (tx) => {
  const counterRef = adminDb.doc('counters/main');
  const snap = await tx.get(counterRef);
  const current = snap.exists ? snap.data().count : 0;
  tx.set(counterRef, { count: current + 1 });
  return current + 1;
});

console.log('Counter is now:', result);
```
Output: `Counter is now: 1`. Run the file again and it becomes 2 (the sandbox isn't reset between runs of the script).

## Step 5: Write a batch
```ts
const batch = adminDb.batch();
batch.set(adminDb.doc('notes/n2'), { ownerId: 'alice', title: 'batched A' });
batch.set(adminDb.doc('notes/n3'), { ownerId: 'alice', title: 'batched B' });
batch.update(adminDb.doc('counters/main'), { count: FieldValue.increment(2) });
await batch.commit();

console.log('After batch:', adminDb.snapshot());
```
The three operations either all succeed or all fail. `FieldValue.increment(2)` resolves against the pre-batch state.

## Step 6: Watch with `onSnapshot`
```ts
const changes: any[] = [];
const unsubscribe = onSnapshot(aliceDb.collection('notes'), (snap) => {
  for (const change of snap.docChanges()) {
    changes.push(`${change.type} ${change.doc.id}`);
  }
});

await aliceDb.collection('notes').doc('n4').set({ ownerId: 'alice', title: 'live' });
await aliceDb.collection('notes').doc('n1').update({ title: 'updated' });

console.log('Saw changes:', changes);
unsubscribe();
```
Output:
```
Saw changes: [
  'added n1', 'added n2', 'added n3',  // initial fire
  'added n4',                          // write
  'modified n1',                        // update
]
```
The listener fires once for the initial state, then again per write. Don't forget to `unsubscribe`: without it, a script holding the listener forever keeps the sandbox alive in memory.

## Step 7: Snapshot the world
```ts
console.log('Full state:');
console.log(adminDb.snapshot());
```
Every document, every path. Use this for forensic dumps when a test fails.

## What you have learned

- `getFirestore(ctx)` is the entry point. Every operation runs under `ctx.auth`.
- `setRules`, `seed`, `snapshot` are the sandbox-only methods on the handle.
- The chainable production-shaped surface (`collection`, `doc`, `batch`, `runTransaction`) works as in `firebase-admin/firestore`.
- `onSnapshot` mirrors the Web SDK's function form (preferred over `ref.onSnapshot(...)` for portability across `pyric-admin` and `pyric/firestore`).
- `SandboxError` carries `denialContext` for `permission-denied`.

## What to do next

- Pick between this package and `pyric/firestore`: see [Pick between `pyric-admin` and `pyric/firestore`](../pyric-sandbox-how-to-pick-an-adapter/).
- Wire denials into a UI: see [Translate denials with `denialContext`](../pyric-admin-firestore-how-to-translate-denials/).
- Use the sandbox in a real test suite: see Use the sandbox in a test harness.

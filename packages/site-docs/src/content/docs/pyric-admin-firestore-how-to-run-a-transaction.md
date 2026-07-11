---
title: "How to run a transaction"
navLabel: "Run a transaction"
group: "pyric-admin / firestore"
section: "How-to"
order: 19003
---
# How to run a transaction

This guide shows you how to use `runTransaction` on a sandbox Firestore handle.

## The shape
```ts
import { getFirestore } from 'pyric-admin';

const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));

const result = await db.runTransaction(async (tx) => {
  const snap = await tx.get(db.doc('counters/main'));
  const current = snap.exists ? snap.data().count : 0;
  tx.set(db.doc('counters/main'), { count: current + 1 });
  return current + 1;
});
```
The callback receives a `Transaction` object with `.get`, `.getAll`, `.set`, `.update`, `.delete`, `.create`. All reads must happen before any writes: read-after-write inside a tx throws `'failed-precondition'`.

## Read tracking

The sandbox tracks every doc the callback reads. On commit:

- If any read doc was written by anyone else between the read and the commit, the transaction would (in production) retry. The sandbox is synchronous, so this can't actually happen, but reads are still recorded for diagnostic value.
- If the callback itself reads a doc after writing to it, the second read throws `'failed-precondition'`. This matches production's read-after-write rule.
- If the callback writes to a doc and then deletes the same doc within the same tx, the simulator handles the ordering correctly.

The recorded reads are available on the event log via `getInternalEnv(sandbox).getEventLog().getEvents()`: each transaction event carries a `reads` array.

## Aborted transactions

If the callback throws, the transaction is aborted: no writes are applied, the event log records the abort with the thrown error, and the original error re-throws to the caller:
```ts
try {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(db.doc('counters/main'));
    if (!snap.exists) throw new Error('counter missing');
    tx.set(db.doc('counters/main'), { count: snap.data().count + 1 });
  });
} catch (e) {
  console.error('Transaction aborted:', e.message);
}
```
Aborted transactions are **not undoable**. Popping one as an undo step would skip a real prior write, so the sandbox refuses to treat them as undoable events.

## Denied operations inside a transaction

If a `tx.set` would deny under the current rules, the transaction aborts with `SandboxError('permission-denied')`. The `denialContext` is populated with the request/resource shapes for the denied operation, matching how a single-operation denial looks.

## Cross-context transactions are not allowed

A transaction's auth is the registering context's auth, captured at `runTransaction` call time. You cannot pass per-call auth or switch identity mid-transaction. To act as a different user, derive a different context:
```ts
const adminDb = getFirestore(sandbox.withAuth({ uid: 'admin', token: { admin: true } }));
await adminDb.runTransaction(async (tx) => { /* runs as admin */ });
```
## When `runTransaction` is overkill

For single-doc operations with no read dependency, plain `set` / `update` / `delete` is fine. Reach for `runTransaction` when:

- You need to read-then-write on the same document atomically.
- You need to write across multiple documents that depend on each other's values.
- You want production-shaped read tracking in your event log.

For multi-doc writes that don't need read-then-write semantics, use a `WriteBatch` instead. See [Write a batch](../pyric-admin-firestore-how-to-write-a-batch/).

## Where to look next

- For the production-shaped `Transaction` API, see the [Firebase admin SDK docs](https://firebase.google.com/docs/reference/admin/node/firebase-admin.firestore.transaction).
- For the substrate's read-tracking behaviour, see [`pyric/sandbox`'s internal protocol](../pyric-sandbox-reference-internal-protocol/).

---
title: "How to run a transaction"
navLabel: "Run a transaction"
group: "pyric / firestore"
section: "How-to"
order: 80
---
# How to run a transaction

Read a document and write based on its current value, atomically, with `runTransaction`. It works the same against either backend.

## The shape
```ts
import { runTransaction, doc } from 'pyric/firestore';

const result = await runTransaction(db, async (tx) => {
  const ref = doc(db, 'counters', 'main');
  const snap = await tx.get(ref);
  const current = snap.exists() ? snap.data().count : 0;
  tx.set(ref, { count: current + 1 });
  return current + 1;
});

console.log('Counter is now:', result);
```
`runTransaction` is a free function in the modular SDK shape; the admin shape puts it on the handle as `db.runTransaction(...)`. The first argument is the `Firestore` handle, the second is your async callback.

## All reads before any writes

Inside the callback, every read must come before every write. Read-after-write throws `'failed-precondition'`. This rule exists in production (because the engine retries on conflict) and the sandbox enforces it for parity.

## Aborts

If the callback throws, the transaction aborts: no writes apply, the original error re-throws.
```ts
try {
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(doc(db, 'counters', 'main'));
    if (!snap.exists()) throw new Error('counter not initialised');
    tx.set(doc(db, 'counters', 'main'), { count: snap.data().count + 1 });
  });
} catch (e) {
  console.error('Aborted:', e.message);
}
```
On sandbox, aborts are not undoable: they had no effect, so popping them as undo steps would skip a real prior write.

## Denied operations inside

If a `tx.set` would deny under the current rules, the transaction aborts with `SandboxError('permission-denied')` on the sandbox backend (or `FirebaseError('firestore/permission-denied')` on prod). The `denialContext` is populated on the sandbox side.

## When to use a transaction or a batch

- **Transaction**: you need to read a doc and write based on its current value.
- **Batch**: you have multiple writes that don't depend on current state.

For multi-doc writes without read dependency, `writeBatch(db)` is cheaper and reads more clearly.

## Where to look next

- For batch writes, see [`writeBatch`](https://firebase.google.com/docs/reference/js/firestore_#writebatch) in the upstream Web SDK reference.
- For read-after-write enforcement on the sandbox, see [Public API](../pyric-firestore-reference-api/#batches-and-transactions).

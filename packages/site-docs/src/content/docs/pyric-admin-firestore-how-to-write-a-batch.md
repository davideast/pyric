---
title: "How to write a batch"
navLabel: "Write a batch"
group: "pyric-admin / firestore"
section: "How-to"
order: 166
---
# How to write a batch

This guide shows you how to use `WriteBatch` for atomic multi-document writes.

## The shape
```ts
const batch = db.batch();
batch.set(db.doc('notes/n1'), { ownerId: 'alice', title: 'first' });
batch.set(db.doc('notes/n2'), { ownerId: 'alice', title: 'second' });
batch.update(db.doc('users/alice'), { noteCount: FieldValue.increment(2) });
await batch.commit();
```
All three operations either succeed together or fail together. If the rule denies any one of them, the whole batch is rejected: no partial writes.

## What batches can do

- `batch.set(ref, data)`: create or replace.
- `batch.set(ref, data, { merge: true })`: recursive merge.
- `batch.update(ref, partial)`: patch top-level fields; dot-paths supported for nested map updates.
- `batch.delete(ref)`: delete the document.

You cannot read inside a batch. Reads need a transaction.

## When to reach for a batch vs a transaction

- **Batch**: writes only, atomic, no dependency on current state.
- **Transaction**: read-then-write, dependent on current state, retries on conflict (in production; sandbox is synchronous).

If your write doesn't depend on the doc's current data, use a batch. It's cheaper and the call site is clearer.

## Denied operations

If any operation in the batch would deny under the current rules, `commit` throws `SandboxError('permission-denied')` with the `denialContext` for the first denying operation. The event log records the batch attempt as denied; no operations land.
```ts
try {
  await batch.commit();
} catch (e) {
  if (e instanceof SandboxError && e.code === 'permission-denied') {
    console.error('Batch denied:', e.denialContext?.request?.path);
  }
}
```
## Field-value sentinels in batches

`FieldValue.serverTimestamp()`, `FieldValue.increment(n)`, `FieldValue.arrayUnion(...)`, `FieldValue.arrayRemove(...)`, and `FieldValue.delete()` all work in batches. The sandbox resolves them against the pre-batch state when computing the post-state:
```ts
const batch = db.batch();
batch.update(db.doc('counters/main'), {
  count: FieldValue.increment(1),
  lastSeen: FieldValue.serverTimestamp(),
});
await batch.commit();
```
`request.resource.data.count` in the rule's view is the resolved post-batch value, not the sentinel itself.

## Order matters within the batch

The batch applies its operations in the order they were added. Two operations on the same document inside one batch end up with the second one's effect: the first is overwritten before the batch commits. This matches production behaviour.

## What happens after `commit`

The `WriteBatch` instance is single-use. Calling `.commit()` a second time throws. Build a new batch via `db.batch()` for each transaction-scoped operation.

## Where to look next

- For multi-doc writes that need to read first, see [Run a transaction](../pyric-admin-firestore-how-to-run-a-transaction/).
- For the production-shaped `WriteBatch` API, see the [Firebase admin SDK docs](https://firebase.google.com/docs/reference/admin/node/firebase-admin.firestore.writebatch).

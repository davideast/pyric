---
title: "How to use onSnapshot to watch a doc or query"
navLabel: "Use onSnapshot"
group: "pyric-admin / firestore"
section: "How-to"
order: 174
---
# How to use `onSnapshot` to watch a doc or query

This guide shows you how to register a snapshot listener and react to changes.

## Watch a single document
```ts
import { onSnapshot, type DocumentSnapshot } from 'pyric-admin';

const unsubscribe = onSnapshot(db.doc('notes/n1'), (snap: DocumentSnapshot) => {
  if (snap.exists) {
    console.log('Current data:', snap.data());
  } else {
    console.log('Doc was deleted or never existed');
  }
});

// ... later
unsubscribe();
```
The callback fires immediately with the initial snapshot, then again every time the document changes (write, delete, or rule re-evaluation after `setRules`).

## Watch a query
```ts
import { onSnapshot, type QuerySnapshot } from 'pyric-admin';

const q = db.collection('notes').where('ownerId', '==', 'alice');
const unsubscribe = onSnapshot(q, (snap: QuerySnapshot) => {
  for (const change of snap.docChanges()) {
    console.log(change.type, change.doc.id, change.doc.data());
  }
});
```
`docChanges()` returns `added` / `modified` / `removed` events. On the initial fire, every matching document is reported as `added`.

## Use the observer form

The Web-SDK-shaped observer is convenient when you want all three handlers:
```ts
const unsubscribe = onSnapshot(db.doc('notes/n1'), {
  next: (snap) => console.log(snap.data()),
  error: (err) => console.error('listener died:', err),
  // complete is accepted but never fires — local stream has no terminal state.
});
```
## Handle stream errors

When a listener is silently terminated by a rule denial (most commonly during re-evaluation after a `setRules`), the `error` handler fires once and the listener stops:
```ts
onSnapshot(db.doc('locked-by-rules/x'), {
  next: (snap) => render(snap.data()),
  error: (err) => render(`Error: ${err.message}`),
});
```
Once-per-stream: after `error` fires, no further `next` or `error` callbacks happen on this listener. To resume watching, register a new listener.

For host-level error handling without each listener registering its own callback, subscribe to `sandbox.onSnapshotError(...)`. See Observe denials and stream errors in `pyric/sandbox`.

## Clean up in React `useEffect`
```ts
useEffect(() => {
  const unsubscribe = onSnapshot(db.doc('notes/n1'), (snap) => {
    setNote(snap.data() ?? null);
  });
  return unsubscribe;
}, []);
```
Returning `unsubscribe` from the effect tells React to call it when the component unmounts or the effect re-runs. Without the cleanup, a re-render registers a fresh listener and the old one stays alive until the sandbox is reset.

## Why `metadata.fromCache` is always `false`

`SnapshotMetadata` is part of the Web-SDK shape: `metadata.fromCache` and `metadata.hasPendingWrites`. The sandbox has neither a cache nor a pending-writes window (every fire is fresh, every write is synchronous), so both fields are always `false`.

If your production code branches on these flags, the sandbox's behaviour is conservatively "always fresh, never pending". Tests that depend on the branches firing differently need the emulator or live Firestore.

## Where to look next

- For the full overload list, see [`onSnapshot` overloads](../pyric-admin-firestore-reference-onsnapshot/).
- For listener re-evaluation when rules change, see [Listener re-evaluation on `deployRules`](../pyric-sandbox-explanation-listener-re-evaluation/).

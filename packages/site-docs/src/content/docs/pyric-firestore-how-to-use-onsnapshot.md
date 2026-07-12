---
title: "How to use onSnapshot"
navLabel: "Use onSnapshot"
group: "pyric / firestore"
section: "How-to"
order: 12007
---
# How to use `onSnapshot`

Keep your UI live by registering snapshot listeners on documents and queries, in the modular Web SDK shape.

## Watch a document

```ts
import { onSnapshot, doc, type DocumentSnapshot } from 'pyric/firestore';

const unsubscribe = onSnapshot(doc(db, 'notes', 'n1'), (snap: DocumentSnapshot) => {
  if (snap.exists()) {
    console.log('Data:', snap.data());
  } else {
    console.log('Document deleted or never existed');
  }
});

// ... later
unsubscribe();
```

## Watch a query

```ts
import { onSnapshot, collection, query, where, type QuerySnapshot } from 'pyric/firestore';

const q = query(collection(db, 'notes'), where('ownerId', '==', 'alice'));

const unsubscribe = onSnapshot(q, (snap: QuerySnapshot) => {
  for (const change of snap.docChanges()) {
    console.log(change.type, change.doc.id, change.doc.data());
  }
});
```

`docChanges()` returns `added` / `modified` / `removed` events. On the initial fire, every matching doc is `added`.

## Observer form

The Web-SDK-shaped observer takes any subset of three handlers:

```ts
onSnapshot(doc(db, 'notes', 'n1'), {
  next: (snap) => render(snap.data()),
  error: (err) => console.error('listener died:', err),
  // complete is accepted but never fires.
});
```

## React `useEffect` cleanup

```ts
useEffect(() => {
  const unsubscribe = onSnapshot(doc(db, 'notes', 'n1'), (snap) => {
    setNote(snap.data() ?? null);
  });
  return unsubscribe;
}, []);
```

Returning the unsubscribe from the effect tells React to call it on unmount or re-run. Without it, every re-render registers a fresh listener and the old ones stay alive.

## Listener errors

The error callback fires once when a listener is silently terminated, typically a rule denial during initial read or re-evaluation after a `setRules`. Once-per-stream: after the error, no further callbacks happen on this listener.

On sandbox, rule denials are the only stream-error path. On prod, the upstream Firestore can also fire `unavailable` (network), `aborted` (contention), and other transport-level codes.

For host-level error handling without each listener registering its own callback, subscribe to `sandbox.onSnapshotError(cb)` on the sandbox backend. The prod backend has no equivalent: listener errors are per-listener.

## Sandbox-backend listener behaviour

Two divergences from prod, both intentional:

- **Filter / order on chained queries**: a query with `where`/`orderBy`/`limit` routed through `onSnapshot` currently fires for any change in the collection, and the callback receives every document. Filter-aware listeners are in a later slice.
- **Rule changes re-evaluate listeners**: after `sandbox.setRules(db, ...)`, every active listener re-evaluates under the new rules. Prod doesn't do this; listeners keep their original rule context.

For one-shot reads (`getDoc`, `getDocs`), filters apply correctly on both backends.

## What `metadata.fromCache` means

On sandbox: always `false`. There's no offline cache.

On prod: reflects whether the snapshot was served from the local cache. Useful for "show pending" UI states.

If you wrap snapshots in a generic UI component that branches on `metadata.fromCache`, the branch never fires on sandbox. That's fine for most code. The cache-was-stale path is rare in tests, and tests that need to exercise it run against live Firestore.

## Where to look next

- For the full `onSnapshot` overload list, see the [Firebase Web SDK reference](https://firebase.google.com/docs/reference/js/firestore_#onsnapshot). The `pyric/firestore` signature matches.
- For the sandbox-side listener semantics, see [Listener re-evaluation on `deployRules`](../pyric-sandbox-explanation-listener-re-evaluation/).

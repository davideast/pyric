---
title: "Query constraints"
group: "pyric / firestore"
section: "Reference"
order: 100
---
# Query constraints

`pyric/firestore` mirrors `firebase/firestore`'s constraint factories
(`where`, `or`, `and`, `orderBy`, `limit`, `limitToLast`, `startAt`,
`startAfter`, `endAt`, `endBefore`). Compose them via `query(...)`.

The factory signatures and parameters are generated from source in the
[`pyric/firestore` API reference](../../../_generated/pyric-firestore-reference-api.md),
and their query semantics match the upstream SDK — see the
[Firebase Web SDK docs](https://firebase.google.com/docs/reference/js/firestore_).
What follows is the one behaviour specific to the sandbox mirror.

## Sandbox-backend caveat

Chained queries (`.where`, `.orderBy`, `.limit`) currently route to the underlying `LocalEnvironment` as whole-collection listeners when used with `onSnapshot`. The simulator fires for any change in the collection and the callback receives every document. Filter / order honouring at the listener layer is in a later slice. For `getDocs` calls, the constraints apply normally.

This matters only for the sandbox mirror's `onSnapshot`. One-shot `getDocs`
evaluates the filters correctly. In an inactive production run, the canonical
import remains Firebase and uses Firebase's listener behaviour.

## Combining everything
```ts
const q = query(
  collection(db, 'notes'),
  or(
    and(where('priority', '>=', 5), where('archived', '==', false)),
    where('flagged', '==', true),
  ),
  orderBy('createdAt', 'desc'),
  orderBy('priority', 'desc'),
  limit(20),
);
```
The order of constraints in the argument list doesn't change semantics. The engine sorts them into the right execution order, so keep them in a readable order for humans.

## Where to look next

- For the upstream-SDK reference on query semantics (composite indexes, query restrictions), see the [Firebase Web SDK docs](https://firebase.google.com/docs/reference/js/firestore_).
- For listener routing on chained queries in the sandbox, see [The `TARGET_SYMBOL` opacity contract](../explanation/target-symbol-opacity.md).

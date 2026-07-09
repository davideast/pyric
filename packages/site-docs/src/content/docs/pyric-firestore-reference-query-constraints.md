---
title: "Query constraints"
group: "pyric / firestore"
section: "Reference"
order: 54
---
# Query constraints

`pyric/firestore` mirrors `firebase/firestore`'s constraint factories. Compose them via `query(...)`.

## Filters

### `where(field, op, value)`
```ts
where('ownerId', '==', 'alice')
where('priority', '>=', 5)
where('tags', 'array-contains', 'urgent')
where('status', 'in', ['open', 'pending'])
```
`op` is one of `==`, `!=`, `<`, `<=`, `>`, `>=`, `array-contains`, `array-contains-any`, `in`, `not-in`.

### `or(...filters)`

Compose multiple filters with OR semantics. The combined constraint matches a doc when any inner filter matches.
```ts
query(
  collection(db, 'notes'),
  or(
    where('priority', '>=', 5),
    where('flagged', '==', true),
  ),
);
```
### `and(...filters)`

Compose multiple filters with AND semantics. Useful inside `or` (the only context where AND combinators are needed — top-level constraints are already AND-combined).
```ts
or(
  and(where('priority', '>=', 5), where('archived', '==', false)),
  where('flagged', '==', true),
)
```
## Ordering

### `orderBy(field, direction?)`
```ts
orderBy('createdAt')              // default 'asc'
orderBy('createdAt', 'desc')
orderBy('priority', 'desc')
```
`direction` is `'asc'` or `'desc'`. Multiple `orderBy` calls in one query stack — later constraints are tiebreakers.

## Limits

### `limit(n)`

Cap the result set to `n` documents.

### `limitToLast(n)`

Cap to the last `n` documents in the query's ordering. Requires at least one `orderBy`; reverses internally to fetch the tail.

## Cursors

Four constraints for pagination. Each accepts either a `DocumentSnapshot` (start at / after this doc) or positional field values matching the `orderBy` constraints.

### `startAt(snapshot)` / `startAt(...values)`

Include the matching doc and everything after.

### `startAfter(snapshot)` / `startAfter(...values)`

Exclude the matching doc; start at the next one.

### `endAt(snapshot)` / `endAt(...values)`

Include everything up to and including the matching doc.

### `endBefore(snapshot)` / `endBefore(...values)`

Exclude the matching doc; end just before it.
```ts
const firstPage = await getDocs(query(
  collection(db, 'notes'),
  orderBy('createdAt'),
  limit(20),
));
const lastDoc = firstPage.docs[firstPage.docs.length - 1];

const secondPage = await getDocs(query(
  collection(db, 'notes'),
  orderBy('createdAt'),
  startAfter(lastDoc),
  limit(20),
));
```
## Sandbox-backend caveat

Chained queries (`.where`, `.orderBy`, `.limit`) currently route to the underlying `LocalEnvironment` as whole-collection listeners when used with `onSnapshot`. The simulator fires for any change in the collection and the callback receives every document. Filter / order honouring at the listener layer is in a later slice — for `getDocs` calls, the constraints apply normally.

This matters only for `onSnapshot`. One-shot `getDocs` evaluates the filters correctly on both backends.

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
The order of constraints in the argument list doesn't change semantics — the engine sorts them into the right execution order. Keep them in a readable order for humans.

## Where to look next

- For the upstream-SDK reference on query semantics (composite indexes, query restrictions), see the [Firebase Web SDK docs](https://firebase.google.com/docs/reference/js/firestore_).
- For listener routing on chained queries in the sandbox, see [The `TARGET_SYMBOL` opacity contract](../pyric-firestore-explanation-target-symbol-opacity/).

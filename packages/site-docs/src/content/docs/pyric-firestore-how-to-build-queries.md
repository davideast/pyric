---
title: "How to build queries with where, orderBy, limit"
navLabel: "Build queries"
group: "pyric / firestore"
section: "How-to"
order: 77
---
# How to build queries with `where`, `orderBy`, `limit`

This guide shows you how to compose query constraints.

## A basic query
```ts
import { collection, query, where, orderBy, limit, getDocs } from 'pyric/firestore';

const q = query(
  collection(db, 'notes'),
  where('ownerId', '==', 'alice'),
  where('archived', '==', false),
  orderBy('createdAt', 'desc'),
  limit(20),
);

const snap = await getDocs(q);
for (const doc of snap.docs) {
  console.log(doc.id, doc.data());
}
```
Constraints stack — multiple `where` calls AND together. Multiple `orderBy` calls become tiebreaker chains.

## OR conditions

`where`s in the same query AND together. For OR, use the `or` combinator:
```ts
import { or } from 'pyric/firestore';

const q = query(
  collection(db, 'notes'),
  or(
    where('priority', '>=', 5),
    where('flagged', '==', true),
  ),
);
```
## OR-of-ANDs

For "(A and B) or C", nest `and` inside `or`:
```ts
import { and, or } from 'pyric/firestore';

const q = query(
  collection(db, 'notes'),
  or(
    and(where('priority', '>=', 5), where('archived', '==', false)),
    where('flagged', '==', true),
  ),
);
```
Top-level constraints are already AND-combined, so `and` is only useful inside an `or`.

## Pagination with cursors

`startAt`, `startAfter`, `endAt`, `endBefore` each accept either a `DocumentSnapshot` or positional field values matching the `orderBy` constraints.

### Cursor by snapshot
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
### Cursor by value
```ts
const slice = await getDocs(query(
  collection(db, 'notes'),
  orderBy('priority', 'desc'),
  orderBy('createdAt', 'desc'),
  startAt(5, '2026-01-01T00:00:00Z'),
  endAt(3, '2026-12-31T23:59:59Z'),
));
```
The positional values match the `orderBy` constraints in order.

## Limit from the end
```ts
const lastThree = await getDocs(query(
  collection(db, 'notes'),
  orderBy('createdAt'),
  limitToLast(3),
));
```
`limitToLast` requires at least one `orderBy`. It reverses internally to fetch the tail.

## Collection groups

Query across every collection with a given name, anywhere in the database:
```ts
import { collectionGroup, query, where, getDocs } from 'pyric/firestore';

const q = query(
  collectionGroup(db, 'messages'),
  where('author', '==', 'alice'),
);

const snap = await getDocs(q);
```
Useful for nested structures like `rooms/{roomId}/messages/{messageId}` — the collection group finds every `messages` collection regardless of which room it belongs to.

## What works on the sandbox

`getDocs` evaluates every constraint correctly on both backends. The sandbox runs the query against its `LocalEnvironment`, applying filters, ordering, and limits in memory.

`onSnapshot` on the sandbox currently fires for any change in the underlying collection — filters at the listener layer are in a later slice. For now, filter the results in your callback if you need filtered streaming:
```ts
onSnapshot(query(collection(db, 'notes'), where('owner', '==', 'alice')), (snap) => {
  // The sandbox-backend snap.docs may include docs that don't match the filter.
  const matching = snap.docs.filter((d) => d.data().owner === 'alice');
  // ...
});
```
This is a sandbox-only caveat — on the prod backend, the filter is enforced server-side.

## Aggregations

`count`, `sum`, and `average` return aggregate fields. Use them with `getCountFromServer` or `getAggregateFromServer`:
```ts
import { collection, query, where, count, getCountFromServer } from 'pyric/firestore';

const q = query(collection(db, 'notes'), where('archived', '==', false));
const snap = await getCountFromServer(q);
console.log(`${snap.data().count} unarchived notes`);
```
## Where to look next

- For all constraint constructors, see [Query constraints](../pyric-firestore-reference-query-constraints/).
- For watching queries instead of one-shot reading, see [Use `onSnapshot`](../pyric-firestore-how-to-use-onsnapshot/).

---
title: "Run Cloud Firestore locally"
navLabel: "Store and query data"
group: "Build"
section: ""
order: 2002
description: "Read, write, query, and stream Firestore documents locally, and derive the composite indexes your queries need from your source."
---

# Run Cloud Firestore locally

Firestore in Pyric is v1. The modular SDK surface, reads and writes, queries, snapshots, transactions, and aggregations, runs locally with your rules enforced, and it is tested against recorded production behavior. Your imports stay `firebase/firestore`.

## Write and read documents

```ts
import {
  getFirestore, collection, doc,
  addDoc, setDoc, getDoc, serverTimestamp,
} from 'firebase/firestore';

const db = getFirestore(app);

const noteRef = await addDoc(collection(db, 'notes'), {
  title: 'First note',
  ownerId: uid,
  createdAt: serverTimestamp(),
});

const snap = await getDoc(noteRef);
console.log(snap.data());
```

`setDoc` writes to a known path (pass `{ merge: true }` to update in place), `updateDoc` patches fields, `deleteDoc` removes. Field sentinels work: `serverTimestamp`, `increment`, `arrayUnion`, `arrayRemove`, `deleteField`.

## Query with where, orderBy, limit

```ts
import { query, where, orderBy, limit, getDocs } from 'firebase/firestore';

const recent = query(
  collection(db, 'notes'),
  where('ownerId', '==', uid),
  where('archived', '==', false),
  orderBy('createdAt', 'desc'),
  limit(20),
);

const page = await getDocs(recent);
```

Multiple `where` clauses AND together; the `or` and `and` combinators handle the rest. Cursors (`startAfter`, `endAt`) paginate, and collection groups query across every subcollection with a given name. Aggregations run without fetching the documents:

```ts
import { getCountFromServer } from 'firebase/firestore';

const count = await getCountFromServer(query(collection(db, 'notes'), where('archived', '==', false)));
console.log(count.data().count);
```

`sum` and `average` follow the same shape through `getAggregateFromServer`.

## Keep the UI live

```ts
import { onSnapshot } from 'firebase/firestore';

const unsubscribe = onSnapshot(recent, (snap) => {
  for (const change of snap.docChanges()) {
    console.log(change.type, change.doc.id);
  }
});
```

Listeners fire on every matching change, across tabs, because every tab shares one backend. If your rules deny a listener, the error callback fires with a verdict that names the rule, not a bare `permission-denied`.

## Read, then write, atomically

When a write depends on the current value, use a transaction:

```ts
import { runTransaction } from 'firebase/firestore';

await runTransaction(db, async (tx) => {
  const counter = await tx.get(doc(db, 'counters', 'main'));
  const current = counter.exists() ? counter.data().count : 0;
  tx.set(doc(db, 'counters', 'main'), { count: current + 1 });
});
```

All reads must come before any writes inside the callback. Production enforces that because the engine retries on conflict, and the sandbox enforces it for parity, so the mistake surfaces on your machine instead of in a retry storm. For multiple writes with no read dependency, `writeBatch` is the cheaper shape.

## Design queries and the indexes they need

A query with combined filters and ordering needs a composite index in production, and the missing-index error arrives at the worst time. Pyric derives the index file from your code instead: `firestore_extract_indexes` statically reads your `query(collection(...), where(...), orderBy(...))` call sites and returns the `firestore.indexes.json` they require, with warnings where it suspects overshoot.

When branchy code enumerates more shapes than your app will ever run, guide the extractor with JSDoc annotations on the function:

- `@firestore-mutex { fieldA, fieldB }` drops combinations where those filters would coexist.
- `@firestore-required fieldA` drops combinations missing a filter that is always present.
- `@firestore-budget N` is a soft cap that warns when exceeded.

The index file stops being a hand-kept artifact. It becomes derived output, and [ship to production](../ship-to-production/) deploys it.

## And from an agent

An MCP-connected agent can inventory the queries the product performs and compare them with the rules that govern list access. Start with [Work with an agent](../work-with-an-agent/).

## Where to go next

Data without protection is a liability, so [secure it with rules](../secure-it-with-rules/). And when you need scenarios instead of hand-typed documents, [shape your data](../shape-your-data/) covers seeding, snapshots, and resets.

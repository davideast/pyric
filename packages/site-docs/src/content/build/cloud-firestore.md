---
title: "Run Cloud Firestore locally"
navLabel: "Cloud Firestore"
group: "Build"
section: ""
order: 20
description: "Read, write, query, and stream Firestore documents locally, and derive the composite indexes your queries need from your source."
---

# Run Cloud Firestore locally

Firestore runs locally with your Security Rules enforced. Your application keeps the `firebase/firestore` imports it will ship.

## Write and read a document

Use the same Firebase SDK calls in local development and production:

```ts
import { doc, getDoc, getFirestore, setDoc } from 'firebase/firestore';

const db = getFirestore(app);
const note = doc(db, 'notes', 'first');

await setDoc(note, {
  title: 'The sandbox is local',
  ownerId: 'ada',
});

const saved = await getDoc(note);
console.log(saved.data());
```

During development, Pyric resolves those imports to the local backend. A production build resolves them to Firebase again.

## Query the documents the current user owns

Combine the ownership filter with the order and result limit your screen needs:

```ts
import {
  collection, getDocs, limit, orderBy, query, where,
} from 'firebase/firestore';

const recent = query(
  collection(db, 'notes'),
  where('ownerId', '==', uid),
  where('archived', '==', false),
  orderBy('createdAt', 'desc'),
  limit(20),
);

const page = await getDocs(recent);
```

The local Rules engine evaluates the query as a query. A rule that allows one document does not automatically make an under-constrained list safe.

## Keep those results live

Attach a listener to the same query:

```ts
import { onSnapshot } from 'firebase/firestore';

const unsubscribe = onSnapshot(recent, (snap) => {
  for (const change of snap.docChanges()) {
    console.log(change.type, change.doc.id);
  }
});
```

Listeners receive each matching change across tabs. If Rules deny the listener, its error callback receives a verdict that identifies the rule responsible.

## Update a value atomically

Use a transaction when the next write depends on the stored value:

```ts
import { runTransaction } from 'firebase/firestore';

await runTransaction(db, async (tx) => {
  const counter = await tx.get(doc(db, 'counters', 'main'));
  const current = counter.exists() ? counter.data().count : 0;
  tx.set(doc(db, 'counters', 'main'), { count: current + 1 });
});
```

Keep every transaction read before its first write. Pyric enforces that ordering locally, matching the retry-safe shape Firebase requires.

## Generate the indexes your queries need

Derive `firestore.indexes.json` from the filters and ordering in your application source:

```bash
pyric firestore indexes generate src --out firestore.indexes.json
```

Review the generated file with the query open, then deploy it with the rest of the Firebase configuration when you [ship to production](../ship/ship-to-production.md).

## And from an agent

Ask a connected agent to inventory the Firestore queries in the application, derive their indexes, and compare each query with the Rules that govern list access. [Work with an agent](../agent/work-with-an-agent.md) shows how the agent connects to the same local backend.

## Where to go next

Now [prove your Rules protect the application](../secure/secure-it-with-rules.md).

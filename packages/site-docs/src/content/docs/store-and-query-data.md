---
title: "Run Cloud Firestore locally"
navLabel: "Store and query data"
group: "Develop with Firebase APIs"
section: ""
order: 2002
description: "Keep Cloud Firestore application code unchanged while data, listeners, transactions, and Security Rules stay local."
---

# Run Cloud Firestore locally

Keep using the modular Cloud Firestore Web API:

```ts
import { collection, getDocs, getFirestore } from 'firebase/firestore';

const db = getFirestore(app);
const notes = await getDocs(collection(db, 'notes'));
```

During development, the call reads the local sandbox. A production build runs it through Firebase. Use the [Cloud Firestore Web documentation](https://firebase.google.com/docs/firestore/quickstart) for ordinary reads, writes, queries, listeners, transactions, batches, and data types.

## What changes locally

Documents stay in the browser-local backend. Tabs on the same development origin share that backend through one SharedWorker, so Firestore listeners observe writes across tabs. Pyric Studio reads the same documents and requests.

Every application operation is evaluated against the active local Firestore Security Rules. A denial stays local and appears in Studio with the request path and verdict. Saving the configured rules file replaces the active local ruleset without deploying it.

The sandbox does not reproduce Firebase billing, network latency, regional behavior, or production indexes. A query that succeeds locally can still require a composite index in Firebase. Generate the index file from application query shapes before deployment:

```bash
npx pyric firestore indexes generate src
```

Deploy the resulting Firebase index configuration with `firebase-tools`.

## Check the supported boundary

Read the generated [Firestore conformance matrix](../pyric-firestore-compat/) before depending on a less common API or production edge. It separates public surface coverage from verified behavior and lists every documented difference, bug, unsupported behavior, and unverified row.

Continue with [Inspect and correct](../see-whats-happening/) or [secure the data with local Security Rules](../secure-it-with-rules/).

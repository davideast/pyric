---
title: Which data service should I use?
navLabel: Which data service?
outcome: Pick between Firestore and Realtime Database in one short read.
status: draft
---

# Which data service should I use?

The short answer: Firestore, unless the data is a small shared tree that many clients watch at once.

| | Firestore | Realtime Database |
|---|---|---|
| Model | documents and subcollections | one JSON tree |
| Queries | combined filters, ordering, aggregations, cursors | path reads, one `orderBy` |
| Built for | structured app data, almost every CRUD app | presence, live cursors, game state, counters |
| Maturity in Pyric | [v1, tested against recorded production behavior](../../../../packages/pyric/docs/firestore/COMPAT.md) | [experimental, not yet pinned to production](../../../../packages/pyric/docs/database/COMPAT.md) |

**Choose Firestore for query power and structured documents.** Subcollections grow with the app's shape, and access rules attach to paths and document data. Most apps land here. If either service would fit, pick Firestore: it carries the deeper conformance record.

**Choose Realtime Database for low-latency tree sync:** presence, live cursors, game state, counters. It stops fitting the moment a query needs more than one field.

The two also combine. Firestore holds the documents the app is made of, RTDB holds the ephemeral layer on top, where a two-field tree beats a document write per keystroke. To design that tree, [model it around the reads](./sync-realtime-data.md).

## Where to go next

[Store and query data](./store-and-query-data.md) for the Firestore path, or [sync realtime data](./sync-realtime-data.md) for the tree.

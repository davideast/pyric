---
title: "Which data service should I use?"
navLabel: "Which data service?"
group: "Build"
section: ""
order: 8
description: "Pick between Firestore and Realtime Database in one short read."
---

# Which data service should I use?

The short answer: Firestore, unless your data is a small shared tree that many clients watch at once.

**Choose Firestore for query power and structured documents.** Combined filters and ordering, collection groups, aggregations, transactions, and cursor pagination. Documents and subcollections grow with your app's shape, and access rules attach naturally to paths and document data. Most apps, and almost every CRUD app, land here.

**Choose Realtime Database for low-latency tree sync.** Presence, live cursors, game state, counters. The whole database is one JSON tree, reads are path-shaped, and queries take one `orderBy`. The model is deliberately simpler, and that simplicity is the feature. It stops being a fit the moment you want multi-field queries, so [model the tree around your reads](../sync-realtime-data/) before committing.

In Pyric today, maturity belongs in the decision too. Firestore is v1, tested against recorded production behavior. Realtime Database is [experimental](../whats-experimental/): it works, but most of its behavior is not yet pinned to a production observation. If either service would fit, pick Firestore.

They also combine. A common shape is Firestore for the documents your app is made of and RTDB for the ephemeral layer on top, presence and typing indicators, where a two-field tree beats a document write per keystroke.

## Where to go next

[Store and query data](../store-and-query-data/) for the Firestore path, or [sync realtime data](../sync-realtime-data/) for the tree.

---
title: "Choose a Firebase database"
navLabel: "Which data service?"
group: "Build"
section: ""
order: 70
description: "Make the Firestore or Realtime Database decision from Firebase's production model, then check the corresponding Pyric boundary."
---

# Choose a Firebase database

Choosing between Cloud Firestore and Realtime Database is a Firebase architecture decision, not a Pyric decision. Compare their production data models, query capabilities, scaling behavior, availability, locations, and pricing in the official [Firebase database comparison](https://firebase.google.com/docs/database/rtdb-vs-firestore).

After choosing the production service, use the matching local path:

- [Run Cloud Firestore locally](./store-and-query-data.md).
- [Run Realtime Database locally](./sync-realtime-data.md).

Support for each service changes as the mirror grows, so this guide does not duplicate an availability list. Ask the central conformance model instead:

```bash
pyric can-i-use firestore/getDocs
pyric can-i-use rtdb/onValue
```

The answer separates availability from fidelity and assurance, and describes Pyric's current local boundary. It should not replace Firebase's production architecture guidance.

---
title: "Choose a Firebase database"
navLabel: "Which data service?"
group: "Develop with Firebase APIs"
section: ""
order: 2008
description: "Make the Firestore or Realtime Database decision from Firebase's production model, then check the corresponding Pyric boundary."
---

# Choose a Firebase database

Choosing between Cloud Firestore and Realtime Database is a Firebase architecture decision, not a Pyric decision. Compare their production data models, query capabilities, scaling behavior, availability, locations, and pricing in the official [Firebase database comparison](https://firebase.google.com/docs/database/rtdb-vs-firestore).

After choosing the production service, use the matching local path:

- [Run Cloud Firestore locally](../store-and-query-data/), then inspect the [Firestore conformance matrix](../pyric-firestore-compat/).
- [Run Realtime Database locally](../sync-realtime-data/), then inspect the [Realtime Database conformance matrix](../pyric-database-compat/).

The conformance matrices describe Pyric's current local boundary. They should not replace Firebase's production architecture guidance.

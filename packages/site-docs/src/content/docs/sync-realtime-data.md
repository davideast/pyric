---
title: "Run Realtime Database locally"
navLabel: "Sync realtime data"
group: "Develop with Firebase APIs"
section: ""
order: 2003
description: "Keep Realtime Database application code unchanged while the data tree, listeners, and Security Rules stay local."
---

# Run Realtime Database locally

Keep using the Firebase Realtime Database Web API:

```ts
import { getDatabase, onValue, ref } from 'firebase/database';

const db = getDatabase(app);
onValue(ref(db, 'rooms/main'), (snapshot) => {
  renderRoom(snapshot.val());
});
```

During development, the listener reads the sandbox tree. A production build runs it through Firebase. Use the [Realtime Database Web documentation](https://firebase.google.com/docs/database/web/start) for normal data modeling, reads, writes, queries, listeners, and transactions.

## What changes locally

The database tree and listener state remain in the local backend. Pyric Studio can browse and edit the same tree used by the application. Local Realtime Database Security Rules evaluate application operations without deploying a ruleset or contacting a Firebase database.

Production concerns such as region, connection latency, billing, and deployed database configuration are outside the sandbox. Validate those in a Firebase environment before release.

## Check the supported boundary

Read the generated [Realtime Database conformance matrix](../pyric-database-compat/) for the current modular API surface, verified behavior, rules evidence, documented differences, unsupported behavior, and unverified rows.

For Pyric-specific rules authoring, see [RTDB rules in TypeScript](../rtdb-rules-in-typescript/). Continue with [Inspect and correct](../see-whats-happening/) to observe local writes and denials.

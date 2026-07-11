---
title: "pyric-admin/database"
navLabel: "Overview"
group: "pyric-admin / database"
section: ""
order: 186
---
# `pyric-admin/database`

Admin-shape Realtime Database with swappable backends. `getDatabase(app)` mirrors `firebase-admin/database` and dispatches on the app handle from `pyric-admin/app`:

- **Production app**: returns the genuine `firebase-admin/database` `Database`. Every instance method works unchanged.
- **Local sandbox app**: a minimal in-memory tree. Covers the load-bearing data plane (`set`, `get`, `once('value')`, `update`, `remove`, `push` with real push ids, `child`).
- **Remote sandbox app**: every data operation relays over the worker channel to the browser-hosted sandbox with the admin rules-bypass lens pinned, against the one tree the browser app, Studio, and agents share. Adds working `on('value')` listeners and full multi-path `update` on top of the local subset.

Realtime Database support is experimental, on this surface and on `pyric/database`. The data plane works and is tested; most behavior is not yet pinned to a recorded production observation.

Anything the sandbox arms don't model (listeners on the local arm, transactions, queries, priorities, `onDisconnect`, rules metadata) throws a clear "not implemented" error, never bad data.
```ts
import { initializeApp } from 'pyric-admin/app';
import { getDatabase } from 'pyric-admin/database';
import { initializeSandbox } from 'pyric/sandbox';

const app = initializeApp({ sandbox: initializeSandbox() });
const db = getDatabase(app);

await db.ref('rooms/lobby').set({ topic: 'launch' });
const snap = await db.ref('rooms/lobby/topic').get();
console.log(snap.val()); // 'launch'

const msg = db.ref('rooms/lobby/messages').push({ text: 'hi' });
console.log(msg.key); // a real 20-char push id, available synchronously
```
## Where to go next

- [API reference](../pyric-admin-database-reference-api/) for the full `Reference` and `DataSnapshot` surface, per arm.

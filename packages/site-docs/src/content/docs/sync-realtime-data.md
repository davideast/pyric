---
title: "Sync realtime data"
group: "Build"
section: ""
order: 2003
description: "Store and watch a Realtime Database tree locally, model it around your reads, and guard writes with schema and rules checks."
---

# Sync realtime data

> **Experimental.** Realtime Database works and is documented, but most of its behavior is not yet pinned to a recorded production observation the way Auth and Firestore are. Read [how we know it matches Firebase](../how-we-know-it-matches-firebase/) before you rely on it.

Realtime Database is one JSON tree that many clients watch at once. In Pyric it runs locally, rules enforced, with the modular calls you already know.

## Store and read

Under `pyric dev`, your `firebase/database` imports resolve to the sandbox:
```ts
import { getDatabase, ref, set, get, onValue } from 'firebase/database';

const db = getDatabase();

await set(ref(db, 'status/alice'), { state: 'online', changedAt: Date.now() });

const snap = await get(ref(db, 'status/alice'));
console.log(snap.val()); // { state: 'online', changedAt: ... }

onValue(ref(db, 'status'), (snap) => {
  renderPresence(snap.val());
});
```
`push` appends with chronologically sortable IDs, `update` patches, `remove` deletes. One boundary to know: the Vite plugin does not swap `firebase/database` yet, so this path runs under `pyric dev`. In Node, import the same functions from `pyric/database` and hand `getDatabase` a sandbox:
```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getDatabase, ref, set } from 'pyric/database';

const sandbox = initializeSandbox();
const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
```
## Model the tree around your reads

Every RTDB path is an endpoint, and reading a path downloads everything below it. So structure follows the reads, not the entities. The defaults that hold up:

- **Flat, top-level collections.** `/users`, `/posts`, `/postSummaries`. Never nest one entity type inside another, or one read drags the whole subtree.
- **Index tables for reverse lookups.** `/userGroups/$uid/$groupId: true` answers "which groups is this user in" with one cheap read, and lets membership gate access in rules.
- **Summary nodes sized for list screens.** The list reads `/postSummaries`, the detail screen fetches one `/posts/$id`.
- **Push IDs for anything append-only.** Sequential numeric keys collide under concurrent writers; push IDs never do.

Duplicated data stays consistent through fan-out: one `update` at the root with full paths as keys commits atomically.
```ts
import { update } from 'firebase/database';

await update(ref(db), {
  'posts/p1/title': 'New title',
  'postSummaries/p1/title': 'New title',
});
```
Either both paths change or neither does. Queries take one `orderBy`, so multi-field filters want a precomputed composite key (`"lang_level": "en_5"`) rather than a clever query.

## Guard writes before they land

Nothing in RTDB stops a typo'd field name or a mistyped value. The tree accepts what you write. `rtdb_validated_write` closes that gap with three checks before anything commits:

- It infers the schema at the target path from the data already there and validates your payload against it.
- It simulates the security-rules verdict for the write.
- Only then does it commit, with the schema warnings and the simulation result attached.

A wrong type, a misspelled key, or a write your rules would deny is reported before it lands. The tool sits on Pyric's agent surface alongside `rtdb_get`, `rtdb_set`, `rtdb_push`, `rtdb_update`, and the crawl and rules tools, and the same factories are callable from your own code through `getRtdbTools`.

## And from an agent

The `rtdb-data-model` skill designs the tree the way this page describes, starting from an inventory of reads. On an existing database, `rtdb_crawl_structure` maps the actual shape first, and `rtdb_validated_write` guards every write the agent makes. Install the skill from the [catalog](../skills/), and see [set up your agent](../set-up-your-agent/) for the wiring.

## Where to go next

Not sure the tree is the right home for this data? [Which data service should I use?](../which-data-service/) is the one-page answer. When the paths are settled, write the rules that hold them in TypeScript: [RTDB rules in TypeScript](../rtdb-rules-in-typescript/).

---
title: "Run Realtime Database locally"
navLabel: "Realtime Database"
group: "Build"
section: ""
order: 30
description: "Store and watch a Realtime Database tree locally, model it around your reads, and guard writes with schema and rules checks."
---

# Run Realtime Database locally

Realtime Database support is incomplete. Check its generated conformance page for the exact public API coverage before depending on a feature.

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
`push` appends with chronologically sortable IDs, `update` patches, `remove` deletes. This path runs the same under `pyric dev` and the Vite plugin — both swap `firebase/database` for the sandbox, and both run your `onValueCreated` functions against it, so a write here can trip a trigger just like production. In Node, import the same functions from `pyric/database` and hand `getDatabase` a sandbox:
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

## Run your onValueCreated functions locally

Both `pyric dev` and the Vite plugin read the `functions` block in `firebase.json` and run your `onValueCreated` triggers in an isolated Node process against the same sandbox your app writes to. No option is required — the block is enough. Other trigger kinds (HTTPS, callable, scheduled, Firestore) log a warning and are skipped for now.

The plugin's `functions` option tunes or disables this:
```ts
// vite.config.ts
import { pyric } from '@pyric/cli/vite';

export default {
  plugins: [
    pyric({
      functions: { region: 'europe-west1', instance: 'my-app-default-rtdb' },
      // or `functions: false` to keep the block and never run triggers locally
    }),
  ],
};
```
Each field wins over its environment variable, which wins over firebase files, which win over the default. `region` beats `PYRIC_FUNCTIONS_RTDB_REGION` (default `us-central1`). `instance` replaces the derived `<projectId>-default-rtdb` name, where the project id comes from `PYRIC_PROJECT`, then `.firebaserc`, then `demo-project`.

Under the plugin, saving a file in the functions source directory restarts the process, like a redeploy: `↻ [pyric] functions reloaded`. In-flight executions in the old process can drop, writes that land during the swap are treated as existing data by the new process (they do not fire), and a save that fails to load takes functions down until the next good save — unlike rules, there is no last-good process to keep serving. `functions: { watch: false }` turns the reload off, matching `pyric dev`, where editing a function needs a server restart.

Running functions also mounts the agent bridge the process uses to reach the sandbox. That changes nothing about how your app runs: the page stays on the multi-tab SharedWorker path, and the bridge relays through it.

## Inspect and simulate locally

Pyric keeps RTDB inspection and rules checks inside the sandbox. Studio and the
CLI can crawl the current sandbox snapshot, while `rtdbRules(...).simulate()`
evaluates reads and writes without contacting a production database. Production
access happens only when the canonical Firebase package is selected outside the
sandbox swap.

## And from an agent

Ask an MCP-connected agent to inventory the reads your application performs, then inspect the local tree with `rtdb_crawl_structure`. [Work with an agent](../agent/work-with-an-agent.md) gives a complete RTDB task prompt, and [Set up your agent](../agent/set-up-your-agent.md) explains the browser bridge.

## Where to go next

When the paths are settled, write the rules that hold them in TypeScript: [RTDB rules in TypeScript](../secure/rtdb-rules-in-typescript.md).

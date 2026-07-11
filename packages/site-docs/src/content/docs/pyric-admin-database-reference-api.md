---
title: "API reference: pyric-admin/database"
navLabel: "API reference"
group: "pyric-admin / database"
section: "Reference"
order: 21002
---
# API reference: `pyric-admin/database`

Exact signatures of every public export, plus the per-arm method matrix for `Database`, `Reference`, and `DataSnapshot`. Realtime Database support is experimental; the surfaces below are tested but mostly not yet pinned to recorded production observations.

The three arms:

- **prod**: `getDatabase` delegates to `firebase-admin/database`. The returned `Database` and every `Reference` it produces are the genuine firebase-admin objects (`transaction`, `onDisconnect`, query builders, rules methods, all present and identical in behavior). Nothing below applies to prod.
- **local**: an in-memory JSON tree per `Sandbox`. `sandbox.reset()` wipes it (via the sandbox's `session_boundary` event). Writes are rule-bypass, matching firebase-admin's behavior of bypassing rules.
- **remote**: a remote-branded sandbox relays every data operation over the worker channel with `actAs: { mode: 'admin' }` pinned (rules bypass) against the browser-hosted tree. Server writes emit `SandboxEvent`s in the worker and fire the app's live listeners.

---

## Initialization

### `getDatabase(app?, url?)`
```ts
function getDatabase(app?: PyricAdminApp, url?: string): Database;
```
firebase-admin's `getDatabase(app?)` and `getDatabaseWithUrl(url, app)` collapsed into one function:

- `getDatabase()`: default database for the `'[DEFAULT]'` app, resolved through `pyric-admin/app`'s registry. Throws `app/no-app` when nothing is initialized. Works on all three arms.
- `getDatabase(app)`: default database for the app.
- `getDatabase(app, url)`: on prod, delegates to `getDatabaseWithUrl(url, app)`. The sandbox arms ignore `url`; the sandbox has no notion of multiple database instances per project.

Successive calls for the same sandbox return handles that share data, matching firebase-admin's singleton-per-app semantics. Throws `TypeError` for an unbranded value.

---

## `Database` (sandbox arms)

| Method | local | remote | Behavior |
|---|---|---|---|
| `ref(path?)` | yes | yes | `Reference` at `path` (default `'/'`) |
| `refFromURL(url)` | yes | yes | strips the `https://<host>` prefix, treats the rest as a path; the host is ignored |
| `useEmulator(host, port)` | no-op | no-op | accepted so code that calls it unconditionally still runs |
| `goOffline()` / `goOnline()` | no-op | no-op | no network connection to drop or reopen |
| `getRules()` / `getRulesJSON()` / `setRules(src)` | throws | throws | rules metadata is not modeled; sandbox writes are rule-bypass, so there is no backing rule state to expose |
| `app` | stubbed | stubbed | present for interface shape; the data-plane methods never read it |

---

## `Reference`: the data plane

Every implemented method is `async` and shapes its results like firebase-admin. Properties on every ref: `key` (last segment, `null` at root), `parent` (`null` at root), `root`, `path` (canonical, `/`-prefixed), `ref` (itself), `database`, `toString()` (returns `sandbox://rtdb<path>`), `isEqual(other)` (path comparison), `toJSON()`.

### `ref.set(value)`
```ts
set(value: unknown): Promise<void>;
```
Arms: local, remote. Writes `value` at the ref's path; `null` deletes. A root-level `set` must be an object (or `null` to clear). Deleting trims now-empty ancestor objects, preserving the RTDB invariant that empty nodes don't exist. Remote relays `rtdb.set`.

### `ref.get()`
```ts
get(): Promise<DataSnapshot>;
```
Arms: local, remote. Reads the path and resolves to a `DataSnapshot`. Absent paths resolve to a snapshot with `exists() === false` and `val() === null`. Remote relays `rtdb.get`.

### `ref.once(eventType)`
```ts
once(eventType: EventType): Promise<DataSnapshot>;
```
Arms: local, remote. Only `'value'` is supported; any other event type throws. Local reads the tree directly. Remote establishes a value subscription, resolves with the initial snapshot, then detaches.

### `ref.update(values)`
```ts
update(values: object): Promise<void>;
```
Arms: local, remote, with a real semantic difference:

- **Local: shallow merge.** Each key in `values` replaces the corresponding child at the ref's path (a key may itself be a relative path like `'a/b'`). A `null` value deletes that child. There is no multi-path atomicity guarantee beyond the synchronous loop.
- **Remote: full multi-path update.** Relays `rtdb.update`, and the worker applies `pyric/database`'s modular multi-path semantics.

### `ref.remove()`
```ts
remove(): Promise<void>;
```
Arms: local, remote. Deletes the subtree; equivalent to `set(null)`. Remote relays `rtdb.remove`.

### `ref.push(value?, onComplete?)`
```ts
push(value?: unknown, onComplete?: (err: Error | null) => void): ThenableReference;
```
Arms: local, remote. Mints a 20-character push id with the same algorithm as firebase-js-sdk's published `nextPushId`, so sandbox keys are shape-compatible with production keys and sort chronologically. The returned `ThenableReference` exposes `.key` synchronously on both arms.

- Local: the write is synchronous; `.then()` resolves immediately.
- Remote: the client mints the id and relays `rtdb.push` carrying it; `.then()` settles when the relayed write commits, and a failure rejects the thenable and reaches `onComplete`. A bare `push()` performs no write, matching upstream.

### `ref.child(path)`
```ts
child(path: string): Reference;
```
Arms: local, remote. Pure path manipulation; returns a ref at `<this>/path`.

---

## Listeners: the local/remote divergence

### `ref.on(eventType, callback, cancelCallback?)` and `ref.off(eventType?, callback?)`

Arms: **remote only** for `'value'`. The local arm throws for all event types.

On the remote arm, `on('value', callback)` routes through the worker's RTDB value subscription: the callback fires with the initial snapshot and on every subsequent change, including changes made by the browser app, Studio, or agents (one shared tree). A subscription-establishment failure routes to `cancelCallback` when supplied. Re-registering the same callback replaces the prior registration.

`off('value', callback)` removes that registration; `off()` or `off('value')` removes all registrations at the path. Unknown callbacks and other event types are no-ops.

Other event types (`'child_added'`, `'child_changed'`, `'child_removed'`, `'child_moved'`) throw on both sandbox arms. The worker relays only value subscriptions today. The modular `pyric/database` surface has full listener support.

---

## Not implemented on both sandbox arms

Each throws `Error('pyric-admin/database sandbox: <method> not implemented')`:

| Area | Methods |
|---|---|
| Transactions | `transaction` (the modular `pyric/database` surface has `runTransaction`) |
| Queries | `orderByChild`, `orderByKey`, `orderByValue`, `orderByPriority`, `startAt`, `startAfter`, `endAt`, `endBefore`, `equalTo`, `limitToFirst`, `limitToLast` |
| Priorities | `setPriority`, `setWithPriority` (snapshots report `getPriority() === null` and `exportVal()` equals `val()`) |
| Presence | `onDisconnect` |
| Rules metadata | `Database.getRules`, `getRulesJSON`, `setRules` |
| Local arm only | `on`, `off`, `once` with a non-`'value'` type |

All of these work on the prod arm.

---

## `DataSnapshot`

One snapshot implementation serves both sandbox arms (the remote arm feeds it wire values). Implemented surface:
```ts
key: string | null;
ref: Reference;
exists(): boolean;
val(): unknown;
child(path: string): DataSnapshot;
hasChild(path: string): boolean;
hasChildren(): boolean;
numChildren(): number;
forEach(cb: (child: DataSnapshot) => boolean | void): boolean;
toJSON(): unknown;
getPriority(): string | number | null; // always null
exportVal(): unknown; // equals val(): no priorities are modeled
```
---

## Path safety (sandbox-only constraint)

The local tree is backed by plain JavaScript objects, so the path segments `__proto__`, `prototype`, and `constructor` are rejected with an error. A segment named `__proto__` arriving through a JSON or MCP transport could otherwise reach `Object.prototype` and pollute it process-wide. Real RTDB stores a server-side tree with no such reserved keys, so this is a sandbox-only safety constraint, not a parity behavior.

---

## Types

All re-exported from `firebase-admin/database` so every type spells with a `pyric-admin/database` import path: `Database`, `Reference`, `DataSnapshot`, `ThenableReference`, `Query`, `OnDisconnect`, `EventType`. The sandbox backends implement the load-bearing subset of these shapes; the prod arm returns the genuine instances.

---

## Where to go next

- [`pyric-admin/app` reference](../pyric-admin-app-reference-api/) for how the arm is chosen.
- `pyric/database` for the modular mirror with listeners, transactions, and the query builder.

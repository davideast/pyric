---
title: "SandboxSnapshot and admin reads"
group: "pyric / sandbox"
section: "Reference"
order: 107
---
# `SandboxSnapshot` and admin reads

Two related surfaces. `SandboxSnapshot` is the shape returned by `Sandbox.snapshot()`. `SandboxAdmin` is the rule-bypass read surface exposed on `Sandbox.admin`.

## `SandboxSnapshot`
```ts
interface SandboxSnapshot {
  firestore?: Record<string, unknown>;
  [service: string]: unknown;
}
```
Coarse capture of every service's state, keyed by service name. In v1 only `firestore` is populated; future services (`auth`, `database`, `storage`) will add their own keys.

The `firestore` value is a flat map of document path → document data:
```ts
const snap = sandbox.snapshot();
console.log(snap.firestore);
// {
//   'users/alice': { name: 'Alice' },
//   'users/bob':   { name: 'Bob' },
//   'notes/n1':    { owner: 'alice', title: 'hello' },
// }
```
Use this for:

- **Round-tripping**: capture snapshot before a destructive test, restore after.
- **Diagnostic dumps**: log the full state when a test fails.
- **Cross-checks**: assert against the whole state, not just specific docs.

The snapshot is a structural clone of the state at call time. Mutating the returned object does not affect the sandbox.

## `SandboxAdmin`
```ts
interface SandboxAdmin {
  getDocument(path: string): unknown | null;
  listDocuments(prefix: string):
    { path: string; data: unknown; phantom?: true }[];
}
```
Available on `sandbox.admin`. Identity-agnostic — admin reads aren't gated on auth, so they live on the sandbox (not on a context).

### `getDocument(path)`

Read a single Firestore document by full path, ignoring rules. Returns `null` if the document doesn't exist.
```ts
const doc = sandbox.admin.getDocument('users/alice');
// doc is { name: 'Alice', ... } or null
```
Use this in tests to assert "did the write actually land?" without needing a separate admin context.

### `listDocuments(prefix)`

List Firestore documents under a collection path, ignoring rules.
```ts
const docs = sandbox.admin.listDocuments('users');
// [
//   { path: 'users/alice', data: { name: 'Alice' } },
//   { path: 'users/bob',   data: { name: 'Bob' } },
// ]
```
### Phantom documents

`listDocuments` includes **phantom** records — synthesised parent docs that have descendants but no stored data of their own. These match what a live Firestore listing would expose for nested collections:
```ts
// Wrote 'rooms/alpha/messages/m1' directly. Now list rooms:
const rooms = sandbox.admin.listDocuments('rooms');
// [
//   { path: 'rooms/alpha', data: {}, phantom: true },
// ]
```
The `phantom: true` flag lets test code distinguish "this doc was explicitly written and is empty" from "this doc exists only because something underneath it was written". The discover crawler in `pyric/rules` uses this signal to walk structure without confusing the two cases.

## Why this surface is on the root sandbox

Both `snapshot()` and `admin` are presented on `Sandbox`, not `SandboxContext`. The reason is conceptual rather than mechanical: a context exists to carry identity, and admin reads are explicitly identity-agnostic. Putting them on contexts would invite confused calls like `aliceCtx.admin.getDocument(...)` which read like "alice's admin view" — but admin reads are not anyone's view, they're a backdoor for tests.

When other services land (Auth, Storage, Realtime Database), the admin surface namespaces by service: `admin.firestore.getDocument`, `admin.storage.getObject`. The flat shape in v1 is preserved during that transition so existing call sites don't break.

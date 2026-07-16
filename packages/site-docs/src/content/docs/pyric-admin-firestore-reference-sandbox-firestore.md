---
title: "SandboxFirestore surface"
group: "pyric-admin / firestore"
section: "Reference"
order: 19010
---
# `SandboxFirestore` surface

The handle returned from `getFirestore(ctx)`. Extends `Firestore` from `firebase-admin/firestore` (via the simulator's compat impl) and adds three sandbox-only methods.

## Production-shaped methods

These mirror `firebase-admin/firestore` exactly. The production docs and types apply.

### `collection(path: string): CollectionReference`

Get a `CollectionReference` for the given path. Chain `.doc`, `.where`, `.orderBy`, `.limit`, `.get`, `.add`, etc.

### `doc(path: string): DocumentReference`

Get a `DocumentReference` for the given path. Chain `.get`, `.set`, `.update`, `.delete`, `.collection` (subcollection).

### `collectionGroup(collectionId: string): Query`

Build a collection-group query: matches every collection named `collectionId` anywhere in the database.

### `batch(): WriteBatch`

Construct a write batch. Chain `.set`, `.update`, `.delete`, `.commit`.

### `runTransaction<R>(fn, opts?): Promise<R>`

Run a transaction. The callback receives a `Transaction` object with `.get` (ref or query), `.set`, `.update`, `.delete`. Reads inside the callback are tracked for read-after-write detection.

`opts` is accepted for shape parity with `firebase-admin/firestore`'s `OperationOptions`. The sandbox ignores per-op options that don't apply.

## Sandbox-only methods

These have no production analog and use sandbox-specific verbs so they can't be confused with deployment operations.

### `setRules(rules: string): LintResult`

Replace the active ruleset. Returns the lint result from `pyric/rules`: surface the warnings if any. If the source has parse-level errors, the rules are not swapped (consistent with `LocalEnvironment.deployRules`).

After a successful `setRules`, every active snapshot listener is re-evaluated under the new rules. See [Listener re-evaluation on `deployRules`](../pyric-sandbox-explanation-listener-re-evaluation/) in `pyric/sandbox`.

### `seed(options?): LintResult`

Replace stored documents with a new seed map. Active rules are preserved.

```ts
db.seed({
  documents: {
    'notes/n1': { ownerId: 'alice', title: 'first' },
    'notes/n2': { ownerId: 'bob',   title: 'second' },
  },
});
```

Pass an empty `documents` map (or omit it) to clear data without touching rules.

Returns the lint of the preserved ruleset for consistency with `setRules`: the same `LintResult` shape across both methods means the caller can check warnings the same way after either call.

### `snapshot(): Record<string, DocumentData>`

Capture every stored document as a `{ [path]: data }` map. Reads from the live state and is independent of rules (same idea as `sandbox.admin.getDocument(...)` but for the whole database in one call).

```ts
const state = db.snapshot();
console.log(state['notes/n1']);  // { ownerId: 'alice', title: 'first' }
```

The returned object is a structural clone. Mutating it does not affect the sandbox.

## What this handle ignores

The handle accepts but does not act on the production `OperationOptions.auth` field. Auth is captured at handle construction from `ctx.auth`: it cannot be overridden per call. To act as a different user, derive a new context via `sandbox.withAuth(...)` and call `getFirestore` again.

This is per the [identity-is-a-context](../pyric-sandbox-explanation-identity-is-a-context/) design: identity lives on the context, not on individual operations.

## Per-call delegate construction

Every production-shaped method constructs a fresh `Firestore` delegate per call. This is intentional. See [Per-call delegate construction](../pyric-admin-firestore-explanation-per-call-delegate/). The cost is one class instance per operation, which is dominated by the cost of the operation itself.

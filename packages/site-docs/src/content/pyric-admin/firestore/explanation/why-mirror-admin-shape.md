---
navLabel: "Why mirror the admin SDK"
---
# Why mirror the admin SDK shape

`pyric-admin` re-implements the `firebase-admin/firestore` API. Same chainable style, same method names, same arguments, same return types. The behaviour is sandbox-aware (it talks to `pyric/sandbox` instead of Google's servers), but the surface is faithful.

This page explains why we mirrored an existing API instead of designing a new one.

## The principle

Test code should look like production code. Anything else is friction.

A team writes a Cloud Function in `firebase-admin/firestore`:

```ts
async function archiveOld(): Promise<void> {
  const snapshot = await db
    .collection('notes')
    .where('archived', '==', false)
    .where('lastSeen', '<', cutoff)
    .get();
  const batch = db.batch();
  snapshot.docs.forEach((doc) => batch.update(doc.ref, { archived: true }));
  await batch.commit();
}
```

The test for that function should look identical except for how `db` is obtained:

```ts
// Production
const db = getFirestoreAdmin();

// Test
const db = getFirestore(sandbox.withAuth({ uid: 'admin', token: { admin: true } }));
```

That's the shape we picked. Anything beyond the `db =` line is the same code in both contexts. Test code that imports from `pyric-admin` works against the sandbox today and against `firebase-admin/firestore` tomorrow if you swap the import.

## What we considered

### A simpler API for tests only

We could have designed a small, opinionated test-only API:

```ts
// Hypothetical, not the actual API.
await sandbox.write('notes/n1', { ownerId: 'alice' });
const data = await sandbox.read('notes/n1', { as: 'alice' });
```

Shorter. Easier to learn. Fundamentally different from production code.

The problem is that "test the shape of your production code" has a different goal from "express a test scenario concisely". Production code has methods (`add`, `update`, `set`, `delete`), arguments (`where`, `orderBy`, `limit`), return types (`QuerySnapshot.docChanges()`). The test API that elides those forces test authors to mentally translate. The translation is where bugs hide.

### A type-only wrapper over the simulator

Another option: ship raw types and let consumers wire up a translation layer themselves. We rejected it because every consumer would do the same translation, with subtle differences. Bugs would compound.

### A `firebase-admin` peer dependency

We could have made `firebase-admin/firestore` a peer dep and provided a connector. We didn't because:

- `firebase-admin` is a Node-only package, which would forbid browser use.
- The dep graph is heavy. Pulling in 50+ MB of `firebase-admin` for a test runner is unwelcome.
- The compat impl in `pyric/sandbox/admin-firestore` is browser-safe. Reusing
  it gives us the same surface without pulling `firebase-admin` into sandbox
  test runners.

## What we add on top

Three sandbox-only methods on the handle:

- `setRules(rules)`: replace the active ruleset.
- `seed({ documents })`: replace stored documents.
- `snapshot()`: read all stored documents.

These have no production analog. We picked sandbox-flavoured verbs (`setRules`, `seed`, `snapshot`) so a reader can't confuse them with deployment operations. `db.deploy(...)` would have been the most natural-feeling name for `setRules`, but it would also have invited "did this hit production?" panic.

## What we don't add

- No per-call `auth` override. Identity is per-context; the handle is bound at construction. See [Identity is a context, not a sandbox](../../../sandbox/docs/explanation/identity-is-a-context.md).
- No alternative APIs that change semantics. The shape exists to mirror production; second-guessing it would defeat the point.
- No "test helpers" embedded in the handle. The `WriteBatch` is a `WriteBatch`, not a `WriteBatch & TestUtilities`. If you need test affordances, build them as a wrapper around the handle.

## Where this leaves us

A test file that imports `pyric-admin` reads like a Cloud Function. Production code that someday becomes a test fixture works without changes. The transition between writing production code and writing tests for it is invisible at the API level.

That's worth more than any minor convenience a custom API would have offered.

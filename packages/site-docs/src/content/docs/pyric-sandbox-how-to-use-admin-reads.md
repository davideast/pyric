---
title: "How to use admin reads to assert in tests"
navLabel: "Use admin reads"
group: "pyric / sandbox"
section: "How-to"
order: 14010
---
# How to use admin reads to assert in tests

Use `sandbox.admin` to verify state in tests without writing rules that permit your test fixture.

## The problem

A test asserts "the write went through":

```ts
await aliceDb.collection('notes').doc('n1').set({ title: 'hello' });

const snap = await aliceDb.collection('notes').doc('n1').get();
expect(snap.exists).toBe(true);
```

The `aliceDb.get` evaluates `allow read` against `alice`'s identity. If your read rule rejects this (for example, because it requires the doc to be in a specific status), the assertion will fail even though the write succeeded. You can't tell whether the bug is in the write or in the read rule.

## The fix

Use `sandbox.admin` for the assertion:

```ts
await aliceDb.collection('notes').doc('n1').set({ title: 'hello' });

const data = sandbox.admin.getDocument('notes/n1');
expect(data).toEqual({ title: 'hello' });
```

`sandbox.admin.getDocument` ignores rules entirely. It tells you what the *data* is, not what `alice` is allowed to see.

## When to use admin reads

- **Asserting writes landed.** Most common case. Use admin to confirm the data exists.
- **Inspecting state in error paths.** When a test fails, log the full state via `sandbox.snapshot()` to see what the rules engine actually saw.
- **Cross-checks.** Verify "after this multi-step setup, the database contains exactly these docs."
- **Test fixtures that bypass rules.** Seeding documents that your own rules would deny (admin docs, audit logs, etc.).

## When *not* to use admin reads

- **In production code.** Admin reads are a test affordance. Application code goes through the SDK adapters.
- **To verify rules permit a read.** Use a user-shaped read for that. Admin reads tell you the data exists; they don't tell you the rules let your user see it. Mix both: admin to assert the write, user-shaped read to assert the rule.

## Listing under a collection

```ts
const docs = sandbox.admin.listDocuments('notes');
for (const { path, data } of docs) {
  console.log(path, data);
}
```

The result includes **phantom** parents: synthesised entries for paths that have descendants but no stored data of their own. Phantom records carry `phantom: true` and `data: {}`:

```ts
// Wrote rooms/alpha/messages/m1 directly. List 'rooms':
const rooms = sandbox.admin.listDocuments('rooms');
// [
//   { path: 'rooms/alpha', data: {}, phantom: true },
// ]
```

Filter phantoms out if your test only cares about explicitly-written docs:

```ts
const written = docs.filter((d) => !d.phantom);
```

## Snapshot for whole-state assertions

`sandbox.snapshot()` returns the full state in one call:

```ts
const snap = sandbox.snapshot();
expect(snap.firestore).toEqual({
  'notes/n1': { title: 'hello' },
  'users/alice': { name: 'Alice' },
});
```

Useful for round-tripping (capture before, restore after a destructive operation) and for diagnostic dumps when a test fails. The returned object is a structural clone; mutating it does not affect the sandbox.

## Where to look next

- For the full `SandboxAdmin` surface, see [`SandboxSnapshot` and admin reads](../pyric-sandbox-reference-snapshot-and-admin/).
- For why admin reads live on `Sandbox` and not `SandboxContext`, see [Identity is a context, not a sandbox](../pyric-sandbox-explanation-identity-is-a-context/).

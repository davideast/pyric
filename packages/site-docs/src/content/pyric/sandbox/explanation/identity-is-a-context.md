---
title: "Identity is a context, not a sandbox"
navLabel: "Identity is a context"
group: "pyric / sandbox"
section: "Explanation"
order: 180
---
# Identity is a context, not a sandbox

The most-visible architectural decision in `pyric/sandbox` is that `Sandbox` does not carry an identity. To do anything as a user, you derive a `SandboxContext` via `sandbox.withAuth(...)`. This page explains why.

## What the alternative would look like

A simpler API exposes `auth` as a field on the sandbox:

```ts
// Hypothetical, not the actual API.
const sandbox = initializeSandbox({ auth: { uid: 'alice' } });
sandbox.firestore.collection('notes').doc('n1').set(...);  // runs as alice
sandbox.setAuth({ uid: 'bob' });
sandbox.firestore.collection('notes').doc('n1').get();     // runs as bob
```

This is closest to how the Firebase client SDK works: the client knows who you are because you signed in earlier. It's intuitive. So why didn't we ship it?

## Three problems with auth-on-sandbox

### 1. Multi-tenant tests need many identities, often simultaneously

A test that asserts "alice can read her own note but not bob's" needs two identities live at the same time. With auth-on-sandbox, the test has to swap auth back and forth:

```ts
sandbox.setAuth({ uid: 'alice' });
await sandbox.firestore.collection('notes').doc('alice-1').set({ ownerId: 'alice' });
sandbox.setAuth({ uid: 'bob' });
try { await sandbox.firestore.collection('notes').doc('alice-1').get(); } catch { /* expected */ }
sandbox.setAuth({ uid: 'alice' });  // restore
```

This is tedious and error-prone. Forget to restore and the next operation runs as `bob` accidentally. With contexts, the same test is straightforward:

```ts
const aliceDb = getFirestore(sandbox.withAuth({ uid: 'alice' }));
const bobDb = getFirestore(sandbox.withAuth({ uid: 'bob' }));

await aliceDb.collection('notes').doc('alice-1').set({ ownerId: 'alice' });
try { await bobDb.collection('notes').doc('alice-1').get(); } catch { /* expected */ }
```

Two named variables, two identities, no swapping. The test reads like the assertion it's making.

### 2. Concurrent operations from different identities

Two simultaneous writes from different users:

```ts
// With auth-on-sandbox — concurrent setAuth calls race.
await Promise.all([
  (async () => { sandbox.setAuth({ uid: 'alice' }); await write(); })(),
  (async () => { sandbox.setAuth({ uid: 'bob' }); await write(); })(),
]);
```

The behaviour depends on event-loop scheduling. The same code passes most runs and fails sometimes. With contexts:

```ts
await Promise.all([
  aliceDb.collection('notes').doc('a1').set({ ... }),
  bobDb.collection('notes').doc('b1').set({ ... }),
]);
```

Each operation's identity is captured in the handle it was issued through. No race.

### 3. Identity-agnostic operations should be obvious

Admin reads, listener subscribers, `reset`, `dispose`, `snapshot`: none of these are tied to a user. With auth-on-sandbox, where do they live? On the sandbox, alongside the user-bound operations? That blurs the line. With contexts, the identity-agnostic surface is exactly what's on `Sandbox`; everything else (data operations) requires a context. A reader of the type signature can tell at a glance.

## The mental model

```
Sandbox          ← data, rules, lifecycle. Identity-agnostic.
   │
   │  withAuth(auth)
   ▼
SandboxContext   ← (sandbox, auth) pair. Cheap, immutable.
   │
   │  getFirestore(ctx)
   ▼
FirestoreHandle  ← data-plane API. Operations evaluate under ctx.auth.
```

Three layers, each with one job. Operations that mutate data flow down the chain. Operations that don't (listener subscriptions, admin reads, lifecycle) live at the top.

## What about per-operation auth overrides?

We considered exposing `db.collection('x').doc('y').get({ auth: { uid: 'alice' } })` as an override. Rejected because:

- The service handle's whole shape would need to change. Every method gets an optional `OperationOptions { auth?: AuthState }` parameter, multiplying the surface area.
- The handle's binding to its context becomes a lie. "This handle is bound to alice, except when it isn't."
- Composition gets harder. A function that takes a `FirestoreHandle` can no longer assume it knows whose identity its operations run under.

"Derive a different context" is cheaper than any of those costs.

## What about implicit fallback?

A different option: let auth-less handles exist, and have them default to anonymous. `getFirestore(sandbox)` (no context) returns a handle that evaluates as `request.auth == null`.

Rejected because the call site is then ambiguous about whether anonymous was intended or forgotten. Service factories require a `SandboxContext` (`getFirestore(sandbox.withAuth(null))` for anonymous) so the intent is on the page.

The same reasoning applies to `withAuth(undefined)`: it throws instead of treating `undefined` as anonymous. Explicit `null` is the only way to say "anonymous on purpose".

## Where this design came from

This split was originally `AuthContext` (the data type) and `Sandbox` (with `auth` baked in). The rename to `AuthState` + `SandboxContext` happened during the multi-context redesign, motivated by exactly the scenarios above. The history is in the design rationale if you want the full discussion.

The key insight: identity is something operations have, not something sandboxes have. A sandbox is a *place* with documents and rules. An operation is an *action* with an actor. The context is the bridge that carries the actor in.

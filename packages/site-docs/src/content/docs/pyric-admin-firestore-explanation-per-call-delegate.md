---
title: "Per-call delegate construction"
navLabel: "Per-call delegate"
group: "pyric-admin / firestore"
section: "Explanation"
order: 179
---
# Per-call delegate construction

Every production-shaped method on `SandboxFirestore` constructs a fresh
`Firestore` delegate from `pyric/sandbox/admin-firestore` per call. This page
explains why and what it costs.

## The pattern
```ts
function buildFirestoreHandle(ctx: SandboxContext): SandboxFirestore {
  const delegate = (): Firestore =>
    createCompatFirestore(getInternalEnv(ctx.sandbox), { auth: ctx.auth });

  return {
    collection(path) { return delegate().collection(path); },
    doc(path)        { return delegate().doc(path); },
    batch()          { return delegate().batch(); },
    runTransaction(fn, _opts) { return delegate().runTransaction(fn); },
    // ...
  };
}
```
Each method calls `delegate()` to get a fresh `Firestore` instance, then invokes the production-shaped method on it. The instance is constructed per call.

## Why not cache one delegate

The obvious alternative caches the delegate at handle-construction time:
```ts
// Naive version — broken.
function buildFirestoreHandle(ctx: SandboxContext): SandboxFirestore {
  const delegate = createCompatFirestore(getInternalEnv(ctx.sandbox), { auth: ctx.auth });
  return {
    collection(path) { return delegate.collection(path); },
    // ...
  };
}
```
This is faster (one allocation instead of many) and broken in one specific case: `sandbox.reset()`.

`Sandbox.reset()` swaps the underlying `LocalEnvironment` for a fresh one. Existing `SandboxContext`s continue to work. Their next operation resolves through `getEnv()` and finds the new environment. But a cached delegate would still be bound to the *old* environment. Operations through the cached delegate would land in a discarded environment that nobody else can see.

Per-call construction reads `getInternalEnv(ctx.sandbox)` on every operation, so it always sees the current environment. `reset()` propagates for free.

## What the cost is

`createCompatFirestore` is essentially a constructor: it allocates a class instance, captures a reference to the env, captures the auth. No I/O, no network, no expensive computation. The cost is one allocation per operation.

For comparison, a single Firestore `set` involves: serialising the payload, evaluating rules, walking the local state, appending to the event log, firing snapshot listeners. The delegate construction is a rounding error against any of these.

We measured. It's not worth optimising.

## What this means for refs

`DocumentReference`, `CollectionReference`, `Query`, `WriteBatch`, `Transaction` objects returned from a delegate are bound to the *delegate*, which is bound to the env that was live when the delegate was constructed.

In practice this means:

- A `DocumentReference` obtained from `db.doc('notes/n1')` keeps working across normal operations.
- A `DocumentReference` obtained before `sandbox.reset()` will, after the reset, operate against a discarded environment.

The latter is a real edge case. Test code that holds refs across resets is unusual but happens. The fix is to re-acquire refs after reset:
```ts
beforeEach(() => {
  sandbox.reset();
  adminDb.setRules(RULES);
  notesRef = adminDb.collection('notes');  // refresh
});
```
The README and the `getFirestore` JSDoc both call this out: refs are bound to whichever environment was live when they were obtained.

## Why this isn't a leak

A naive reader might worry: "If every method constructs a delegate, are old delegates leaking?" No. Delegates are throwaway: they're constructed, used once, and become eligible for garbage collection. No long-lived references, no module-level state.

The only thing that lives across operations is the `SandboxFirestore` handle itself, which is cached per-context in a `WeakMap`. When the context is garbage-collected, the handle goes with it.

## The idempotency cache
```ts
const handleCache = new WeakMap<SandboxContext, SandboxFirestore>();
```
This is at the handle level, not the delegate level. The handle is cheap to keep (it's a small object with method references), and idempotency means `getFirestore(ctx)` returns the same object every time. Cached results from the first call (like the error-translation wrapping) don't get re-applied.

The cache is a `WeakMap`, so a context that goes out of scope drops its handle automatically. No manual cleanup needed.

## Where this leaves us

The per-call delegate is the price we pay for `reset()` working transparently. It's a small price (one allocation per operation, no network), and the alternative (cached delegate, broken `reset`) creates a class of test bugs that are hard to diagnose. The trade is clearly worth it; this page exists so future maintainers don't try to "optimise" it.

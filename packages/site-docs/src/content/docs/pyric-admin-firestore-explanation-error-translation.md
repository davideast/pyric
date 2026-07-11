---
title: "Error translation and instanceof SandboxError"
navLabel: "Error translation"
group: "pyric-admin / firestore"
section: "Explanation"
order: 177
---
# Error translation and `instanceof SandboxError`

Every operation through a `SandboxFirestore` handle that fails throws a `SandboxError`. The underlying simulator throws `FirestoreSimError`; the admin handle wraps every method, catches those, and re-throws as `SandboxError` with structured `denialContext`. This page explains the layer.

## What the wrapping does
```ts
import { wrapWithErrorTranslation } from './error-translation.js';

const fresh = wrapWithErrorTranslation(buildFirestoreHandle(ctx), ctx);
```
The wrapper covers every method on the handle plus every object returned from it: `DocumentReference`, `Query`, `WriteBatch`, `Transaction`. Inside, the simulator might throw a `FirestoreSimError('permission-denied', ..., { request, resource, debugMessages })`. The wrapper translates that to:
```ts
new SandboxError({
  code: 'permission-denied',
  message: '<simulator message>',
  denialContext: {
    auth: ctx.auth,
    reasons: error.debugMessages,
    request: { method, path, resourceData? },
    resource: { data, exists },
  },
});
```
Same shape every consumer sees. Catch with `instanceof SandboxError`, switch on `code`.

## Why translate

Two reasons.

### One error type to catch

Without translation, consumers would need to know about `FirestoreSimError` (a
simulator-internal type) and `SandboxError` (the public type). The simulator
types live behind `pyric/rules` and `pyric/sandbox/admin-firestore`; surfacing
them directly in consumer code would couple consumers to implementation details.

With translation, the boundary is clean: `pyric-admin` throws `SandboxError`, only. The simulator types stay internal.

### One denial-context shape

`FirestoreSimError` carries `debugMessages` and a `request` field with simulator-shaped naming. The `DenialContext` shape is what consumers actually want: `reasons` (renamed from `debugMessages` to match production parity), structured `request` / `resource`, optional `auth` and `rule`. The translation reshapes once, every consumer benefits.

The `DenialContext` shape is also what `Sandbox.onDenial` and `Sandbox.onSnapshotError` use. One shape across throw sites and event-channel callbacks means one denial-UI component handles both.

## The `CONTEXT_SYMBOL` stash

The wrapper attaches the original `SandboxContext` to every wrapped value via a `CONTEXT_SYMBOL` property. This isn't for application code: it's so `onSnapshot` can recover the context from a `DocumentReference` passed to it.

When you call:
```ts
onSnapshot(db.doc('notes/n1'), callback);
```
The `db.doc('notes/n1')` is a `DocumentReference`. `onSnapshot` doesn't get the context handed to it directly. It gets the ref. Without the stash, `onSnapshot` couldn't tell which auth identity to register the listener under.

`CONTEXT_SYMBOL` is non-enumerable and uses a unique symbol, so it doesn't show up in `Object.keys`, doesn't serialise, doesn't appear in `console.log` output. Application code never sees it.

## The `registerOnSnapshotImpl` indirection

`pyric-admin`'s `onSnapshot` is implemented in `error-translation.ts` because both packages need it: the standalone `onSnapshot` function (re-exported from the package root) and the per-ref `ref.onSnapshot(...)` method (inherited from the production-shaped surface).

`registerOnSnapshotImpl` is how the standalone function discovers the per-ref implementation without circular imports. The data-plane handle's per-ref `onSnapshot` is set at construction time; the standalone function looks it up on the ref it was passed.

The reason for this dance is that the standalone function can be called against any `DocumentReference` or `Query`, including ones obtained before the standalone function existed (during early initialisation, or in test fixtures). The lookup approach decouples the two surfaces.

## What this means for tests

Tests catching denials don't need to know about `FirestoreSimError`, `LocalEnvironment`, or any simulator internals. They write:
```ts
try {
  await bobDb.collection('notes').doc('n1').update({ title: 'tamper' });
} catch (e) {
  if (e instanceof SandboxError && e.code === 'permission-denied') {
    expect(e.denialContext?.request?.path).toBe('notes/n1');
  }
}
```
Same shape as catching denials from `Sandbox.onDenial`. Same shape as catching denials from a production runtime (with `'permission-denied'` from `firebase-admin/firestore`'s error class). The translation layer hides the simulator's existence.

## When translation doesn't happen

A few cases:

- **Validation errors** (`withAuth({ uid: '' })`): thrown by the validator before reaching any simulator code. Already `SandboxError`, no translation needed.
- **Errors from your own callback inside `runTransaction`**: the wrapper catches them, marks the tx aborted in the event log, and re-throws the original error unchanged. Your error propagates as-is.
- **Internal sandbox errors** (`'invalid-argument'` from `getInternalEnv`, etc.): already `SandboxError`.

Only simulator-thrown failures go through the translation path. Everything else flows untouched.

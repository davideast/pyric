# `getFirestore` overloads

The single factory dispatches by the shape of its argument.

## Sandbox backend

```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';

const sandbox = initializeSandbox();
const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
```

Pass a `SandboxContext` to get a sandbox-backed `Firestore`. The handle dispatches every operation through `pyric-admin`'s chainable adapter onto `pyric/sandbox`'s `LocalEnvironment`.

The sandbox-only operations (`sandbox.setRules`, `sandbox.seedDocuments`, `sandbox.snapshotState`) work on this handle.

## Prod backend

```ts
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'pyric/firestore';

const app = initializeApp({
  projectId: 'your-project-id',
  // ... other Firebase config
});
const db = getFirestore(app);
```

Pass a `FirebaseApp` to get a prod-backed `Firestore`. The handle delegates every operation to `firebase/firestore`.

The sandbox-only operations throw `SandboxError('failed-precondition')` on this handle: there's no `LocalEnvironment` to set rules against.

## Dispatch rule

Internally, `getFirestore` discriminates via `instanceof SandboxContextImpl`. The check is structural-but-class-based: a hand-rolled object with a `withAuth` method would not satisfy `instanceof` and would route to the prod backend, where `firebase/firestore`'s `getFirestore` would reject it.

For application code this means: pass a `SandboxContext` derived from `initializeSandbox()` for sandbox; pass a `FirebaseApp` from `initializeApp` for prod. Anything else is an error.

## Why one factory, not two

We considered exporting two factories: `getFirestoreSandbox(ctx)` and `getFirestoreProd(app)`. Rejected because:

- The swap-in contract for `firebase/firestore` is `getFirestore(app)`. Code written against the upstream SDK shouldn't need to rename its calls.
- The two-factory version forces every consumer of the resulting `Firestore` to track which factory produced it. The single factory hides the choice behind one call site.

## Type-level dispatch

The two overloads narrow correctly:

```ts
function f(target: SandboxContext | FirebaseApp): Firestore {
  return getFirestore(target);   // resolves to overload 1 or 2 by inference
}
```

TypeScript picks the right overload from the argument's type. The runtime check is independent: even if a caller cast through `any`, the runtime branch still routes correctly.

## What's identical across backends

Once you have a `Firestore`, every other function in the package works identically:

```ts
const db = getFirestore(target);  // sandbox or prod — doesn't matter from here

await setDoc(doc(db, 'notes', 'n1'), { title: 'hello' });
const snap = await getDoc(doc(db, 'notes', 'n1'));
```

The same `setDoc` call routes to the simulator's `set` on sandbox and to Firebase's `setDoc` on prod. Differences are confined to:

- Sandbox-only operations (`sandbox.*`): throw on prod.
- Performance characteristics: sandbox is sub-millisecond, prod is network-latency-bound.
- Error sources: sandbox throws `SandboxError`; prod throws `FirebaseError` from `firebase/firestore` (translated via the simulator's compat path on the sandbox side).

## What's not identical across backends

- **Some `metadata` fields**. Sandbox always reports `metadata.fromCache: false` and `metadata.hasPendingWrites: false`. Prod populates them per the real cache state.
- **Network failures**. Only prod can throw `'unavailable'` or `'failed-precondition'` from contention. Sandbox is synchronous.
- **Rule changes**. Sandbox re-evaluates listeners immediately after `sandbox.setRules`; prod's `firebase deploy --only firestore:rules` propagates over seconds to minutes and does not affect already-attached listeners.

These divergences are documented and intentional. See [Why two backends behind one surface](../explanation/two-backends-one-surface.md).

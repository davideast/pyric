---
title: "Why two backends behind one surface"
navLabel: "Two backends, one surface"
group: "pyric / firestore"
section: "Explanation"
order: 90
---
# Why two backends behind one surface

`pyric/firestore` exposes `getFirestore(target)` with two overloads: one accepting a `SandboxContext`, one accepting a `FirebaseApp`. The same downstream functions (`getDoc`, `setDoc`, `onSnapshot`, ...) work against either. This page explains the design.

## The shape we wanted

Firebase users write code like:
```ts
import { getFirestore, doc, setDoc, getDoc } from 'firebase/firestore';

const db = getFirestore(app);
await setDoc(doc(db, 'notes/n1'), { title: 'hello' });
const snap = await getDoc(doc(db, 'notes/n1'));
```
We wanted that exact code to work against the sandbox for tests. Two requirements fell out:

1. **Same import path.** Test code imports from `pyric/firestore` or `firebase/firestore`, not from a test-only package.
2. **Same call sites.** No `if (sandbox) ... else ...` branches inside application code.

The result is the swap-in contract: `import { ... } from 'pyric/firestore'` behaves like the upstream package, modulo the explicit sandbox-only surface.

## The dispatch model

Internally, `Firestore` is an opaque handle carrying a `Target` discriminator:
```ts
type Target = SandboxTarget | ProdTarget;
type SandboxTarget = { kind: 'sandbox'; db: ChainableFirestore };
type ProdTarget = { kind: 'prod'; db: fb.Firestore };
```
Every function in the package starts with `const target = targetOf(db)`, then branches:
```ts
export async function setDoc(ref, data, opts?) {
  const target = targetOf(ref.parent /* or whatever */);
  if (target.kind === 'sandbox') {
    return target.db.doc(ref.path).set(data, opts);  // → pyric-admin
  }
  return fb.setDoc(toFbRef(ref), data, opts);        // → firebase/firestore
}
```
The dispatch is shape-uniform across reads, writes, queries, listeners, transactions, and aggregations.

## Why not a proxy

A proxy could intercept method calls on the handle and forward them. We didn't because:

- The upstream `firebase/firestore` is a function-based API, not a class-based one. Proxying free functions is awkward: every caller would need to import through the proxy.
- The free-function dispatch is one branch per function. Cheap, explicit, readable at a glance.

## Why `Firestore` is opaque

The handle exposes one property, `[TARGET_SYMBOL]: Target`. No methods, no public state. The reason: any property on the handle becomes part of the public API. Consumers reading `db.something` couldn't be insulated from future internal changes.

By contrast, the chainable `pyric-admin` handle exposes methods (`db.collection`, `db.doc`, etc.) because that's how the admin SDK shapes its surface. The two packages match their respective upstream conventions.

See [The `TARGET_SYMBOL` opacity contract](../pyric-firestore-explanation-target-symbol-opacity/).

## The cost of the dispatch

Each function call adds one branch. On the prod path, it adds a function-call indirection (we call `fb.setDoc`; the upstream package does the actual work). On the sandbox path, it adds the chainable-to-modular translation.

In both cases the cost is dwarfed by the actual operation. We measured. It's not detectable.

## The behavioural deltas

Where the two backends genuinely diverge, the differences are intentional and documented:

- **Metadata fields** (`fromCache`, `hasPendingWrites`): sandbox doesn't have a cache or a pending-writes window. Both fields always `false`. Production-shaped UI code that displays these states sees the fields populated only on prod.
- **Rule changes**: sandbox re-evaluates listeners on `sandbox.setRules`; prod doesn't affect already-attached listeners. The sandbox behaviour matches what a playground UI needs, and prod's behaviour matches the eventual-consistency model. Neither is wrong. They serve different needs.
- **Network-bound errors**: prod can throw `unavailable`, `aborted` from contention, `resource-exhausted` from quota. Sandbox has no analog for any of these. Tests that need to exercise these paths run against live Firestore.

These show up only in code that branches on the behavioural difference. Most application code touches none of them.

## How this differs from the emulator

The Firebase Emulator Suite runs the production engine in a separate Java process. Three constraints follow:

- **Browser hosts.** A tab can't spawn Java.
- **Agent loops.** Sub-second iteration matters, and process round-trips add up.
- **Bundle-sensitive apps.** A separate process can't ship inside one.

`pyric/firestore`'s sandbox backend is in-process, so it fits all three.

## When this design wins

A team writes a Cloud Function in `firebase/firestore`. They import `pyric/firestore` instead. Their unit tests run in-process against the sandbox. Their integration tests pass `getFirestore(app)` and run against the live project. The *application code* between the two never knows which it's running against.

The two backends behind one surface is the affordance that makes this possible.

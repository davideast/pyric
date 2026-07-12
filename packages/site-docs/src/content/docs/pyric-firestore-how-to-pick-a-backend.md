---
title: "How to pick a backend at init time"
navLabel: "Pick a backend"
group: "pyric / firestore"
section: "How-to"
order: 12005
---
# How to pick a backend at init time

Choose between the sandbox and prod backends at init time, and switch between them without changing the rest of your code.

## The choice happens once

```ts
import { getFirestore } from 'pyric/firestore';

// Sandbox.
import { initializeSandbox } from 'pyric/sandbox';
const sandbox = initializeSandbox();
const dbSandbox = getFirestore(sandbox.withAuth({ uid: 'alice' }));

// Prod.
import { initializeApp } from 'firebase/app';
const app = initializeApp({ /* config */ });
const dbProd = getFirestore(app);
```

Every other Firestore call in the package works against either handle without modification. The only divergence is the `sandbox.*` namespace and a handful of metadata fields.

## Run-time dispatch

For projects that want to switch backends based on environment:

```ts
function makeDb() {
  if (process.env.PYRIC_BACKEND === 'sandbox') {
    const sandbox = initializeSandbox();
    return getFirestore(sandbox.withAuth({ uid: 'test-user' }));
  }
  const app = initializeApp({ /* config */ });
  return getFirestore(app);
}

const db = makeDb();
```

The same code paths run against both backends. Tests run against sandbox, production runs against prod, no code changes between them.

## Compile-time dispatch

For projects that want different bundles per environment, use a top-level conditional and let your bundler tree-shake:

```ts
// In a setup module that's only imported by tests.
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';

export function makeTestDb() {
  const sandbox = initializeSandbox();
  return getFirestore(sandbox.withAuth({ uid: 'test-user' }));
}
```

```ts
// In a setup module that's only imported by production.
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'pyric/firestore';

export function makeProdDb() {
  const app = initializeApp({ /* config */ });
  return getFirestore(app);
}
```

Each module imports only what it needs. The bundler keeps `firebase` out of the test bundle and `pyric/sandbox` out of the production bundle.

## What changes between backends

| Behaviour | Sandbox | Prod |
|---|---|---|
| Latency per op | Sub-millisecond | Network-latency-bound |
| `metadata.fromCache` | Always `false` | Reflects real cache state |
| `metadata.hasPendingWrites` | Always `false` | Reflects pending writes |
| Listener after rule change | Immediate re-eval | Propagation, no listener effect |
| `sandbox.setRules(db, ...)` | Works | Throws `failed-precondition` |
| Network failures | None | `unavailable`, `aborted`, etc. |

For most application code, none of these matter. For code that *depends* on cache state or propagation timing, sandbox can give misleading results. Those cases belong on live Firestore.

## Both at once

A single process can use both:

```ts
const sandbox = initializeSandbox();
const app = initializeApp({ /* config */ });

const sandboxDb = getFirestore(sandbox.withAuth({ uid: 'alice' }));
const prodDb = getFirestore(app);

// These two writes go to two different databases.
await Promise.all([
  setDoc(doc(sandboxDb, 'notes/n1'), { source: 'local' }),
  setDoc(doc(prodDb, 'notes/n1'), { source: 'cloud' }),
]);
```

Sometimes useful for replication-style tests or for staging tools that compare sandbox state against production.

## What's not supported

You can't change a handle's backend after construction. If you need to switch mid-test, build a new handle. The handle's `TARGET_SYMBOL` is set at `getFirestore` time and never updates.

## Where to look next

- For why the two backends share one surface, see [Why two backends behind one surface](../pyric-firestore-explanation-two-backends-one-surface/).
- For the divergence list in detail, see [`getFirestore` overloads](../pyric-firestore-reference-getfirestore/).

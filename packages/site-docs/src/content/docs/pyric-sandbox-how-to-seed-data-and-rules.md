---
title: "How to seed initial data and rules"
navLabel: "Seed data and rules"
group: "pyric / sandbox"
section: "How-to"
order: 123
---
# How to seed initial data and rules

Bring a fresh sandbox up to a known state (rules deployed, documents in place) before your test code runs.

## The two options

`pyric/sandbox` itself doesn't expose `seed` on the public surface (that belongs to the data-plane adapter). Two paths land you at the same outcome:

- **Through an adapter handle**: `getFirestore(ctx).setRules(...)` and an `admin` write loop.
- **Through `/internal`**: `getInternalEnv(sandbox).seed({ rules, documents })`.

Most consumers use the adapter path. The `/internal` path is for higher-level tooling (the playground, the agent runtime) that wants to load a whole snapshot atomically.

## Adapter-driven seed
```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric-admin';

const sandbox = initializeSandbox();
const adminCtx = sandbox.withAuth({ uid: 'admin', token: { admin: true } });
const adminDb = getFirestore(adminCtx);

// Deploy rules.
adminDb.setRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read: if request.auth != null;
      allow write: if request.auth.uid == request.resource.data.ownerId;
    }
  }
}`);

// Write the initial documents. The admin context's auth + token satisfy
// most reasonable rules; for rules that deny *every* user, use the
// `/internal` seed path instead.
await adminDb.collection('notes').doc('n1').set({
  ownerId: 'alice',
  title: 'first note',
});
```
This path is the most natural for tests because every operation goes through the same SDK surface your production code uses. If your rules deny `admin`-authed writes too, fall back to `/internal`.

## `/internal` seed for tooling
```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';

const sandbox = initializeSandbox();
const env = getInternalEnv(sandbox);

const lint = env.seed({
  rules: `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read: if request.auth != null;
      allow write: if request.auth.uid == request.resource.data.ownerId;
    }
  }
}`,
  documents: {
    'notes/n1': { ownerId: 'alice', title: 'first note' },
    'notes/n2': { ownerId: 'bob',   title: 'second note' },
  },
});

if (lint.warnings.some((w) => w.severity === 'error')) {
  throw new Error('rules failed to lint');
}
```
`seed` returns the `LintResult` from `pyric/rules`. Check it before treating the seed as successful. A ruleset with errors leaves the sandbox in default-deny.

`/internal` is documented as adapter-only. Tooling that uses it accepts that the surface may change between minor versions.

## Seed once vs seed per test

Two patterns work. Choose by how much your tests share state.

### Seed once at module top
```ts
const sandbox = initializeSandbox();
seed(sandbox);  // your helper

beforeEach(() => sandbox.reset());
```
After `reset`, the sandbox is empty. Re-seed if the next test depends on the initial state. A helper makes that cheap:
```ts
beforeEach(() => {
  sandbox.reset();
  seed(sandbox);
});
```
### Build per test
```ts
let sandbox: Sandbox;

beforeEach(() => {
  sandbox = initializeSandbox();
  seed(sandbox);
});
```
Heavier (rebuilds the environment per test) but isolates state changes more strictly. Use when tests are touching listeners or when seed cost is negligible.

## Order matters

Rules first, then documents. If you write documents before rules, the writes evaluate against default-deny and most will fail. The `seed` method on `LocalEnvironment` enforces this order: rules are set, then documents are loaded, then the event log is cleared.

## Where to look next

- For rules linting and the lint result shape, see [`pyric/rules`](../pyric-rules-reference-lint-rules/).
- For resetting between tests, see [Reset between tests](../pyric-sandbox-how-to-reset-between-tests/).

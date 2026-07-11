---
title: "How to use sandbox-only operations"
navLabel: "Use sandbox-only ops"
group: "pyric / firestore"
section: "How-to"
order: 12008
---
# How to use sandbox-only operations

Deploy rules, seed data, and dump state: three operations that only work against the sandbox backend.

## Deploy rules
```ts
import { sandbox } from 'pyric/firestore';

const lint = sandbox.setRules(db, `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read, write: if request.auth != null;
    }
  }
}`);

if (lint.warnings.some((w) => w.severity === 'error')) {
  throw new Error('rules failed to lint');
}
```
`setRules` returns the `LintResult` from `pyric/rules`. Source with parse errors is not swapped, so check the warnings.

## Seed data
```ts
sandbox.seedDocuments(db, {
  'notes/n1': { ownerId: 'alice', title: 'first' },
  'notes/n2': { ownerId: 'bob', title: 'second' },
});
```
Bulk-loads documents, bypassing rules. Active ruleset is preserved.

## Dump state
```ts
const state = sandbox.snapshotState(db);
console.log(state);  // { 'notes/n1': {...}, 'notes/n2': {...} }
```
Reads every stored document. Independent of rules. The returned object is a structural clone, so mutating it does not affect the sandbox.

## Avoid the name collision

The `sandbox` export from `pyric/firestore` is a namespace object, not the function from `pyric/sandbox`. If you have both imports:
```ts
import { initializeSandbox } from 'pyric/sandbox';
import { sandbox as sandboxOps } from 'pyric/firestore';

const sandbox = initializeSandbox();
const db = sandboxOps.setRules(getFirestore(sandbox.withAuth(null)), RULES);
```
Alias on import to keep the local-variable name (`sandbox`) free for the result of `initializeSandbox()`.

## Why these aren't on the handle

The `Firestore` handle from `pyric/firestore` is opaque: `interface Firestore { readonly [TARGET_SYMBOL]: Target }`. Adding methods to it would deviate from the upstream `firebase/firestore`'s `Firestore` shape and break the swap-in contract.

The namespace export keeps the handle shape pure while still providing sandbox-only operations. See [Sandbox-only operations](../pyric-firestore-reference-sandbox-ops/#why-setrules-lives-here-not-on-the-handle) for the longer rationale.

## What throws on a prod handle

All three operations throw `SandboxError('failed-precondition')` when called against a prod-backed `Firestore`:
```ts
const db = getFirestore(initializeApp(config));

sandbox.setRules(db, RULES);   // throws — there's no LocalEnvironment
sandbox.seedDocuments(db, {}); // throws
sandbox.snapshotState(db);     // throws
```
On prod, import `firestore` from `pyric-tools/deploy` and call `firestore.rules.deploy(...)`. There's no equivalent for `seedDocuments` (populate via writes) or `snapshotState` (no efficient bulk-read API).

## Where to look next

- For the reference page covering all three operations, see [Sandbox-only operations](../pyric-firestore-reference-sandbox-ops/).
- For prod rule deploys, see [`pyric-tools/deploy`'s firestore namespace](../pyric-tools-deploy-reference-firestore-namespace/).

---
title: "How to use sandbox-only operations"
navLabel: "Use sandbox-only ops"
group: "pyric / firestore"
section: "How-to"
order: 80
---
# How to use sandbox-only operations

Load rules, seed data, snapshot documents, and inspect Firestore state in one
local sandbox.
```ts
import { initializeSandbox } from 'pyric/sandbox';
import {
  inspect,
  seedDocuments,
  setRules,
  snapshotDocuments,
} from 'pyric/sandbox/firestore';

const sandbox = initializeSandbox();
```
## Deploy rules
```ts
const lint = setRules(sandbox, `rules_version = '2';
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
seedDocuments(sandbox, {
  'notes/n1': { ownerId: 'alice', title: 'first' },
  'notes/n2': { ownerId: 'bob', title: 'second' },
});
```
Bulk-loads documents, bypassing rules. Active ruleset is preserved.

## Dump state
```ts
const state = snapshotDocuments(sandbox);
console.log(state);  // { 'notes/n1': {...}, 'notes/n2': {...} }
```
Reads every stored document. Independent of rules. The returned object is a structural clone, so mutating it does not affect the sandbox.

## Inspect the service
```ts
const report = inspect(sandbox, { recentEventLimit: 5 });
console.log(report.rules.lint);
console.log(report.documents.byCollection);
console.log(report.events.recentDenials);
```
The report is stable and JSON-serialisable, so it can be displayed by tools or
stored as test output.

## Keep the owner and handle separate

Pass the `Sandbox` to controls and the Firestore handle to data-plane functions:
```ts
import { doc, getDoc, getFirestore } from 'pyric/firestore';

const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
setRules(sandbox, RULES);
const note = await getDoc(doc(db, 'notes', 'n1'));
```
This separation is intentional. Sandbox controls own service lifecycle and
diagnostics; `getDoc`, `setDoc`, and the rest retain the
`firebase/firestore`-compatible shape.

For production rule deployment, use `firebase-tools` / Console. Populate production
data through the Firebase SDK; sandbox bulk seeding and whole-service snapshots
have no production equivalents.

## Where to look next

- For all four signatures and report fields, see [Sandbox-only operations](../../../_generated/pyric-firestore-reference-api.md).
- For shipping rules to a real project, see the Firebase CLI docs (`firebase deploy --only firestore:rules`).

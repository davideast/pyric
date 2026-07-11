---
title: "How to seed and set rules"
navLabel: "Seed and set rules"
group: "pyric-admin / firestore"
section: "How-to"
order: 169
---
# How to seed and set rules

This guide shows you how to use the sandbox-only `setRules` and `seed` methods on the Firestore handle.

## Deploy rules
```ts
import { getFirestore } from 'pyric-admin';

const adminDb = getFirestore(sandbox.withAuth({ uid: 'admin', token: { admin: true } }));

const lint = adminDb.setRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read: if request.auth != null;
      allow write: if request.auth.uid == request.resource.data.ownerId;
    }
  }
}`);

if (lint.warnings.some((w) => w.severity === 'error')) {
  throw new Error('rules failed to lint');
}
```
`setRules` returns the `LintResult` from `pyric/rules`. Check warnings before treating the deploy as successful. If the source has parse errors, the rules are *not* swapped (`setRules` is consistent with `LocalEnvironment.deployRules` on that point).

## Seed initial data
```ts
const lint = adminDb.seed({
  documents: {
    'notes/n1': { ownerId: 'alice', title: 'first' },
    'notes/n2': { ownerId: 'bob',   title: 'second' },
    'users/alice': { name: 'Alice' },
    'users/bob':   { name: 'Bob' },
  },
});
```
`seed` replaces the document store wholesale and **preserves the active ruleset**. Pass an empty `documents` map (or omit it) to clear data without touching rules.

The return value is the lint of the preserved ruleset, for shape consistency with `setRules`. Callers that care about lint warnings can check them the same way after either call.

## Seed bypasses rules

`seed` writes through `LocalEnvironment.seed`: it does not go through the rules engine. Use this when your fixture documents would be denied by the rules you're testing (admin docs, audit logs, fixed system records).

For tests where you want the seed itself to evaluate under rules (for example, to verify that "even with admin auth, this collection can't be written to"), use `db.collection(...).doc(...).set(...)` calls under an admin-shaped context instead.

## Order matters

Rules first, then documents:
```ts
adminDb.setRules(RULES);
adminDb.seed({ documents: FIXTURES });
```
If you seed before setting rules, the documents land under default-deny (the sandbox starts with no rules). Subsequent operations that need to read those documents will deny.

In practice the order rarely matters because `seed` bypasses rules anyway, but it does matter for any operation you run between the two calls.

## Reset, then seed

The most common pattern in tests:
```ts
import { beforeEach } from 'bun:test';

beforeEach(() => {
  sandbox.reset();
  adminDb.setRules(RULES);
  adminDb.seed({ documents: FIXTURES });
});
```
`reset` wipes everything (data, rules, listeners). The two follow-up calls restore the rules and fixtures. Subsequent tests start from the same known state.

## Snapshot for round-tripping

The `snapshot()` method on the handle is a pair with `seed`: capture, restore.
```ts
const before = adminDb.snapshot();
// ... destructive operation
adminDb.seed({ documents: before });
```
`snapshot()` reads from the live state independent of rules. Use it for forensic dumps when a test fails or for round-tripping a known state across tests.

## Where to look next

- For lint warning shapes, see [`pyric/rules` lint rules](../pyric-rules-reference-lint-rules/).
- For why these methods live on the data-plane handle rather than the sandbox itself, see [Why mirror the admin SDK shape](../pyric-admin-firestore-explanation-why-mirror-admin-shape/).

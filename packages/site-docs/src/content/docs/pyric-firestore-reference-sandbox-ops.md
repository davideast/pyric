---
title: "Sandbox-only operations"
group: "pyric / firestore"
section: "Reference"
order: 11012
---
# Sandbox-only operations

Firestore-specific controls are top-level exports from
`pyric/sandbox/firestore`. They operate on the owning local `Sandbox`, not on a
Firestore data-plane handle.

```ts
import {
  inspect,
  seedDocuments,
  setRules,
  snapshotDocuments,
} from 'pyric/sandbox/firestore';
```

## `setRules(sandbox, source): LintResult`

Replace the sandbox's active Firestore ruleset.

```ts
const lint = setRules(sandbox, `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read, write: if request.auth != null;
    }
  }
}`);
```

The result contains the rules linter's findings. Source with parse-level errors
is not installed. After a successful change, active snapshot listeners
re-evaluate under the new rules.

## `seedDocuments(sandbox, documents): LintResult`

Replace the sandbox's Firestore documents in bulk while preserving the current
rules. Seeding bypasses rules evaluation and does not synthesise request events
or listener callbacks.

```ts
seedDocuments(sandbox, {
  'notes/n1': { ownerId: 'alice', title: 'first' },
  'notes/n2': { ownerId: 'bob', title: 'second' },
});
```

## `snapshotDocuments(sandbox): Record<string, DocumentData>`

Return a structural clone of every Firestore document without snapshotting any
other sandbox service.

```ts
const documents = snapshotDocuments(sandbox);
console.log(documents['notes/n1']);
```

Mutating the result does not affect the sandbox.

## `inspect(sandbox, options?): FirestoreInspectReport`

Return a JSON-serialisable report containing the current rules and lint
findings, document counts, and recent Firestore requests and denials.

```ts
const report = inspect(sandbox, { recentEventLimit: 5 });
console.log(report.documents.totalCount);
console.log(report.events.recentDenials);
```

`recentEventLimit` defaults to `10`.

## Ownership contract

All four functions accept a local `Sandbox`. A Firestore handle and a
`RemoteSandbox` are rejected by the type contract. The control subpath therefore
makes ownership explicit and keeps sandbox lifecycle operations off the
`firebase/firestore`-compatible data-plane surface.

For production rules deployment, use the deployment API rather than this
sandbox subpath. Production data remains the responsibility of the unchanged
Firebase SDK and Firebase services.

## Where to look next

- For a task-oriented example, see [How to use sandbox-only operations](../pyric-firestore-how-to-use-sandbox-ops/).
- For the lint result shape, see [`pyric/rules` lint rules reference](../pyric-rules-reference-lint-rules/).
- For production rule deployments, see the Firebase CLI docs (`firebase deploy --only firestore:rules`).

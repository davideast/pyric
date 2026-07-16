---
title: "Prove a user can touch only their own data"
navLabel: "Security Rules"
group: "Secure & debug"
section: ""
order: 3001
description: "Write a rule, simulate a request against it, read the verdict, and deploy knowing what it allows."
---

# Prove a user can touch only their own data

Before you deploy a ruleset, you can ask Pyric a direct question: would this specific request, from this specific user, be allowed? You get an answer, and the answer names the rule that decided it.

That is the whole discipline of this wing. Not "the rules look right." Asked and answered, before production gets a vote.

Here is the loop.

## Write the rule

A notes collection. Anyone signed in can read. Only the owner can write.

```rules
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{noteId} {
      allow read: if request.auth != null;
      allow write: if request.auth.uid == resource.data.ownerId;
    }
  }
}
```

## Simulate a request

Now ask the question. No deploy, no network, no Firebase project. The simulator runs in-process.

```ts
import { firestoreRules } from 'pyric/rules';

const result = firestoreRules(source).simulate([
  {
    description: 'owner updates their own note',
    expectation: 'ALLOW',
    method: 'update',
    path: 'notes/n1',
    auth: { uid: 'alice' },
    resource: { ownerId: 'alice', title: 'old' },
    data: { ownerId: 'alice', title: 'new' },
  },
  {
    description: 'anyone else is denied',
    expectation: 'DENY',
    method: 'update',
    path: 'notes/n1',
    auth: { uid: 'mallory' },
    resource: { ownerId: 'alice', title: 'old' },
    data: { ownerId: 'alice', title: 'stolen' },
  },
]);

console.log(`${result.passed} passed, ${result.failed} failed`); // 2 passed, 0 failed
```

## Read the verdict

Each result carries the decision and a trace of which rule made it. When a case surprises you, the trace is where you look:

```
Rule #0 (read) → deny
Rule #1 (write) → ALLOW
Simulated: ALLOW
```

And this is not only a test-time thing. While `pyric dev` runs, your `firestore.rules` is loaded into the sandbox and hot-reloaded on save, and every operation your app performs carries this same verdict.

A denial in your running app tells you the rule, the path, and the data that produced it. See [read a denial and understand it](../read-a-denial/).

## Deploy

When the answers hold, ship the same file to production with `firebase-tools`:

```bash
firebase deploy --only firestore:rules
```

Gate on error-severity lint findings in CI first (`lintFirestoreRules` / `pyric firestore rules lint`), so the mistakes that produce opaque production failures get stopped at the door.

## Where the wing goes deeper

That loop is the core. The wing deepens each step.

- [Simulate and lint before you deploy](../simulate-and-lint/). Catch the error before Firebase returns an unexplained 400 or 403.
- [Write a rules test suite](../write-a-rules-test-suite/). Turn one-off simulations into a suite that runs in CI.
- [Read a denial and understand it](../read-a-denial/). Every denial carries the rule, path, and data that produced it.
- [The rules standard library](../rules-standard-library/). Tested rule modules, composed with an import the rules language does not have.
- [Rules limits, measured](../firestore-rules-limits/). The production compiler's real limits, with numbers.
- [Audit your rules and data](../audit-your-rules/). Find the holes before someone else does.

## And from an agent

An agent working in your sandbox can call `firestore_simulate_rules` to check a request's verdict before it writes, so it verifies its own rules instead of guessing. [Work with an agent](../work-with-an-agent/) gives complete task prompts and names the evidence each tool returns.

## Where to go next

Start with [simulate and lint before you deploy](../simulate-and-lint/). When your rules matter enough to protect, give them [a test suite](../write-a-rules-test-suite/).

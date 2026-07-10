---
title: Prove a user can touch only their own data
navLabel: Secure it with rules
outcome: Write a rule, simulate a request against it, read the verdict, and deploy knowing what it allows.
status: draft
---

# Prove a user can touch only their own data

Before you deploy a ruleset, you can ask Pyric a direct question: would this specific request, from this specific user, be allowed? You get an answer, and the answer names the rule that decided it. That is the whole discipline of this wing. Not "the rules look right." Asked and answered, before production gets a vote.

Here is the loop.

## Write the rule

A notes collection. Anyone signed in can read. Only the owner can write.

```
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
import { SimulateFirestoreRulesHandler } from 'pyric/rules';

const sim = new SimulateFirestoreRulesHandler();
const { data } = sim.simulate(source, [
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

console.log(`${data.passed} passed, ${data.failed} failed`); // 2 passed, 0 failed
```

## Read the verdict

Each result carries the decision and a trace of which rule made it. When a case surprises you, the trace is where you look:

```
Rule #0 (read) → deny
Rule #1 (write) → ALLOW
Simulated: ALLOW
```

And this is not only a test-time thing. While `pyric dev` runs, your `firestore.rules` is loaded into the sandbox and hot-reloaded on save, and every operation your app performs carries this same verdict. A denial in your running app tells you the rule, the path, and the data that produced it. See [read a denial and understand it](../secure/read-a-denial.md).

## Deploy

When the answers hold, ship the same file to production:

```bash
pyric deploy rules --project my-app
```

The deploy refuses a ruleset with error-severity lint findings, so the mistakes that produce opaque production failures get stopped at the door.

## The rest of the wing

That loop is the core. The wing deepens each step.

- [Simulate and lint before you deploy](../secure/simulate-and-lint.md). Catch the error before Firebase returns an unexplained 400 or 403.
- [Write a rules test suite](../secure/write-a-rules-test-suite.md). Turn one-off simulations into a suite that runs in CI.
- [Read a denial and understand it](../secure/read-a-denial.md). Every denial carries the rule, path, and data that produced it.
- [The rules standard library](../secure/rules-standard-library.md). Tested rule modules, composed with an import the rules language does not have.
- [Rules patterns](../secure/rules-patterns.md). The techniques the hard rules are built from.
- [The limits that actually bite](../secure/limits-that-bite.md). The production compiler's real limits, with numbers.
- [Audit your rules and data](../secure/audit-your-rules.md). Find the holes before someone else does.
- [What's possible](../secure/whats-possible.md). Proof, for the reader who thinks the claims are too big.

## And from an agent

An agent working in your sandbox can call `firestore_simulate_rules` to check a request's verdict before it writes, so it verifies its own rules instead of guessing. The audit skills go further: point one at your ruleset and it hunts for holes methodically. See [skills](../agent/skills.md).

## Where to go next

Start with [simulate and lint before you deploy](../secure/simulate-and-lint.md). When your rules matter enough to protect, give them [a test suite](../secure/write-a-rules-test-suite.md).

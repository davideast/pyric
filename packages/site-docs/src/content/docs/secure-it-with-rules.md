---
title: "Prove a user can access only their own data"
navLabel: "Security Rules"
group: "Secure & debug"
section: ""
order: 3001
description: "Write a rule, run a real request against it in the sandbox, read the verdict, and deploy knowing what it allows."
---

# Prove a user can access only their own data

Before you deploy a ruleset, you can ask Pyric a direct question: would this specific request, from this specific user, be allowed? You run the request against a sandbox that holds your rules, and the denial names the rule that decided it.

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
      allow write: if request.auth.uid == request.resource.data.ownerId;
    }
  }
}
```
## Load the rule and seed the data

Boot a sandbox, hand it the rules, and seed a document to run against. No deploy, no network, no Firebase project. The backend runs in-process.
```ts
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore, sandbox as sandboxOps } from 'pyric/firestore';

const backend = initializeSandbox();
const setup = getFirestore(backend.withAuth({ uid: 'admin' }));

sandboxOps.setRules(setup, RULES);
sandboxOps.seedDocuments(setup, {
  'notes/n1': { ownerId: 'alice', title: 'old' },
});
```
`setRules` returns the lint of the ruleset. `seedDocuments` loads state directly, bypassing rules, so the request you test next runs against a document that already exists.

## Run a request as each user

Every operation carries the rules verdict. Derive a handle per identity with `withAuth`, then run the real Firestore call.
```ts
import { doc, updateDoc } from 'pyric/firestore';

const alice = getFirestore(backend.withAuth({ uid: 'alice' }));
await updateDoc(doc(alice, 'notes/n1'), { title: 'new' }); // allowed
```
Alice owns the note, so the write commits. Now run the same write as someone who does not.

## Read the denial

A denied operation throws `SandboxError` with `code: 'permission-denied'`, and it carries a `denialContext` production strips server-side.
```ts
import { SandboxError } from 'pyric/sandbox';

const mallory = getFirestore(backend.withAuth({ uid: 'mallory' }));
try {
  await updateDoc(doc(mallory, 'notes/n1'), { title: 'stolen' });
} catch (e) {
  if (e instanceof SandboxError && e.code === 'permission-denied') {
    console.log(e.denialContext?.reasons);
    console.log(e.denialContext?.request?.method, e.denialContext?.request?.path);
  }
}
```
The `reasons` are the trace of the decision, rule by rule:
```
[ 'Rule #1 (write) → deny', 'Simulated: DENY' ]
update notes/n1
```
`denialContext` also carries the `auth` that was active, the `request.resourceData` the caller tried to write, and the `resource` the rule read. It is the full eval-time picture of why the rule said no.

This is not only a test-time thing. While `pyric dev` runs, your `firestore.rules` is loaded into the sandbox and hot-reloaded on save, and every operation your app performs carries this same verdict. See [read a denial and understand it](../read-a-denial/).

## Deploy

When the answers hold, ship the same file to production:
```bash
pyric deploy rules --project my-app
```
The deploy refuses a ruleset with error-severity lint findings, so the mistakes that produce opaque production failures get stopped at the door.

## Where the wing goes deeper

That loop is the core. The wing deepens each step.

- [Simulate and lint before you deploy](../simulate-and-lint/). Catch the error before Firebase returns an unexplained 400 or 403.
- [Write a rules test suite](../write-a-rules-test-suite/). Turn one-off checks into a suite that runs in CI.
- [Read a denial and understand it](../read-a-denial/). Every denial carries the rule, path, and data that produced it.
- [The rules standard library](../rules-standard-library/). Tested rule modules, composed with an import the rules language does not have.
- [Rules patterns](../rules-patterns/). The techniques the hard rules are built from.
- [Rules compiler and evaluator limits](../limits-that-bite/). The production compiler's real limits, with numbers.
- [Audit your rules and data](../audit-your-rules/). An evidence-backed answer to who can access what.
- [Case studies](../whats-possible/). Deployed rulesets that enforce chess, connect four, and tax math.

## And from an agent

An agent working in your sandbox can run the same real operation and read the same `denialContext` before it commits anything, so it verifies its own rules instead of guessing. The audit skills go further: point one at your ruleset and it hunts for holes methodically. See [skills](../skills/).

## Where to go next

Start with [simulate and lint before you deploy](../simulate-and-lint/). When your rules matter enough to protect, give them [a test suite](../write-a-rules-test-suite/).

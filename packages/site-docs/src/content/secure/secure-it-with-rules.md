---
title: "Security Rules in Pyric"
navLabel: "Security Rules"
group: "Secure & debug"
section: ""
order: 10
description: "What Pyric gives you for Security Rules: in-process enforcement, simulation, lint, verdicts that name the rule, and tests — before anything deploys."
---

# Security Rules in Pyric

Pyric treats Security Rules as code you can run, not configuration you deploy and hope about. Everything on this page happens in-process, on your machine, with no Firebase project involved.

What you get:

- **Enforcement in the sandbox.** Every read and write your app makes during development is evaluated against your real ruleset — the same `firestore.rules`, `storage.rules`, and `database.rules.json` you will deploy. A denial in development is a denial you did not ship.
- **Verdicts that name the rule.** A denied operation doesn't return a bare `permission-denied`; the verdict says which rule decided it and why. [Read a denial](./read-a-denial.md) shows the anatomy.
- **A simulator you can ask directly.** Would this request, from this user, be allowed? Ask before deploying:

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
// 2 passed, 0 failed
```

- **Lint for the traps that parse fine.** Rules have failure modes that look correct — `resource.data` on a create, authorization read from attacker-controlled fields. The linter catches them statically.
- **Tests that keep rules honest as they change.** Simulation cases become a suite that runs with your other tests.
- **Typed authoring for RTDB.** RTDB rules composed from TypeScript constraints instead of raw JSON.

## The workflow, page by page

1. [Simulate and lint](./simulate-and-lint.md) — the core loop: change a rule, ask the simulator, read the lint findings.
2. [Read a denial](./read-a-denial.md) — what a verdict tells you when the sandbox blocks an operation.
3. [Write a rules test suite](./write-a-rules-test-suite.md) — turn simulations into regression tests.
4. [RTDB rules in TypeScript](./rtdb-rules-in-typescript.md) — typed constraints for the cascade-based RTDB model.
5. [Firestore Rules limits](./firestore-rules-limits.md) — the production compiler's real limits, with corrected examples.
6. [Audit rules and data](./audit-your-rules.md) — the pre-production sweep across rules, data, and auth config.

Deploying the ruleset stays Firebase's job — `firebase-tools` or the console. Pyric's job is that by the time you run that deploy, the ruleset has already answered for itself.

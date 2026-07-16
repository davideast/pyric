---
title: Write a Security Rules test suite
navLabel: Write a rules test suite
outcome: A suite of allow/deny cases that runs in-process, gates CI, and can escalate to Google's own engine.
status: draft
---

# Write a Security Rules test suite

A ruleset is code that decides who sees what. It deserves tests like any other code that matters.

In Pyric a rules test is a small fixture, a `TestCase`, and a whole suite runs in-process in milliseconds. No Firebase project, no network, no deploy.

## The fixtures

A `TestCase` describes one hypothetical request and the verdict you expect:

```ts
import {
  SimulateFirestoreRulesHandler,
  type TestCase,
} from 'pyric/rules';

const testCases: TestCase[] = [
  {
    description: 'authenticated read on /notes is allowed',
    expectation: 'ALLOW',
    method: 'get',
    path: 'notes/n1',
    auth: { uid: 'alice' },
  },
  {
    description: 'unauthenticated read on /notes is denied',
    expectation: 'DENY',
    method: 'get',
    path: 'notes/n1',
    // No auth field at all. request.auth is null.
  },
  {
    description: 'owner can update their own note',
    expectation: 'ALLOW',
    method: 'update',
    path: 'notes/n1',
    auth: { uid: 'alice' },
    resource: { ownerId: 'alice', title: 'old title' },
    data: { ownerId: 'alice', title: 'new title' },
  },
  {
    description: 'admin can read any admin doc',
    expectation: 'ALLOW',
    method: 'get',
    path: 'admin/config/secrets/api-keys',
    auth: { uid: 'root', token: { role: 'admin' } },
  },
];
```

The fields map straight onto what the rule sees. `resource` is the existing document, `data` is the proposed write, `auth.uid` becomes `request.auth.uid`, and `auth.token` becomes `request.auth.token` for rules that check custom claims.

## Run the suite

```ts
const sim = new SimulateFirestoreRulesHandler();
const result = sim.simulate(source, testCases);

const { passed, failed, unsupported, results } = result.data;
console.log(`${passed} passed · ${failed} failed · ${unsupported} unsupported`);
```

A failed case means the simulator's verdict disagreed with your `expectation`, and its `debugMessages` trace shows which rule decided. An `UNSUPPORTED` case means the simulator hit a feature it does not implement and abstained. It is not counted as a failure, and it is never a guess.

Two fixture fields worth knowing before your suite grows:

- For `update` and merge writes, set `writeMode` so the simulator projects the post-write document the way Firestore does.
- For rules that read `request.time`, pin `requestTime` to an ISO timestamp so the verdict does not depend on the clock. Pass `{ testCases }` to `lintFirestoreRules` and `REQUEST_TIME_NOT_PINNED` flags the cases you missed.

## Gate CI on it

The suite is a script, so CI is one exit code away:

```ts
if (!result.success || result.data.failed > 0) {
  for (const r of result.data.results) {
    if (r.state === 'FAILED') console.error(`FAILED: ${r.description}`);
  }
  process.exit(1);
}
```

Sub-millisecond per case once the rules are parsed. There is no reason not to run this on every push.

## Use Google's Rules Test API when production authority matters

The hosted Rules Test API evaluates your cases on Google's servers, in the same engine production uses, without deploying anything. It takes the same `TestCase` objects and returns the same result shape. It needs a real project and credentials:

```ts
import { TestFirestoreRulesHandler } from 'pyric/rules';
import { fromServiceAccount } from '@pyric/cli/credentials/node';

const scope = await fromServiceAccount('./service-account.json');
const remote = await new TestFirestoreRulesHandler()
  .execute(scope, source, testCases);
```

The practical pattern is local-first: run everything through the simulator, then send only the `UNSUPPORTED` cases to the hosted engine.

```ts
const escalate = testCases.filter(
  (_, i) => result.data.results[i].state === 'UNSUPPORTED',
);
if (escalate.length > 0) {
  const remote = await new TestFirestoreRulesHandler()
    .execute(scope, source, escalate);
}
```

Each hosted call is one HTTP round-trip, tens to hundreds of milliseconds. The simulator itself is held to that engine's answers by a parity corpus that runs in CI, so for most suites the local verdicts are the same verdicts, sooner.

## Run the suite through an agent

An agent can run this exact loop through `firestore_simulate_rules` and `firestore_test_rules`, which means the rules it writes arrive with a passing suite instead of a promise. See [skills](../agent/skills.md).

## Where to go next

A test failure tells you a verdict was wrong. A denial explains why. Read [read a denial and understand it](../secure/read-a-denial.md). Before those rules ship, see [ship to production](../ship/ship-to-production.md).

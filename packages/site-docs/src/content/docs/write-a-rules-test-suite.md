---
title: "Write a rules test suite"
group: "Secure & debug"
section: ""
order: 3003
description: "A suite of allow/deny cases that runs in-process, gates CI, and can escalate to Google's own engine."
---

# Write a rules test suite

A ruleset is code that decides who sees what. It deserves tests like any other code that matters.

In Pyric a rules test is a small fixture, a test case, and a whole suite runs in-process in milliseconds. No Firebase project, no network, no deploy.

## The fixtures

A test case describes one hypothetical request and the verdict you expect. The public type is `FirestoreCase`:

```ts
import { firestoreRules, assertCase, type FirestoreCase } from 'pyric/rules';

const cases: FirestoreCase[] = [
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

## Run the suite in the test runner

Compile the source once, then let each case become a test. `assertCase` throws on a miss, and its message is the trace, so a failing test tells you which rule decided:

```ts
const ruleset = firestoreRules(source);
for (const c of cases) {
  test(c.description, () => assertCase(ruleset, c));
}
```

A passing case returns `void`. A mismatch throws `RulesAssertionError`. A case that hits a feature the simulator does not implement throws `RulesUnsupportedError`, so an abstention never masquerades as a pass.

Prefer a summary over per-case tests? Run every case at once and read the counts:

```ts
const summary = firestoreRules(source).simulate(cases);
console.log(`${summary.passed} passed · ${summary.failed} failed · ${summary.unsupported} unsupported`);
```

`simulate` returns a `SimulationSummary`: the three counts plus a `cases` array of results. A result whose `passed` is `false` disagreed with your `expectation`. One whose `unsupported` is `true` abstained, and is not counted as a failure.

Two fixture fields worth knowing before your suite grows:

- For `update` and merge writes, set `writeMode` so the simulator projects the post-write document the way Firestore does.
- For rules that read `request.time`, pin `requestTime` to an ISO timestamp so the verdict does not depend on the clock.

## Gate CI on it

The suite is a script, so CI is one exit code away. `explainCase` renders any result as a readable trace, so a failure prints its own reason:

```ts
import { explainCase } from 'pyric/rules';

const summary = firestoreRules(source).simulate(cases);
if (summary.failed > 0) {
  for (const r of summary.cases) {
    if (!r.passed && !r.unsupported) console.error(explainCase(r));
  }
  process.exit(1);
}
```

Sub-millisecond per case once the rules are parsed. There is no reason not to run this on every push.

You can also run a scripted suite from the command line. `pyric rules:simulate --stdin` reads a JSON `{ source, testCases }` request and prints each verdict, which keeps rules out of your test-runner setup when you want a standalone check.

## Escalate to Google's Rules Test API

The hosted Rules Test API evaluates cases on Google's servers, in the same engine production uses, without deploying anything. It is Firestore-only and needs a real project and credentials. Reach it through `pyric verify`: replay a captured session against both engines and it reports any divergence.

```bash
pyric verify journeys/checkout.json --engine both --project demo-app
```

`--engine sandbox` (the default) runs the local simulator, `--engine rules-test-api` runs Google's, and `--engine both` runs each and diffs the verdicts. The practical pattern is local-first: run the sandbox on every push, and reserve the hosted engine for the cases the simulator marked `unsupported`.

The simulator itself is held to that engine's answers by a parity corpus that runs in CI, so for most suites the local verdicts are the same verdicts, sooner.

## Prove a rules suite from an agent

An agent can run this exact loop: compile with `firestoreRules`, assert each case with `assertCase`, and read the `explainCase` trace on any miss. The rules it writes then arrive with a passing suite instead of a promise, and it can escalate the same cases to Google's engine through `pyric verify` when it needs the authoritative answer. See [skills](../skills/).

## Where to go next

A test failure tells you a verdict was wrong. A denial explains why. Read [read a denial and understand it](../read-a-denial/). Before those rules ship, see [ship to production](../ship-to-production/).

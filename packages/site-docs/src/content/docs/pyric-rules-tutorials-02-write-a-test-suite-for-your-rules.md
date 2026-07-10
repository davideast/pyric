---
title: "Write a test suite for your rules"
navLabel: "Write a rules test suite"
group: "pyric / rules"
section: "Tutorials"
order: 94
---
# Write a test suite for your rules

In this tutorial you will pick up where [Lint your first rules file](../pyric-rules-tutorials-01-lint-your-first-rules-file/) left off and add a suite of test cases. You will use the in-process simulator — `SimulateFirestoreRulesHandler` — so the whole loop stays local. No Firebase project, no network, no deployment.

By the end you will have a script that:

1. Loads a rules file.
2. Runs a list of `TestCase` objects against the rules.
3. Reports passes, failures, and `UNSUPPORTED` cases.

This tutorial assumes you completed Tutorial 1 and still have the `rules-lint-tutorial` folder. If not, copy the final `firestore.rules` from that tutorial first.

## What you will build

A `simulate.ts` script that exercises a handful of allow/deny scenarios against your rules and prints a pass/fail summary.

## Step 1 — A clean rules file

Make sure your `firestore.rules` looks like this:
```rules
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {

    match /notes/{noteId} {
      allow read: if request.auth != null;
      allow write: if request.auth.uid == resource.data.ownerId;
    }

    match /admin/{document=**} {
      allow read, write: if request.auth.token.role == 'admin';
    }
  }
}
```
Lint it first — you should see zero warnings. (If you skip the lint, the simulator will still run, but you've lost the chance to catch a syntax error before you scaffolded ten tests around it.)

## Step 2 — Write your first test case

Create `simulate.ts`:
```ts
import { readFileSync } from 'node:fs';
import {
  SimulateFirestoreRulesHandler,
  type TestCase,
} from 'pyric/rules';

const source = readFileSync('./firestore.rules', 'utf-8');

const testCases: TestCase[] = [
  {
    description: 'authenticated read on /notes is allowed',
    expectation: 'ALLOW',
    method: 'get',
    path: 'notes/n1',
    auth: { uid: 'alice' },
  },
];

const sim = new SimulateFirestoreRulesHandler();
const result = sim.simulate(source, testCases);

if (!result.success) {
  console.error('Simulation failed:', result.error);
  process.exit(1);
}

const { passed, failed, unsupported, results } = result.data;
console.log(`${passed} passed · ${failed} failed · ${unsupported} unsupported`);
for (const r of results) {
  console.log(`  [${r.state}] ${r.description}`);
}
```
Run it:
```bash
bun run simulate.ts
```
You will see:
```
1 passed · 0 failed · 0 unsupported
  [PASSED] authenticated read on /notes is allowed
```
Notice what just happened: the simulator parsed the rules, resolved the match block for `notes/n1`, built a request with `auth.uid = 'alice'`, evaluated the `allow read` rule, decided `ALLOW`, and compared that to your `expectation`. They matched, so the case passed.

## Step 3 — Add a deny case

Add a second case to your `testCases` array — an unauthenticated read:
```ts
{
  description: 'unauthenticated read on /notes is denied',
  expectation: 'DENY',
  method: 'get',
  path: 'notes/n1',
  // No `auth` field at all → request.auth is null.
},
```
Re-run. You will see `2 passed · 0 failed`. The rule denied (because `request.auth != null` is false), and your test expected `DENY`, so the case passes.

## Step 4 — Add a write case (with a `resource`)

Write rules care about both the existing document (`resource`) and the proposed update (`data`). To test the ownership rule on `/notes`, you need to supply a pre-existing resource.

Add this case:
```ts
{
  description: 'owner can update their own note',
  expectation: 'ALLOW',
  method: 'update',
  path: 'notes/n1',
  auth: { uid: 'alice' },
  resource: { ownerId: 'alice', title: 'old title' },
  data: { ownerId: 'alice', title: 'new title' },
},
```
And a deny counterpart:
```ts
{
  description: 'non-owner cannot update someone else\'s note',
  expectation: 'DENY',
  method: 'update',
  path: 'notes/n1',
  auth: { uid: 'mallory' },
  resource: { ownerId: 'alice', title: 'old title' },
  data: { ownerId: 'alice', title: 'new title' },
},
```
Re-run. All four cases should pass:
```
4 passed · 0 failed · 0 unsupported
```
Watch what your test data is doing:

- `resource` is the existing document (referenced by the rule as `resource.data.ownerId`).
- `data` is what the writer is sending (referenced as `request.resource.data` — though this rule doesn't check it).
- `auth.uid` populates `request.auth.uid`.

## Step 5 — A test for the admin block

Admin rules check the auth *token*, not just the UID. Add a case where the user has the admin custom claim:
```ts
{
  description: 'admin can read any admin doc',
  expectation: 'ALLOW',
  method: 'get',
  path: 'admin/config/secrets/api-keys',
  auth: { uid: 'root', token: { role: 'admin' } },
},
```
The `token` field on `auth` becomes `request.auth.token` in the rules engine. The path uses the recursive wildcard, so a deep path like `admin/config/secrets/api-keys` resolves correctly.

Re-run — five passes.

## Step 6 — Watch a failure happen on purpose

To see what a failure looks like, change the last case's expectation from `ALLOW` to `DENY` and re-run:
```
4 passed · 1 failed · 0 unsupported
  [PASSED] authenticated read on /notes is allowed
  [PASSED] unauthenticated read on /notes is denied
  [PASSED] owner can update their own note
  [PASSED] non-owner cannot update someone else's note
  [FAILED] admin can read any admin doc
```
The simulator decided `ALLOW`. Your expectation said `DENY`. They disagreed, so the state is `FAILED`. The `result.data.results[i].debugMessages` array contains a trace if you want to see which rule allowed and which denied:
```ts
console.log(result.data.results[4].debugMessages);
// [
//   "Rule #0 (read,write) → ALLOW",
//   "Simulated: ALLOW",
// ]
```
Flip the expectation back to `ALLOW` when you're done.

## Step 7 — A glimpse of `UNSUPPORTED`

The local simulator implements most of the rules language, but not everything. When it hits a feature it doesn't yet handle (some namespace methods, certain wrappers), it returns `state: 'UNSUPPORTED'` instead of pretending to decide. That distinction matters: an `UNSUPPORTED` result is the simulator abstaining, not your rule failing.

If you ever see `UNSUPPORTED` cases in your suite and you need a verdict, route those cases to the real Firebase Rules Test API — see [Test rules against the Firebase Rules Test API](../pyric-rules-how-to-test-rules-against-firebase/). For most agent-authored rules, the simulator is enough.

## What you have learned

- `SimulateFirestoreRulesHandler.simulate(source, testCases)` runs an entire test suite in-process.
- A `TestCase` is a small object: `description`, `expectation`, `method`, `path`, plus optional `auth`, `resource`, and `data`.
- `resource` is the *existing* document; `data` is the *proposed* write.
- Each result lands in one of three states: `PASSED`, `FAILED`, or `UNSUPPORTED`.

## What to do next

You now have rules and tests for them, all running locally. To take this further:

- Run the same tests against the real Firebase Rules Test API — see [Test rules against the Firebase Rules Test API](../pyric-rules-how-to-test-rules-against-firebase/).
- Pin `request.time` so date-gated rules aren't flaky in CI — see [Pin `request.time` for deterministic tests](../pyric-rules-how-to-pin-request-time/).
- Use the stdlib of pre-built rule helpers — see [Resolve `2+modules` imports](../pyric-rules-how-to-resolve-module-imports/).
- Understand the difference between linting, validating, simulating, and testing — see [Lint vs validate vs simulate vs test](../pyric-rules-explanation-lint-vs-validate-vs-simulate-vs-test/).

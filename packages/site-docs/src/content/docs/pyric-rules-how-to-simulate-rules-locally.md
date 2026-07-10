---
title: "How to simulate rules locally"
navLabel: "Simulate rules locally"
group: "pyric / rules"
section: "How-to"
order: 101
---
# How to simulate rules locally

This guide shows you how to evaluate Firestore rules in-process against a list of test cases, without deploying or contacting Google's servers.

## Run a suite
```ts
import {
  SimulateFirestoreRulesHandler,
  type TestCase,
} from 'pyric/rules';

const handler = new SimulateFirestoreRulesHandler();
const result = handler.simulate(source, testCases);
```
If `result.success` is `false`, the source failed to parse — `result.error.code` is `'PARSE_FAILED'`. Otherwise `result.data` carries `{ passed, failed, unsupported, results }`.

## Mock `get()` and `exists()`

When a rule calls `get(/databases/$(db)/documents/users/$(uid))`, the simulator looks the result up in your test case's `functionMocks`. Provide them by document path:
```ts
const testCases: TestCase[] = [
  {
    description: 'admin can read locked doc',
    expectation: 'ALLOW',
    method: 'get',
    path: 'locked/x',
    auth: { uid: 'alice' },
    functionMocks: [
      { function: 'get', path: 'users/alice', result: { role: 'admin' } },
      { function: 'exists', path: 'audit/last-run', result: true },
    ],
  },
];
```
For `get`, supply the document's data. For `exists`, supply a boolean. Paths are relative; the simulator handles the `/databases/(default)/documents/` prefix internally.

## Set `writeMode` for accurate update semantics

By default, `tc.data` IS the after-state — fine for shallow `create`. For `update` or `set({ merge: true })`, set `writeMode` so the simulator projects the post-write document correctly:
```ts
{
  description: 'patch a single field',
  expectation: 'ALLOW',
  method: 'update',
  path: 'notes/n1',
  auth: { uid: 'alice' },
  resource: { ownerId: 'alice', title: 'old', archived: false },
  data: { title: 'new' },
  writeMode: { kind: 'update' },  // ← merges data into resource
},
```
Without `writeMode`, `request.resource.data.archived` would read as `null`. With it, the simulator runs the same merge logic the admin SDK does. See [`TestCase` schema](../pyric-rules-reference-test-case-schema/#writemode) for all four modes.

## Pin `request.time` for date-gated rules

Any rule that reads `request.time` will evaluate against wallclock unless you pin it:
```ts
{
  description: 'within trial window',
  expectation: 'ALLOW',
  method: 'create',
  path: 'orders/o1',
  auth: { uid: 'alice' },
  data: { amount: 100 },
  requestTime: '2026-04-15T12:00:00Z',  // ← ISO-8601
},
```
Run `lintFirestoreRules(source, { testCases })` and look for `REQUEST_TIME_NOT_PINNED` to catch unpinned cases early.

## Populate `request.query` for `list`

`list` rules can read `request.query.limit / .offset / .orderBy`. Without `query` those fields read `null` and `request.query.limit < 100` becomes `null < 100 → false → DENY`. Set what your rule reads:
```ts
{
  description: 'paged list under cap',
  expectation: 'ALLOW',
  method: 'list',
  path: 'notes/n1',
  auth: { uid: 'alice' },
  query: { limit: 25 },
},
```
## Handle `UNSUPPORTED` results

`UNSUPPORTED` means the simulator hit a feature it does not yet implement — not that your rule is wrong. It is *not* counted as a failure. If you have unsupported cases and need a verdict for them, route those cases to the live Rules Test API:
```ts
const unsupported = result.data.results
  .filter((r) => r.state === 'UNSUPPORTED');

if (unsupported.length > 0) {
  // Run these against the Rules Test API — see the test-rules-against-firebase guide.
}
```
See [Simulator vs Rules Test API](../pyric-rules-explanation-simulator-vs-rules-test-api/) for the full discussion.

## Read the debug trace

Each result carries `debugMessages` — useful when a case fails and you can't tell which rule decided:
```ts
for (const r of result.data.results) {
  if (r.state !== 'PASSED') {
    console.log(`[${r.state}] ${r.description}`);
    for (const msg of r.debugMessages) console.log(`  · ${msg}`);
  }
}
```
A typical trace:
```
Rule #0 (read) → deny
Rule #1 (write) → ALLOW
Simulated: ALLOW
```
## Where to look next

- For the field-by-field schema of `TestCase`, see [`TestCase` schema](../pyric-rules-reference-test-case-schema/).
- For the shape of `SimulationContext` (what your rule actually sees), see [Simulator context](../pyric-rules-reference-simulator-context/).
- For why some features return `UNSUPPORTED`, see [Simulator vs Rules Test API](../pyric-rules-explanation-simulator-vs-rules-test-api/).

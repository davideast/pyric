---
title: "How to pin request.time for deterministic tests"
navLabel: "Pin request.time"
group: "pyric / rules"
section: "How-to"
order: 95
---
# How to pin `request.time` for deterministic tests

A rule that reads `request.time` evaluates against wallclock by default. That makes any date-gated test flaky: the same `TestCase` run twice can decide `ALLOW` once and `DENY` the next. Pin time and the verdict is reproducible.

## Set `requestTime` on every affected `TestCase`

`requestTime` accepts an ISO-8601 string. The simulator parses it into a `Timestamp` and uses it for `request.time`:
```ts
const testCases: TestCase[] = [
  {
    description: 'inside the trial window',
    expectation: 'ALLOW',
    method: 'create',
    path: 'orders/o1',
    auth: { uid: 'alice' },
    data: { amount: 100 },
    requestTime: '2026-04-15T12:00:00Z',
  },
  {
    description: 'after the trial window',
    expectation: 'DENY',
    method: 'create',
    path: 'orders/o1',
    auth: { uid: 'alice' },
    data: { amount: 100 },
    requestTime: '2026-05-15T12:00:00Z',
  },
];
```
The same ISO string is forwarded to the Firebase Rules Test API when you run via `TestFirestoreRulesHandler`, so the two evaluation paths stay in agreement.

## Find unpinned cases automatically

Pass the test suite to the linter and look for `REQUEST_TIME_NOT_PINNED`:
```ts
import { lintFirestoreRules } from 'pyric/rules';

const result = lintFirestoreRules(source, { testCases });
const unpinned = result.warnings.filter((w) => w.rule === 'REQUEST_TIME_NOT_PINNED');

for (const w of unpinned) {
  console.warn(w.message);
  // Output:
  // Test case "<description>" targets rule #<n> (path '<p>') which reads
  // request.time, but does not set requestTime. Result is non-deterministic
  // across runs.
}
```
The linter only flags a case if its `path` actually matches a rule that reads `request.time`. Cases that target unrelated paths aren't reported.

## When `requestTime` doesn't help

`requestTime` only fixes `request.time`. If your rule reads `resource.data.createdAt` and that field was populated by `FieldValue.serverTimestamp()`, the simulator resolves the sentinel using the same pinned time. But if your test data hardcodes a different timestamp, the comparison uses that. Make the resource value match what the rule expects to see.

## Where to look next

- For the timestamp value model, see [`Timestamp` in the value wrappers reference](../pyric-rules-reference-value-wrappers/#timestamp).
- For the `TestCase` schema field, see [`requestTime` in the `TestCase` schema](../pyric-rules-reference-test-case-schema/).

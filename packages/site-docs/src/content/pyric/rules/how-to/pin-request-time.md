---
navLabel: "Pin request.time"
---
# How to pin `request.time` for deterministic tests

A rule that reads `request.time` evaluates against wallclock by default. That makes any date-gated test flaky: the same `FirestoreCase` run twice can decide `ALLOW` once and `DENY` the next. Pin time and the verdict is reproducible.

## Set `requestTime` on every affected `FirestoreCase`

`requestTime` accepts an ISO-8601 string. The simulator parses it into a `Timestamp` and uses it for `request.time`:

```ts
import type { FirestoreCase } from 'pyric/rules';

const testCases: FirestoreCase[] = [
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

The same ISO string is forwarded to the Firebase Rules Test API when you run via the internal `TestFirestoreRulesHandler` (`pyric/rules/internal`), so the two evaluation paths stay in agreement.

## Find unpinned cases automatically

Pass the test suite to the linter and look for `REQUEST_TIME_NOT_PINNED`. The public `lint(source)` and `firestoreRules(source).lint()` don't take a `testCases` option, so this check runs through the engine-internal `lintFirestoreRules`:

```ts
import { lintFirestoreRules } from 'pyric/rules/internal';

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

- For the timestamp value model, see [`Timestamp` in the value wrappers reference](../reference/value-wrappers.md#timestamp).
- For the `TestCase` schema field, see [`requestTime` in the `TestCase` schema](../reference/test-case-schema.md#requesttime).

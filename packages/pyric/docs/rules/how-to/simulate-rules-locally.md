---
navLabel: "Simulate rules locally"
---
# How to simulate rules locally

Evaluate Firestore rules in-process against a list of test cases, without deploying or contacting Google's servers.

## Run a suite

```ts
import { firestoreRules } from 'pyric/rules';

const ruleset = firestoreRules(source); // throws RulesCompileError if source doesn't parse

const { passed, failed, unsupported, cases } = ruleset.simulate(testCases);
```

`firestoreRules(source)` throws `RulesCompileError` (carrying `.issues: RuleIssue[]`) if the source doesn't parse. Past that point, `simulate` never throws on a rule outcome: `cases` is a `CaseResult[]`, one entry per input case, each with `passed`, `unsupported`, `decision`, `trace`, and `notes`.

## Mock `get()` and `exists()`

When a rule calls `get(/databases/$(db)/documents/users/$(uid))`, the simulator looks the result up in your case's `functionMocks`. Provide them by document path:

```ts
import type { FirestoreCase } from 'pyric/rules';

const testCases: FirestoreCase[] = [
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

By default, `tc.data` IS the after-state, which is fine for shallow `create`. For `update` or `set({ merge: true })`, set `writeMode` so the simulator projects the post-write document correctly:

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

Without `writeMode`, `request.resource.data.archived` would read as `null`. With it, the simulator runs the same merge logic the admin SDK does. See [`FirestoreCase` schema](../reference/test-case-schema.md#writemode) for all four modes.

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

To catch unpinned cases early, run the engine-internal `lintFirestoreRules(source, { testCases })` from `pyric/rules/internal` and look for `REQUEST_TIME_NOT_PINNED`; the public `lint(source)` and `firestoreRules(source).lint()` don't take a `testCases` option. See [Pin `request.time` for deterministic tests](./pin-request-time.md).

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

## Handle unsupported results

An unsupported result means the simulator hit a feature it does not yet implement, not that your rule is wrong. It is *not* counted as a failure: `unsupported` is tallied separately from `failed` in the summary, and `passed` stays `false` on that case's `CaseResult`. If you have unsupported cases and need a verdict for them, route those cases to the live Rules Test API:

```ts
const needsEscalation = cases.filter((c) => c.unsupported).map((c) => c.case);

if (needsEscalation.length > 0) {
  // Run these against the Rules Test API — see the test-rules-against-firebase guide.
}
```

See [Simulator vs Rules Test API](../explanation/simulator-vs-rules-test-api.md) for the full discussion.

## Read the trace

Each `CaseResult` carries a `trace` (per-rule evaluation entries) and `notes` (top-level diagnostic strings), useful when a case fails and you can't tell which rule decided. `explainCase` renders both into one human-readable string, the same renderer `assertCase` uses as its thrown error's message:

```ts
import { explainCase } from 'pyric/rules';

for (const c of cases) {
  if (!c.passed) console.log(explainCase(c));
}
```

A typical trace:

```
FAIL: locked doc read
  get locked/x (expected ALLOW, got DENY)
  rules evaluated:
    #0 (read) [locked/{id}] (line 4) -> DENY: request.auth.uid == 'admin'
```

For a single case, `ruleset.explain(oneCase)` runs it and returns the same structured `Explanation` without needing to slice it out of a batch result.

## Where to look next

- For the field-by-field schema of `FirestoreCase`, see [`FirestoreCase` schema](../reference/test-case-schema.md).
- For the shape of `SimulationContext` (what your rule actually sees, engine-internal), see [Simulator context](../reference/simulator-context.md).
- For why some features return unsupported, see [Simulator vs Rules Test API](../explanation/simulator-vs-rules-test-api.md).

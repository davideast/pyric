# Simulator vs Rules Test API

Two surfaces evaluate rules against test cases. Underneath, they share a case shape and a result vocabulary; they disagree on tradeoffs. Choosing between them is a deliberate decision, not an implementation detail.

## The shared surface

The public front door only fronts one of the two: `firestoreRules(source).simulate(cases)` runs the local simulator, takes `FirestoreCase[]`, and returns a `SimulationSummary` (`{ passed, failed, unsupported, cases: CaseResult[] }`) that never carries a thrown-error branch, since a parse failure already threw `RulesCompileError` at construction.

Use `firestoreRules(source).simulate(cases)` for local evaluation. The hosted Rules Test API and local engine share their case and result vocabulary one level down on `pyric/rules/internal`, but those handler classes are not the preferred public API.

```ts
type TestFirestoreRulesResult =
  | { success: true; data: { passed; failed; unsupported; results } }
  | { success: false; error: { code; message; recoverable } };
```

Each `TestResult` in `results` carries `description`, `expectation`, `state`, and `debugMessages`. The `state` is `'PASSED' | 'FAILED' | 'UNSUPPORTED'`.

The shared internal shape is a feature. You can swap one internal handler for the other, or route the same test suite to both, without rewriting any test-case code. See [How to test rules against the Firebase Rules Test API](../how-to/test-rules-against-firebase.md) for the escalation pattern built on the public `simulate` plus the internal test-API client.

## What they disagree on

| Axis | Local simulator | Rules Test API |
|---|---|---|
| Where it runs | In-process | Google's servers |
| Latency per call | Sub-millisecond | Tens to hundreds of milliseconds |
| Credentials required | None | `ProjectScope` with `firebaserules.releases.test` |
| Parity with production | Close, not bit-for-bit | Bit-for-bit |
| Returns `UNSUPPORTED`? | Yes, when it hits an unimplemented feature | Never |
| Side effects | None | None (the API evaluates, it doesn't deploy) |
| Cost | Free | Costs of the Cloud API call |

## When the simulator returns `UNSUPPORTED`

The local simulator implements most of the rules language: literals, identifiers, member access, method calls, all the binary and unary operators, function definitions with let bindings, all the standard built-ins (`get`, `exists`, `getAfter`, `existsAfter`, `debug`, `request.auth`, `request.resource`, `resource`, path literals, the type-test `is` operator). It does **not** implement every namespace method on every wrapper type. `duration.value(...).abs()` works, some less-common `bytes` arithmetic does not.

When the evaluator hits a method or operation it doesn't model, it throws `UnsupportedError` rather than guessing. The handler catches that and surfaces it as an abstention: `state: 'UNSUPPORTED'` internally, `unsupported: true` on the public `CaseResult`. The semantics is "the gap is on my side, not yours". An unsupported case is **not** counted as a failure: `failed` and `unsupported` are separate counters on both the internal result and the public `SimulationSummary`.

The right response to `UNSUPPORTED` depends on context:

- **Agent loops** can treat `UNSUPPORTED` as "don't know, ask the API". A common pattern is to run locally first, then escalate only the unsupported subset to the live API.
- **CI** can treat `UNSUPPORTED` as a build-time signal: "this rule uses a feature the simulator doesn't model, so switch this case to the live API or restructure the rule".
- **Local development** can ignore `UNSUPPORTED` until the rule is otherwise correct, then verify against the API once.

## When the simulator is wrong

It does happen. The simulator is a re-implementation of the rules engine, not a transcription. Areas where production has surprised us:

- **Timestamp precision**: `request.time` in production has nanosecond precision; our `Timestamp` wrapper carries it, but agents that round to milliseconds in their test data can produce `request.time != data.createdAt` when production would say they're equal.
- **Map field access on absent keys**: production's behaviour on `request.resource.data.maybeAbsent.subfield` has edge cases around the absent-vs-null distinction that we approximate. Tests that depend on this should run against the live API.
- **`getAfter()` projection corners**: we project the post-write document using `projectAfterState`, which mirrors the admin SDK's merge semantics. Production's projection is implementation-defined.

When the simulator and the API disagree, we treat the API as authoritative and fix the simulator. The integration test suite (`parity-stress-integration.test.ts`) deliberately runs both against the same cases to catch drift.

## When to prefer each

**Reach for the simulator first** when:

- You're iterating on a rule and want fast feedback.
- You don't have credentials (browser sandbox, local dev, untrusted CI).
- You're testing hundreds of cases and the API would be cost-prohibitive.

**Reach for the test API** when:

- The simulator returned `UNSUPPORTED` for cases you need verdicts on.
- You're at the end of a deploy pipeline and want absolute parity.
- You're investigating a production discrepancy.

The fastest agent loops use simulator-first with `UNSUPPORTED` escalation:

```ts
const local = firestoreRules(source).simulate(testCases);
const escalate = local.cases.filter((c) => c.unsupported).map((c) => c.case);
if (escalate.length > 0) {
  const remote = await api.execute(scope, source, escalate);
  // merge remote.data.results back into local.cases by matching case
}
```

Local-first keeps the inner loop in sub-millisecond territory; the API is only paid when the simulator genuinely can't decide.

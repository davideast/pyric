---
title: "Simulator context and result states"
navLabel: "Simulator context"
group: "pyric / rules"
section: "Reference"
order: 13015
---
# Simulator context and result states

The simulator evaluates expressions against a `SimulationContext`. This page describes its shape and the three result states a test case can land in. `SimulationContext` and `evaluate` are engine-internal, reached through `pyric/rules/internal`; the public front door is `firestoreRules(source).simulate(cases)` / `.explain(oneCase)`, which builds and consumes this context internally and returns a `CaseResult` / `Explanation` instead. This page documents the internals for callers who need them directly, and to explain what the public result fields mean underneath.

## `SimulationContext`

```ts
interface SimulationContext {
  request: SimRequest;
  resource: SimResource;
  mockDocuments: Map<string, Record<string, unknown>>;
  pathVariables: Record<string, string>;
  functions: Map<string, FunctionDef>;
  database: string;
  afterStatePath: Path;
  afterState: Record<string, unknown> | null;
  existsAfter: boolean;
}
```

You don't construct this directly. `SimulateFirestoreRulesHandler.simulate` builds it from each case. The shape is documented because `evaluate(expression, ctx)` is exported from `pyric/rules/internal`, so callers writing custom evaluators do need to build it.

### `request: SimRequest`

```ts
interface SimRequest {
  auth: { uid: string; token: Record<string, unknown> } | null;
  resource: { data: Record<string, unknown> };   // proposed write payload
  method: string;
  path: Path;          // full Path including /databases/(default)/documents
  query: Record<string, unknown>;
  time: Timestamp;
}
```

The rule sees this as `request`. `request.auth` is `null` for unauthenticated cases.

### `resource: SimResource`

```ts
interface SimResource {
  data: Record<string, unknown>;   // existing document data
  id: string;                      // last segment of the path
  __name__: Path;                  // full Path
}
```

The rule sees this as `resource`. On `create`, `resource.data` is `{}` and `existsAfter` is `true` for the post-write doc.

### `mockDocuments`

Keyed by the *full* document path (including the database prefix). `get()` and `exists()` look here first. Built from `TestCase.functionMocks`.

### `pathVariables`

The match-block wildcard bindings (e.g. `{ uid: 'alice' }` when matching `/users/{uid}` against `/users/alice`). Plus an injected `database: '(default)'`.

### `functions`

Function definitions visible at the matched scope: parent-match functions, this-match functions, and any inlined modules.

### `afterStatePath`, `afterState`, `existsAfter`

The projected post-write document for `getAfter()` / `existsAfter()`. When the rule calls those built-ins with `request.path`, they return `afterState` / `existsAfter`. With any other path they fall through to `get()` / `exists()` against the same data. Unrelated docs aren't mutated by the write under evaluation.

## Result states

Every case lands in one of three states. Internally these are the engine's `PASSED` / `FAILED` / `UNSUPPORTED` `TestResult.state` values; on the public `CaseResult` (from `firestoreRules(source).simulate(cases)`) they show up as the `passed` and `unsupported` booleans plus a `decision: 'ALLOW' | 'DENY' | 'UNSUPPORTED'` field, and `SimulationSummary` tallies them into `passed` / `failed` / `unsupported` counts.

### `PASSED`

The simulator's decision matched the case's `expectation`. The expected outcome was reached. On the public result: `passed: true`.

### `FAILED`

The simulator's decision was the opposite of `expectation`. The rule allowed when you expected deny, or denied when you expected allow. The `trace` field on the public `CaseResult` carries the rule-by-rule account of which rule decided.

### `UNSUPPORTED`

The simulator encountered a feature it does not yet implement and chose to abstain rather than guess. **`UNSUPPORTED` is not `FAILED`**. The simulator is saying "the gap is on my side". On the public result: `unsupported: true`, `passed: false`, tallied separately from `failed` in `SimulationSummary`.

When you see `UNSUPPORTED`, you have three options:

1. Trust the rule and skip the case in local CI.
2. Reformulate the rule to avoid the unsupported feature.
3. Route only the unsupported cases to the Firebase Rules Test API. See [How to test rules against the Firebase Rules Test API](../pyric-rules-how-to-test-rules-against-firebase/).

The live Rules Test API never returns `UNSUPPORTED`. It uses the production engine and decides every case.

## Decision precedence within a match block

Multiple `allow` rules in the same match block use **OR semantics**:

- Any rule decides `ALLOW` → final decision is `ALLOW` (evaluation short-circuits).
- Otherwise, if any rule threw `UnsupportedError` → final decision is `UNSUPPORTED`.
- Otherwise → `DENY`.

Real evaluation errors (`EvalError`, type mismatches) are caught and treated as that rule denying, matching production's behaviour where runtime errors deny the request.

## Path resolution

The simulator walks the AST from the root match (`/databases/{database}/documents`), trying each child's path pattern against the test case's path segments. The first child that consumes all segments wins. Recursive wildcards (`{x=**}`) consume every remaining segment in one bite.

When no match block accepts the path, the case is treated as a deny (`PASSED` if `expectation === 'DENY'`, otherwise `FAILED`). The debug messages note `No match block found`.

# Simulator context and result states

The simulator evaluates expressions against a `SimulationContext`. This page describes its shape and the three result states a test case can land in.

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

You don't construct this directly — `SimulateFirestoreRulesHandler.simulate` builds it from each `TestCase`. The shape is documented because `evaluate(expression, ctx)` is exported, so callers writing custom evaluators do need to build it.

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

The projected post-write document for `getAfter()` / `existsAfter()`. When the rule calls those built-ins with `request.path`, they return `afterState` / `existsAfter`. With any other path they fall through to `get()` / `exists()` against the same data — unrelated docs aren't mutated by the write under evaluation.

## Result states

Every test case lands in one of three states.

### `PASSED`

The simulator's decision matched the case's `expectation`. The expected outcome was reached.

### `FAILED`

The simulator's decision was the opposite of `expectation`. The rule allowed when you expected deny, or denied when you expected allow. `result.debugMessages` carries a trace of which rule decided.

### `UNSUPPORTED`

The simulator encountered a feature it does not yet implement and chose to abstain rather than guess. **`UNSUPPORTED` is not `FAILED`** — the simulator is saying "the gap is on my side". The `data.unsupported` counter tracks these separately from `failed`.

When you see `UNSUPPORTED`, you have three options:

1. Trust the rule and skip the case in local CI.
2. Reformulate the rule to avoid the unsupported feature.
3. Route just the unsupported cases to the Firebase Rules Test API — see [How to test rules against the Firebase Rules Test API](../how-to/test-rules-against-firebase.md).

The live Rules Test API never returns `UNSUPPORTED` — it uses the production engine and decides every case.

## Decision precedence within a match block

Multiple `allow` rules in the same match block use **OR semantics**:

- Any rule decides `ALLOW` → final decision is `ALLOW` (evaluation short-circuits).
- Otherwise, if any rule threw `UnsupportedError` → final decision is `UNSUPPORTED`.
- Otherwise → `DENY`.

Real evaluation errors (`EvalError`, type mismatches) are caught and treated as that rule denying — matching production's behaviour where runtime errors deny the request.

## Path resolution

The simulator walks the AST from the root match (`/databases/{database}/documents`), trying each child's path pattern against the test case's path segments. The first child that consumes all segments wins. Recursive wildcards (`{x=**}`) consume every remaining segment in one bite.

When no match block accepts the path, the case is treated as a deny (`PASSED` if `expectation === 'DENY'`, otherwise `FAILED`). The debug messages note `No match block found`.

---
title: "Lint rules"
group: "pyric / rules"
section: "Reference"
order: 105
---
# Lint rules

This page lists every lint rule emitted by `lintFirestoreRules`. Each entry gives the rule code, default severity, what it detects, and the suggested fix.

Severities have two values:

- `error`: blocks deploys in `pyric-tools/deploy`.
- `warning`: advisory; does not block.

Some rules adjust severity by threshold band; those entries note the bands explicitly.

## Compilation-limit rules

These catch sources that Firebase will reject with `400 INVALID_ARGUMENT` at deploy.

### `SOURCE_SIZE`

- **Severity**: `error`.
- **Threshold**: source length > 256 × 1024 bytes (262 144).
- **Detection**: byte length of the input string.
- **Fix**: split into smaller match blocks, reduce string literals.

### `CHAIN_DEPTH`

- **Severity**: `warning` at chain depth ≥ 85, `error` at ≥ 95, `error` at ≥ 98.
- **Threshold**: 98 (the exact compile limit).
- **Detection**: the deepest flat `&&` or `||` chain in any function body or let value.
- **Fix**: nest into groups. `a && b && c && d` → `(a && b) && (c && d)` halves the chain depth.

### `LET_LIMIT`

- **Severity**: `error`.
- **Threshold**: 11 let bindings per function (12 fails the compile).
- **Fix**: inline some let expressions into the return, or split the function in two.

## Runtime-budget rules

These catch sources that compile fine but exhaust the runtime evaluation budget for some inputs (silent `403`).

### `SHARED_GATE`

- **Severity**: `warning`.
- **Detection**: two or more `allow` rules in the same match block whose first expression is structurally identical.
- **Fix**: give each rule a unique discriminator (different `moveType`, different status check) so the engine can route to one rule and short-circuit out of the others.

### `EXPRESSION_BUDGET`

- **Severity**: `warning` (never `error`, because the runtime budget is non-deterministic).
- **Threshold**: depends on function-call count, with conservative bands:
  - 1 or 2 function calls → warn at ~100 total expression nodes.
  - 3 function calls → warn at ~60.
  - 4+ function calls → warn at ~40.
- **Detection**: walk the rule's condition counting expression nodes, follow function calls transitively (each call visited at most once). Multiply by a discount factor for rules with many top-level `||` branches to avoid false positives on well-gated trees.
- **Fix**: reduce the number of function calls, or restructure the predicate so fewer nodes are evaluated per request.

### `CALL_DEPTH`

- **Severity**: `warning` at depth ≥ 6, `error` at ≥ 10.
- **Detection**: the deepest function-call chain reachable from a rule's condition through the static call graph.
- **Fix**: inline intermediate helpers.

### `GET_COUNT`

- **Severity**: `warning` at ≥ 5, `error` at ≥ 10 (documented Firestore limit).
- **Detection**: count of `get()` and `exists()` calls reachable from a rule's condition.
- **Fix**: cache results via a `let` in a wrapper function. Same-path calls are cached by Firestore.

### `GET_DUPLICATION`

- **Severity**: `warning`.
- **Detection**: a single function that contains a `get()` or `exists()` call is invoked two or more times from one rule.
- **Fix**: wrap the calls in a helper that caches the result in a `let`.

## Security-critical rules

These flag patterns that *compile* but are almost always wrong.

### `PERMISSIVE_RULE`

- **Severity**: `error`.
- **Detection**: a write rule (`write`, `create`, `update`, or `delete`) whose predicate folds to constant `true`. Folding handles boolean literals, `&&`/`||` of booleans, and `!` of a boolean. It does not try to prove `1 == 1` or follow function calls.
- **Why error**: the most common agent failure mode is escaping a denial with `if true`. Blocking the deploy forces fixing the real denial.
- **Fix**: replace the always-true predicate with a request-shape check.

`allow read: if true` on a *read* rule is **not** flagged. It's a legitimate "public read" pattern.

### `RECURSIVE_WILDCARD_OPEN`

- **Severity**: `error`.
- **Detection**: a match path containing a recursive wildcard (`{document=**}`) combined with an allow rule whose predicate folds to constant `true`.
- **Why a separate code**: distinct from `PERMISSIVE_RULE` so the diagnostic names the specific anti-pattern.
- **Fix**: narrow the match path, or supply a real predicate.

## Differential rules (require `previousSource`)

### `RULES_WEAKENED`

- **Severity**: `warning`.
- **Activation**: only fires when `options.previousSource` is passed.
- **Detection**: per match block (matched by normalised path), per allow rule (matched by op-set), extract top-level conjuncts (split only on `&&`), and report every conjunct that existed before but is missing now.
- **Limitations**: does not descend into `||` sub-trees, does not compare function bodies, does not detect "changed" predicates (a change reads as one removal plus a silent addition).
- **Fix**: confirm the removal was intentional, then ignore the warning, or restore the predicate.

## Test-suite-coupled rules (require `testCases`)

### `REQUEST_TIME_NOT_PINNED`

- **Severity**: `warning`.
- **Activation**: only fires when `options.testCases` is passed.
- **Detection**: for each rule that transitively reads `request.time`, emit one warning per `TestCase` whose `path` matches the rule's match path and which does not set `requestTime`.
- **Fix**: set `requestTime` on the test case to an ISO-8601 string.

See [Pin `request.time` for deterministic tests](../pyric-rules-how-to-pin-request-time/).

## Hallucination and syntax-hint rules

These catch JS-style code or look-alike syntax that parses (or fails to parse) with unhelpful messages.

### `INVALID_OPERATOR`

- **Severity**: `error`.
- **Detection**: source contains a JS-style operator that has no Firestore equivalent: `===`, `!==`, `?.`, `??`, backtick template literals.
- **Runs**: pre-parse. Fires even on unparseable input so the diagnostic is precise instead of "expected `)`".

### `HALLUCINATED_METHOD`

- **Severity**: `error`.
- **Detection**: a method call that doesn't exist in the Firestore rules surface (e.g. `.filter()`, `.map()`, `.toLowerCase()` on a string).
- **Fix**: replace with the supported equivalent or restructure the predicate.

### `HALLUCINATED_GLOBAL`

- **Severity**: `error`.
- **Detection**: reference to a global identifier the engine doesn't expose (e.g. `Math`, `JSON`).
- **Fix**: remove the reference; the predicate has to use what `request`, `resource`, and the namespaces actually offer.

### `WRONG_CONTEXT_PATH`

- **Severity**: `error`.
- **Detection**: a `get()` or `exists()` whose path doesn't start with `/databases/$(database)/documents/` or whose interpolation uses the wrong context.
- **Fix**: use the standard form `get(/databases/$(database)/documents/<collection>/$(id))`.

### `LENGTH_PROPERTY`

- **Severity**: `error`.
- **Detection**: `.length` access on a string or list (Firestore rules uses `.size()`).
- **Fix**: replace `s.length` with `s.size()`.

### `INVALID_PATH_INTERPOLATION`

- **Severity**: `error`.
- **Detection**: a path literal segment in the form `{ident}`, a match-style binding used outside a match block. Firestore requires `$(ident)` for interpolation inside path literals.
- **Fix**: replace `/users/{uid}` inside `get(...)` with `/users/$(uid)`.

### `METHOD_MISSING_PARENS`

- **Severity**: `warning`.
- **Detection**: an identifier in expression position that looks like a method name without parentheses (e.g. `request.auth.uid.size` when `size` is a method).
- **Fix**: add the parentheses: `request.auth.uid.size()`.

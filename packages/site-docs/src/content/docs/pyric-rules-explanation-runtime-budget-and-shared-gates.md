---
title: "The runtime budget and shared gates"
navLabel: "Runtime budget and gates"
group: "pyric / rules"
section: "Explanation"
order: 13022
---
# The runtime budget and shared gates

Firestore rules have two kinds of limits. Compilation limits fail loudly: a `400 INVALID_ARGUMENT` at deploy. The runtime evaluation budget fails silently: a `403 PERMISSION_DENIED` that looks identical to a denied rule.

The compile-time limits have exact values. The runtime limits do not. Everything on this page is researched and observed behavior discovered by Pyric's tooling, and it explains why the linter's thresholds look the way they do.

## The exact limits

Three hard caps that Firebase enforces at deploy time:

- **256 KB source.** Exact byte limit. Anything longer is rejected outright.
- **Chain depth 98.** A flat `a && b && c && … && z` chain of length 99 or more refuses to compile. The limit is on chain depth, not total nodes: `(a && b) && (c && d)` has chain depth 1 of `&&`-of-`&&`s. Wrapping reduces depth.
- **11 let bindings per function.** A function with 12 lets fails to compile.

These were verified in production by deliberately building rulesets that crossed each threshold by one. The linter encodes the exact values; you get a clear error when you approach or hit them.

## The hard limit

Beyond those three caps, every rule evaluation runs against a runtime budget. If the budget is exhausted, the engine denies the request with no diagnostic. The request looks identical to one your `allow` rule rejected. The exhaustion is silent, and silent failures are the worst kind to debug.

The budget is not a simple "you can evaluate N expressions" rule. Empirically:

- **One function call with 98 expressions** passes reliably (5/5 in our production tests).
- **Two function calls with 120 total expressions** passes reliably (5/5).
- **Two function calls with 130 total** is **flaky** (2/5 pass).
- **Three function calls with 60 total expressions** is **flaky** (2/5 pass).
- **Three function calls with 90 total** is mostly stable (4/5).

The pattern: function-call overhead dominates. Each call eats a non-trivial chunk of the budget. Three thin calls can fail where one fat call would succeed.

Reverse-engineering: `available = base − (call_count × call_overhead)`. We don't know `base` or `call_overhead` exactly. Firestore's evaluation has a non-deterministic flaky zone where the same ruleset will sometimes pass and sometimes fail. The linter's thresholds are deliberately conservative inside the flaky zone:

| Function calls in rule | Warn at | Error at |
|---|---|---|
| 1 or 2 | 100 expressions | 120 |
| 3 | 60 | 90 |
| 4+ | 40 | 60 |

These over-flag. Some rules in the flaky zone work in practice. The alternative is under-flagging and shipping rules that work in dev and fail under load.

## Shared gates

Even with a single rule sitting comfortably inside its budget, two rules in the same match block can collectively blow it. This is the "shared gate" problem, and the linter's `SHARED_GATE` warning exists because it took an entire weekend of chess debugging to figure out.

The scenario: two `allow update` rules whose conditions both start with the same first expression, say `request.auth.uid == resource.data.host`. The engine evaluates each rule against the request. Even though only one rule actually applies, the prefix evaluation happens in both. If each rule's body is near the budget on its own, their combined evaluation crosses the line.

The fix is to give each rule a unique first expression, a discriminator. Instead of:

```rules
allow update: if request.auth.uid == resource.data.host && validBigCheckA();
allow update: if request.auth.uid == resource.data.host && validBigCheckB();
```

route on something distinct:

```rules
allow update: if request.resource.data.moveType == 'A' && validBigCheckA();
allow update: if request.resource.data.moveType == 'B' && validBigCheckB();
```

Now each rule short-circuits before its heavy body runs, and the engine doesn't end up evaluating both bodies in parallel.

The linter detects `SHARED_GATE` by computing a structural fingerprint of every rule's first expression and grouping by fingerprint. Two or more rules with the same fingerprint produce a warning.

## Get-call costs

A separate hard limit applies to document reads from rules (`get(...)` and `exists(...)`): 10 per rule. The linter's `GET_COUNT` rule warns at 5 and errors at 10. Firestore caches same-path calls within a single rule evaluation, but only for the same path: `get(users/$(uid))` and `get(users/$(otherUid))` are two reads, not one.

`GET_DUPLICATION` catches a related agent failure mode: a helper function that internally calls `get()`, invoked multiple times from the same rule. The agent thinks it's calling a tidy abstraction; the engine sees N reads. The fix is to wrap the calls in a function that caches via a `let`.

## Why the linter sometimes blocks the deploy

Most lint warnings are advisory. A handful are not: `SOURCE_SIZE`, `CHAIN_DEPTH` (above the band), `LET_LIMIT`, `GET_COUNT` (above 10), `PERMISSIVE_RULE`, `RECURSIVE_WILDCARD_OPEN`, `HALLUCINATED_METHOD`, `INVALID_OPERATOR`. The `pyric-tools/deploy` path refuses to swap a ruleset that contains any `severity: 'error'` warning. The choice is deliberate: these are the categories where the cost of shipping the bad rule is high (a deploy that fails compilation; a publicly-readable database) and the cost of demanding a fix is low (the linter tells you exactly what's wrong).

`RULES_WEAKENED` is `warning`, not `error`. There are legitimate reasons to remove a predicate: a refactor, a dedupe, an intentional broadening. The signal is "review this", not "block the deploy".

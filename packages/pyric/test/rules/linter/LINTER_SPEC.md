# Firestore Rules Linter — Specification

## Verified Limits (compilation limits production-tested 2026-04-07 and 2026-09-27; runtime limit 2026-09-27)

### Compilation limits (400 INVALID_ARGUMENT)

| Limit | Exact threshold | Test method |
|-------|----------------|-------------|
| Source text size | 256 KB | Single string equality (isolated) |
| Binary chain depth per function | 98 (AND and OR) | Flat chain, 1 function, 1 rule |
| Let bindings per function | 11 compiles, 12 fails ("Maximum allowed variable count of 10 for a given function has been reached."), Firestore and Storage | Isolated function, 2026-09-27 |
| Functions on one call stack | 21 compiles, 22 fails ("Maximum allowed call depth of 20 is reached for [f1->...->f21] call stack."), Firestore and Storage; checked at compile time, even for a chain no rule calls | `f1()` calls `f2()` ... calls `fN()`, 2026-09-27 |
| Method call chains (.diff().keys().hasOnly()) | 90+ per function | Compile-only test |
| Terms in a right-nested `&&` chain | 49 compiles, 50 fails ("Expression is too complex to evaluate safely."), Firestore and Storage | `t1 && (t2 && (... && (t49)))`, 2026-09-27 |
| Parentheses around one comparison | 97 pairs compile, 98 fail ("Expression is too complex to evaluate safely."), Firestore and Storage | `((((a == b))))`, 2026-09-27 |

The 2026-09-27 rows come from `packages/conformance/src/capture-rules-compile-limits.ts`, which submits one generated ruleset per probe to the Rules Test API and deploys nothing. `fixtures/compile-limits/captures.json` records each probe: whether it compiled, the verbatim issues with severity and position, and each case's decision. The production messages count differently from the measured boundaries: the call-depth message says 20 and names a stack of 21 functions for a 22-function chain, and the variable-count message says 10 while 11 bindings compile.

### Runtime evaluation limit (production-measured 2026-09-27)

Production stops a request when its evaluation reaches 1000 expressions and denies it. The Rules Test API reports the stop as a debug message on the test result: `Unable to evaluate the expression as the maximum of 1000 expressions to evaluate has been reached.` The limit belongs to the request, not to a rule. Allow rules for the request's method run in source order until one grants, and every rule evaluated on the way counts toward the same 1000.

The Rules Test API does not report the count for a request that stays under the limit. Its `expressionReports` omit literals and repeat each earlier rule's counts for every later rule, so their totals are not the limit's count: a chess knight move that cost 927 reports 1121. The count is measured by padding instead:

1. `packages/conformance/src/capture-rules-expression-cost.ts` inserts a rule as the first `allow` of the block the request resolves to. The rule is always false, and its cost grows by about 4.93 expressions for each step of an integer the test case supplies as `request.auth.token.pyric_pad`.
2. The capture finds the smallest step `n*` at which the request reaches the limit. The cost `X` of everything else the request evaluates satisfies `P(n* - 1) + X < 1000 <= P(n*) + X`, a window of about 5 expressions.
3. The padding cost `P(n)` is fitted from six anchor requests that evaluate the padding before a second padding of known length, not assumed.

The capture uses `projects.test` only and deploys nothing. The fixture in `fixtures/expression-cost/` took about 600 test cases, including the anchors and two refreshes of the unpadded reports.

#### What the limit counts

Each ladder shape is 20 repetitions of one expression in its own match block. The model column applies the rules below; it sits about 3.5 expressions above production on every fixed-path shape, which is the padding fit's offset, not a per-node cost.

| Shape | Production | Model |
|-------|-----------|-------|
| `resource.data.a == 1` × 20, joined by `&&` | 131.6 to 136.5 | 138 |
| `id == 'x'` × 20 | 92.2 to 97.1 | 98 |
| `true` × 20 | 52.7 to 57.7 | 58 |
| `g(id)` × 20, `g(x) = x == 'x'` | 131.6 to 136.5 | 138 |
| `lt(id)` × 20, `lt(x) { let v = x; return v == 'x'; }` | 171 to 176 | 178 |
| `!lu()`, a `let` of 10 comparisons the short-circuited body never reads | 72.5 to 77.4 | 77 |
| `id in ['x', 'y']` × 20 | 131.6 to 136.5 | 138 |
| `resource.data.keys().size() > 0` × 20 | 151.3 to 156.2 | 158 |
| `r[f] == 1` × 20 inside one call | 136.5 to 141.5 | 142 |
| `id[0:1] == 'x'` × 20 | 151.3 to 156.2 | 158 |
| `!(id == 'y')` × 20 | 111.9 to 116.8 | 118 |
| `(id == 'x' ? true : false)` × 20 | 151.3 to 156.2 | 158 |
| `resource.data.m == {'k': 1}` × 10 | 82.3 to 87.2 | 88 |
| 20 disjuncts, only the last true | 92.2 to 97.1 | 98 |
| a false first conjunct before 19 more | 18.2 to 23.2 | 23 |
| `get(/databases/$(database)/documents/cfg/c).data.on == true` × 5 | 57.7 to 62.6 | 63 |
| three rules of 20 conjuncts, the first two false at their last conjunct | 407.6 to 412.5 | 410 |

From the ladder:

- Every evaluated node costs 1, literals included: identifiers, literals, member, index and slice access, method calls, function calls, comparisons, arithmetic, `!`, `in`, and list and map literals. `is` costs 2 plus its value: the type name counts as one expression. The standard library measurement found it: `validString` evaluates one `is` check and `boundedNumber` two, and each measured one expression more per check than a cost of 1 gives.
- `&&` and `||` cost 1, plus 1 when they go on to evaluate their right operand. A short-circuited operand costs nothing, so a false first conjunct stops the chain.
- A ternary costs 2 plus its condition and the branch it takes when the condition is true. When it takes the false branch it costs 2 more. The ladder measures only the true branch; the chess promotion and the two Reversi rows take false branches, and a false-branch cost of 2 more is the only value that fits all three windows. The estimator charges the same: 2 on the true branch, 4 on the false branch, and it takes the more expensive of the two when the condition is not known.
- A path literal costs 1 plus 1 per segment; an interpolated segment costs its expression.
- A `let` costs 1 plus its value, and the value is evaluated when the function is called whether or not the body reads it.
- A user function call costs 1 plus its arguments, its lets and its body, on every call. Calls are not memoized; a `get()` of a cached path still pays for its call and path.
- A denied rule's cost stays in the request's total when a later rule grants.
- An allow rule that raises an error does not end the request. The method's later allow rules, in the same match block or another block that matches the path, are evaluated, can grant, and count toward the limit. When the limit is reached after an earlier rule raised an error, production reports that error, not the limit. A padding threshold detects the limit by its message, so for a request with an erroring rule it bounds the count through the end of the first rule that raised an error. The Firestore and Storage captures are in the rules corpus scenarios `error-absorption-and-or` and `error-absorption-and-direction`.

The 2026-04-07 sweep deployed each ruleset once and tested it five times through a client. It reported non-deterministic failures from 60 to 150 expressions and a per-call overhead. The Rules Test API measurements reproduce neither: two functions of 90 comparisons each (about 900 expressions) evaluated to ALLOW on every run, each measured request reached the limit at the same padding step in every round, and a function call costs 1. The call-count thresholds that sweep produced are replaced by the limit above.

#### Measured requests

The chess showcase and an externally authored resolved ruleset for several turn-based games (`arcade`) give the real-world rows. The `reversi` row is the same ruleset after its Reversi move rule was restructured to check each direction with set lookups; its production window is the most expensive move in that change's measurement table (arcade branch `reversi-rules-within-production-budget`), and padding steps 38 and 39 against the Rules Test API reproduce it. Its simulator count is in production's unit. The simulator column is the count Pyric's simulator traced when the fixture was captured. That count took each evaluated node once, without the second unit a logical operator or ternary pays, `let` bindings or path segments, and ran 7 to 13 percent under production on these rows. The simulator now counts in production's unit as it evaluates, reports the count as `evaluatedExpressions` on each result, and denies a request past the limit with production's message. `test/rules/simulator/expression-budget-fixture.test.ts` replays the padding thresholds through the simulator and places that count inside production's window on all 35 requests, counting a request with an erroring rule through the end of that rule. The previous estimator counted each called function's nodes once per rule and discounted wide `||` trees by 0.3 or 0.5.

| Request | Production decision | Production cost | Simulator | Previous estimate | Estimate | Estimate / production |
|---------|--------------------|-----------------|-----------|-------------------|----------|-----------------------|
| chess pawn forward | ALLOW | 811.7 to 816.6 | 714 | 2366 | 1472 | 1.81 |
| chess pawn double | ALLOW | 865.9 to 870.9 | 763 | 2380 | 1530 | 1.76 |
| chess knight | ALLOW | 925.1 to 930 | 819 | 2461 | 1676 | 1.81 |
| chess bishop | ALLOW | 984.2 to 989.1 | 872 | 2461 | 1676 | 1.70 |
| chess queen d8 to h4, checkmate | DENY, limit reached | 1000 or more | 892 | 2461 | 1676 | 1.68 |
| chess queen takes f7, checkmate | ALLOW | 974.4 to 979.3 | 864 | 2478 | 1709 | 1.75 |
| chess castle kingside | ALLOW | 856.1 to 861 | 767 | 2324 | 1540 | 1.79 |
| chess en passant | ALLOW | 865.9 to 870.9 | 772 | 2376 | 1549 | 1.78 |
| chess promotion, nearly empty board | ALLOW | 599.8 to 604.7 | 522 | 2438 | 1605 | 2.67 |
| chess illegal pawn leap | DENY | 338.6 to 343.5 | 316 | not estimated | 1790 (deny) | 5.25 |
| arcade tic-tac-toe move | ALLOW | 141.5 to 146.4 | 132 | 151 | 162 | 1.13 |
| arcade tic-tac-toe win | ALLOW | 195.7 to 200.6 | 179 | 232 | 394 | 1.99 |
| arcade chess e2 to e4 | DENY, runtime error | 304.1 to 309 | 274 | 409 | 477 | 1.56 |
| arcade reversi opening | ALLOW | 511.1 to 516 | 454 | 792 | 2669 | 5.20 |
| arcade reversi, three two-square rays | ALLOW | 752.6 to 757.5 | 661 | 792 | 2669 | 3.53 |
| reversi, random seed 8 write 54, sets | ALLOW | 796.9 to 801.9 | 799 | 784 | 826 | 1.03 |

### Key insight: binary chain depth, not expression count

The compilation limit is the depth of the top-level binary chain
(`a && b && c && ...`), NOT the total number of comparisons. Nesting
reduces chain depth: `(a && b) || (c && d)` has OR-chain depth of N/2,
not N. This means the linter should count chain depth, not total nodes.

The three "too complex" boundaries, and the positions production reports them at, fit one nesting limit. The root of an allow condition, a function body or a `let` value is level 1; each parenthesized group and each binary operator (`&&`, `||`, a comparison) puts what it encloses one level deeper; a node at level 100 is rejected, reported once, and its operands are not visited. With 98 parentheses around `request.auth.uid == 'a'` production reports two issues, at the two operands of `==`; with 99 it reports one, at the `==`; with 100 or more one, at the hundredth parenthesis. 97 parentheses put the operands at level 99 and compile. A right-nested chain of 49 terms puts the innermost operands at level 98 and compiles; 50 terms reach 100 at the two operands of the innermost comparison. A flat chain of 98 comparisons has 97 `&&` nodes on its left spine and its operands at level 99; 99 comparisons reach 100. A member access such as `request.auth.uid` adds no level, since 97 parentheses around a comparison of it compile. The capture does not measure `!`, the ternary, method or function calls, index access, or list and map literals; `grammar/compile-limits.ts` counts them like member access, adding no level. For a chain of comparisons the count agrees with a simpler reading in which only `&&`, `||` and groups count and 97 of them compile; the two differ for a bare operand such as `true`, which sits one level shallower than a comparison, so 98 parentheses around `true` compile under the measured model. NESTING_DEPTH (Rule 2b) reports the limit; CHAIN_DEPTH counts only the left spine of one operator.

## Lint Rules

### RULE 1: SOURCE_SIZE
- **Severity**: error
- **Threshold**: source.length > 256 * 1024 (262,144 bytes)
- **Detection**: trivial — check byte length
- **Message**: "Rules source is {size} bytes, exceeding the 256 KB limit."
- **Fix**: Split into smaller match blocks or reduce string literals
- **Corpus**: none needed (trivial check)

### RULE 2: CHAIN_DEPTH
- **Severity**: error at >95, warning at >85
- **Threshold**: max flat binary chain depth per function > 98
- **Detection**: walk every function the ruleset declares (global scope,
  service scope, and every match block), count the operands of the longest
  flat AND or OR chain. A 98-operand chain compiles; 99 fails.
- **Algorithm**:
  ```
  function maxChainDepth(expr, targetOp):
    if expr.type != 'binaryOp' || expr.op != targetOp: return 0
    operands = 1
    while expr.type == 'binaryOp' && expr.op == targetOp:
      operands += 1
      expr = expr.left
      // Left spine because the parser builds left-associative chains
    return operands

  for each function:
    andDepth = maxChainDepth(fn.body, '&&')
    orDepth = maxChainDepth(fn.body, '||')
    maxDepth = max(andDepth, orDepth)
  ```
- **Message**: "Function '{name}' has a {op} chain of depth {depth}. Limit is 98."
- **Fix**: move part of the chain into its own function: `a && b && c && d` → `firstHalf() && c && d`
- **Corpus**: 05-lets-13-fail.rules (also triggers LET_LIMIT, but chain depth is fine)

### RULE 2b: NESTING_DEPTH
- **Severity**: error
- **Threshold**: an expression node at nesting level 100 or deeper (99 is the deepest that compiles)
- **Detection**: `nestingViolations` in `src/rules/grammar/compile-limits.ts`, the count the Firestore simulator and the Storage evaluator enforce when a ruleset loads. Parentheses are not AST nodes; the parser records the groups around each node in a side table (`parenthesizedGroups`).
- **Message**: "Function '{name}' nests an expression deeper than 99 levels. Production rejects the ruleset: \"Expression is too complex to evaluate safely.\"", or "The rule at line {line} ..." for an allow condition. One warning per function or rule.
- **Fix**: remove redundant parentheses, or move a nested group into its own function and call it
- **Corpus**: `linter.test.ts` replays every and-nesting and paren-nesting probe in `fixtures/compile-limits/captures.json` up to 150 groups, plus the 98- and 99-term flat chains

### RULE 3: LET_LIMIT
- **Severity**: error
- **Threshold**: fn.lets.length > 11 (`LET_LIMIT` in `src/rules/grammar/compile-limits.ts`)
- **Detection**: count let bindings per function definition
- **Message**: "Function '{name}' has {count} let bindings. Limit is 11."
- **Fix**: inline some let expressions, or split function into two
- **Corpus**: 05-lets-13-fail.rules, 06b-lets-12-fail.rules

### RULE 4: SHARED_GATE
- **Severity**: warning (may cause runtime budget exhaustion)
- **Threshold**: 2+ allow rules with structurally identical first expression
- **Detection**: for each pair of `allow` rules in the same match block, compare the first expression node for structural equality
- **Algorithm**:
  ```
  for each match block:
    gates = map of firstExpression → [ruleIndices]
    for each allow rule:
      first = extractFirstExpression(rule.condition)
      key = expressionFingerprint(first)
      gates[key].push(ruleIndex)
    for each gate with 2+ rules:
      emit warning
  ```
- **Message**: "Rules {indices} share the same gate expression '{expr}'. This may cause cross-rule budget exhaustion. Use unique moveType or discriminator values."
- **Fix**: assign unique `moveType` values to each rule category
- **Corpus**: 08-shared-gates-12.rules (triggers), 09-unique-gates-12.rules (does not)

### RULE 5: EXPRESSION_BUDGET
- **Severity**: warning
- **Threshold**: a rule's estimated grant cost is 1000 or more
- **Detection**: `estimateExpressionCosts(ast)` in `src/rules/linter/expression-cost.ts`. For each allow rule, the grant cost is the most expensive evaluation of a request the rule grants: its condition evaluated to true, plus every earlier rule in the same block for the same method evaluated to false. Node costs are the ones measured above.
- **Algorithm**: `cost(expr, want, facts)` returns the most expensive evaluation of `expr` that yields `want` (true, false or either), or null when none exists.
  ```
  a && b, want true:   2 + cost(a, T) + cost(b, T, facts + factsOf(a))
  a && b, want false:  max(1 + cost(a, F), 2 + cost(a, T) + cost(b, F, facts + factsOf(a)))
  a || b, want true:   max(1 + cost(a, T), 2 + cost(a, F, facts + factsOf(b)) + cost(b, T))
  a || b, want false:  2 + max over whether b's first conjunct holds:
                         fails: cost(a, F) + cost(b fails at its first conjunct)
                         holds: cost(a, F, facts + gate) + cost(b, F, facts + gate)
  !a:                  1 + cost(a, not want)
  c ? x : y:           2 + max(cost(c, T) + cost(x, want), cost(c, F) + cost(y, want))
  f(args):             1 + args + sum(1 + let value) + cost(body, want)
  anything else:       1 + children
  ```
  `facts` are equalities between a `request` or `resource` path and a literal that the path being costed requires. A comparison or `in` list that the facts decide cannot take the other outcome, so a granting rule gated on `request.resource.data.moveType == 'normal'` costs an earlier rule gated on `moveType == 'pawn_forward'` as failing at that gate. Where the rules do not decide a branch, the estimate takes the expensive side, so it is an upper bound over documents, not a prediction for one.
- **Accuracy** (`expression-cost.test.ts`, against `fixtures/expression-cost/captures.json`): never below production's lower bound on all 34 measured requests; within 10 percent above production on the 17 whose evaluated path the rules fix; at most 6 times production where the path depends on document values (measured 1.13 to 5.25). A rule under 1000 here stayed under the limit in production.
- **Message**: "Rule #{i} in '{block}' can evaluate up to ~{cost} expressions for a request it grants, counting the earlier rules that deny it first. Production denies a request that reaches 1000."
- **Fix**: put a cheap, mutually exclusive discriminator first in each rule so earlier rules fail at their gate; split expensive checks so a request evaluates only the branch it needs; move lookup work into documents.
- **Corpus**: `fixtures/expression-cost/` (ladder, chess, arcade rulesets and the captured costs). The chess rules warn: their queen checkmate move reached the limit in production.

### RULE 5b: EXPRESSION_LIBRARY_CALLS
- **Severity**: info. It never blocks a write or a deploy.
- **Threshold**: none. It reports every allow rule that calls at least one standard library function.
- **Detection**: `countRuleFunctionCalls(ast)` in `src/rules/linter/expression-cost.ts` walks each rule the way the estimator does: through every argument, `let` value and called function body in the rule's scope, counting each call it reaches. Calls are not memoized, so a library function reached through two callers counts twice. `libraryFunctionFor(fn)` in `src/rules/linter/library-calls.ts` treats a declared function as a library function only when the modules resolver emits the same function for an import of it: same name, parameters, `let` bindings and body. A project function that reuses a library name with different text is not one.
- **Cost**: each call's cost is the catalog entry's measured production cost per call (`cost` in `stdlib-modules.ts`, measured by `packages/conformance/src/measure-stdlib-cost.ts`). Calls are ranked by `cost.max × count` and the first three are listed.
- **Message**: "Rule #{i} in '{block}' spends most on these library calls: {fn} ({module}): {n} calls, {min} to {max} expressions per call; .... Calls are not memoized: each call pays again."
- **Corpus**: `fixtures/library-calls/arcade.rules`, the arcade repository's resolved `app/firestore.rules`; 42 of its rules report.

### RULE 6: CALL_DEPTH
- **Severity**: warning at depth 18 to 21, error at depth >21
- **Threshold**: 21 functions on one call stack (22 fails to compile in Firestore and Storage, 2026-09-27; `CALL_DEPTH_LIMIT` in `src/rules/grammar/compile-limits.ts`)
- **Detection**: resolve each call by declaration scope, then find the longest path from each chain root (a function no other function calls) to a leaf function
- **Algorithm**:
  ```
  function maxCallDepth(fnName, callGraph, visited):
    if visited.has(fnName): return 0  // circular
    visited.add(fnName)
    maxChild = 0
    for each callee of fnName:
      maxChild = max(maxChild, maxCallDepth(callee, callGraph, visited))
    return 1 + maxChild
  ```
- **Message**: "Function '{name}' starts a function call chain of depth {depth}. Limit is 21."
- **Scope**: every chain in the ruleset, called or not. Production rejects an over-deep chain that no rule calls, and so do the Firestore simulator and the Storage evaluator when a ruleset loads (`compileLimitViolations`).
- **Fix**: inline intermediate functions
- **Corpus**: 10-deep-call-chain.rules (6 functions, no report); `linter.test.ts` generates the 21- and 22-function boundary cases

### RULE 7: GET_COUNT
- **Severity**: error at >10 get() calls, warning at >5
- **Threshold**: 10 get() calls per request (documented by Google)
- **Detection**: count unique `get()` and `exists()` calls across all functions reachable from each allow rule
- **Note**: get() results are cached per unique path. Same path = 1 call. Different paths = multiple calls.
- **Message**: "Rule at line {line} may invoke {count} distinct get() calls. Limit is 10."
- **Corpus**: chess.rules (1 get() call — config doc cached)

## Implementation Architecture

### Input
- Rules source string (post-resolution, rules_version = '2')
- OR: rules AST (from parseToAST)

### Output
```typescript
interface LintResult {
  warnings: LintWarning[];
  errors: LintError[];
  metrics: RulesMetrics;
}

interface LintWarning {
  rule: string;           // 'CHAIN_DEPTH', 'SHARED_GATE', etc.
  severity: 'info' | 'warning' | 'error';
  message: string;
  location?: {
    functionName?: string;
    ruleIndex?: number;
    line?: number;
  };
  fix?: string;
}

interface RulesMetrics {
  sourceSize: number;
  functionCount: number;
  allowRuleCount: number;
  maxChainDepth: number;
  maxLetBindings: number;
  maxCallDepth: number;
  maxEstimatedExpressions: number;
  getCallCount: number;
}
```

### Required AST Utilities (build first, test independently)

1. **`maxChainDepth(expr: Expression, op: string): number`**
   Walk expression, count longest flat binary chain of given operator.

2. **`estimateExpressionCosts(ast: FirestoreRules): ExpressionCostEstimates`**
   Grant cost per allow rule and deny cost per block and method, in the
   units of production's 1000-expression limit (`expression-cost.ts`).

3. **`expressionFingerprint(expr: Expression): string`**
   Produce a structural hash/fingerprint for expression comparison.
   Used by SHARED_GATE to detect identical first expressions.

4. **`buildCallGraph(ast: FirestoreAST): Map<string, string[]>`**
   Map each function to the functions it calls. Built from existing
   `collectCalls()` in resolver.ts.

5. **`maxCallDepth(fnName: string, graph: Map<string, string[]>): number`**
   Walk call graph, find longest path.

6. **`extractFirstExpression(condition: Expression): Expression`**
   For a binary AND chain `a && b && c`, extract `a` (the gate).

### Integration Points

1. **Standalone tool**: `lint_firestore_rules(source) → LintResult`
   Agents call this before deployment to check for issues.

2. **Pre-deploy gate**: integrate into `WriteFirestoreRulesHandler`
   If any errors, block deployment and return lint results.
   If only warnings, deploy but include warnings in response.

3. **Build step**: integrate into `resolveModules` output
   After resolution, automatically lint the resolved output.

### Testing Strategy

1. Run each lint rule against the corpus
2. Verify: rules that trigger should trigger, rules that don't shouldn't
3. For EXPRESSION_BUDGET: compare every estimate with the captured production costs in `fixtures/expression-cost/`; recapture with `bun run packages/conformance/src/capture-rules-expression-cost.ts`
4. For SHARED_GATE: verify 08 triggers but 09 doesn't
5. For CHAIN_DEPTH: verify 05/06b trigger, 01-04/06 don't

## Open Questions (for future probing)

1. **Nested match block scope**: Does chain depth limit apply per-match-block or globally?
2. **get() path deduplication**: Does Firestore actually cache get() by path? At what scope?
3. **Overlapping match blocks**: In which order does production evaluate two blocks that match one request, and does a grant in the first skip the second's cost?
4. **Nesting depth model**: Do nodes other than binary operators and parentheses, such as `!`, ternaries and method calls, add a level toward the 99-level nesting limit? Does a bare operand such as `true` in 98 parentheses compile, as the measured model predicts?

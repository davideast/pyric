# Firestore Rules Linter — Specification

## Verified Limits (production-tested 2026-04-07)

### Compilation limits (400 INVALID_ARGUMENT)

| Limit | Exact threshold | Test method |
|-------|----------------|-------------|
| Source text size | 256 KB | Single string equality (isolated) |
| Binary chain depth per function | 98 (AND and OR) | Flat chain, 1 function, 1 rule |
| Let bindings per function | 11 | Isolated function |
| Method call chains (.diff().keys().hasOnly()) | 90+ per function | Compile-only test |

### Runtime limits (403 PERMISSION_DENIED, silent)

Verified with deploy-once-test-5x methodology (10s propagation wait).

| Configuration | Total exprs | Result |
|--------------|-------------|--------|
| 1 fn × 98 | 98 | 5/5 pass |
| 2 fns × 60 | 120 | 5/5 pass |
| 2 fns × 65 | 130 | 2/5 pass (FLAKY) |
| 2 fns × 70 | 140 | 1/5 pass (FLAKY) |
| 3 fns × 20 | 60 | 2/5 pass (FLAKY) |
| 3 fns × 30 | 90 | 4/5 pass (FLAKY) |
| 3 fns × 40 | 120 | 1/5 pass (FLAKY) |
| 3 fns × 50 | 150 | 0/5 pass |

**Key finding**: The runtime budget is NOT purely total expressions.
Function calls have significant overhead. 3 calls with 60 total exprs
is flaky, while 2 calls with 120 total exprs always passes.

**Budget model**: `available = base - (call_count × call_overhead)`
The exact values of `base` and `call_overhead` are not deterministic —
Firestore's evaluation has a flaky zone where results are non-deterministic.

**Safe thresholds for the linter**:
- 1-2 function calls: warn at 100 total expressions, error at 120
- 3+ function calls: warn at 60 total, error at 90
- These are CONSERVATIVE — some rules in the flaky zone will work in
  practice but the linter flags them to prevent production surprises

**Cross-rule budget**: shared gates exhaust the budget (chess debugging).
Exact model unknown — use SHARED_GATE warning.

### Key insight: binary chain depth, not expression count

The compilation limit is the depth of the top-level binary chain
(`a && b && c && ...`), NOT the total number of comparisons. Nesting
reduces chain depth: `(a && b) || (c && d)` has OR-chain depth of N/2,
not N. This means the linter should count chain depth, not total nodes.

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
- **Detection**: walk each function body, count the longest flat AND or OR chain
- **Algorithm**:
  ```
  function maxChainDepth(expr, targetOp):
    if expr.type == 'binaryOp' && expr.op == targetOp:
      return 1 + maxChainDepth(expr.right, targetOp)
      // Right-recursive because parser builds right-associative chains
    return 0

  for each function:
    andDepth = maxChainDepth(fn.body, '&&')
    orDepth = maxChainDepth(fn.body, '||')
    maxDepth = max(andDepth, orDepth)
  ```
- **Message**: "Function '{name}' has a {op} chain of depth {depth}. Limit is 98. Split into nested groups or separate functions."
- **Fix**: `a && b && c && d` → `(a && b) && (c && d)` (halves chain depth)
- **Corpus**: 05-lets-13-fail.rules (also triggers LET_LIMIT, but chain depth is fine)

### RULE 3: LET_LIMIT
- **Severity**: error
- **Threshold**: fn.lets.length > 11
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
- **Severity**: warning/error depends on function call count
- **Threshold**: depends on call depth:
  - 1-2 function calls: warn at 100, error at 120
  - 3-4 function calls: warn at 60, error at 90
  - 5+ function calls: warn at 40, error at 60
- **Detection**: for each allow rule, count:
  1. Total expression nodes across rule condition + all called functions
  2. Number of distinct function calls (transitively)
  Apply thresholds based on call count.
- **Algorithm**:
  ```
  function estimateBudget(rule, functionDefs):
    totalExprs = countNodes(rule.condition)
    callCount = 0
    for each functionCall in rule.condition (transitively):
      callCount++
      fn = functionDefs[call.name]
      totalExprs += countNodes(fn.body)
      totalExprs += sum(countNodes(let.value) for let in fn.lets)
    return { totalExprs, callCount }

  // Apply threshold based on call count
  if callCount <= 2: warnAt 100, errorAt 120
  elif callCount <= 4: warnAt 60, errorAt 90
  else: warnAt 40, errorAt 60
  ```
- **Message**: "Rule at line {line} evaluates ~{exprs} expressions across {calls} function calls. With {calls} calls, safe limit is ~{threshold}."
- **Fix**: reduce function call count by inlining, or reduce expression count per function
- **Corpus**: chess.rules (passes — ~94 exprs, ~8 calls but with short-circuit)
- **IMPORTANT**: Firestore's runtime budget is non-deterministic in the "flaky zone." The thresholds above are CONSERVATIVE. Some rules in the flaky zone will work most of the time but may intermittently fail under load. The linter should flag these as warnings, not errors, with a note about non-determinism.

### RULE 6: CALL_DEPTH
- **Severity**: warning at depth >6, error at depth >10
- **Threshold**: maximum function call chain depth > ~10-20 (not precisely verified)
- **Detection**: build call graph, find longest path from any allow rule to a leaf function
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
- **Message**: "Call chain from rule at line {line} reaches depth {depth}: {chain}. Deep chains may exceed function call budget."
- **Fix**: inline intermediate functions
- **Corpus**: 10-deep-call-chain.rules

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
  severity: 'warning' | 'error';
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

2. **`countExpressionNodes(expr: Expression): number`**
   Walk expression tree, count total nodes (for budget estimation).

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
3. For EXPRESSION_BUDGET: verify against chess.rules (should be warning-free)
4. For SHARED_GATE: verify 08 triggers but 09 doesn't
5. For CHAIN_DEPTH: verify 05/06b trigger, 01-04/06 don't

## Open Questions (for future probing)

1. **Exact cross-rule budget**: Is there a fixed total? Or is it per-rule with overhead per non-matching rule?
2. **Method call cost at runtime**: Does `.diff().affectedKeys().hasOnly()` count as 1 or 3+ toward the ~120 runtime budget?
3. **Nested match block scope**: Does chain depth limit apply per-match-block or globally?
4. **get() path deduplication**: Does Firestore actually cache get() by path? At what scope?
5. **Ternary expression cost**: Does `a ? b : c` count as 1 or 3 in the chain?

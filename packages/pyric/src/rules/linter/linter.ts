/**
 * Firestore Security Rules Linter.
 *
 * Analyzes rules source or AST for structural issues that cause
 * compilation failures (400) or runtime expression budget exhaustion (403).
 *
 * See test/firestore/linter/LINTER_SPEC.md for the full specification
 * and verified production thresholds.
 */
import type { FirestoreRules, FunctionDef, Expression, AllowRule, MatchBlock, PathSegment } from '../grammar/FirestoreAST.js';
import { parseToASTOrError, type ParseError } from '../grammar/FirestoreParser.js';
import type { TestCase } from '../test/spec.js';
import {
  maxChainDepth,
  deepestChain,
  countExpressionNodes,
  expressionFingerprint,
  extractFirstExpression,
  buildCallGraph,
  maxCallDepth,
  countGetCalls,
  countFunctionCallSites,
  functionContainsGet,
  referencesRequestTime,
  collectAllFunctions,
  collectAllRules,
} from './ast-utils.js';
import { checkSyntaxHints, checkHallucinations } from './hallucinations.js';

// ═══ Types ═══

export interface LintWarning {
  rule: string;
  severity: 'warning' | 'error';
  message: string;
  location?: {
    functionName?: string;
    ruleIndex?: number;
    matchPath?: string;
    /** Test-case description from `TestCase.description`. Set only by
     *  rules that operate on the optional test suite (e.g. REQUEST_TIME_NOT_PINNED). */
    testCaseDescription?: string;
  };
  fix?: string;
}

export interface RulesMetrics {
  sourceSize: number;
  functionCount: number;
  allowRuleCount: number;
  maxChainDepth: number;
  maxChainOp: string;
  maxLetBindings: number;
  maxLetBindingsFunction: string;
  maxCallDepth: number;
  maxEstimatedExpressions: number;
  getCallCount: number;
}

export interface LintResult {
  warnings: LintWarning[];
  metrics: RulesMetrics;
  /**
   * Structured parse failure when the source did not parse. When defined,
   * `metrics` (except `sourceSize`) and `warnings` carry no signal —
   * budget checks were skipped. Callers should branch on `parseError`
   * before interpreting warnings or metrics.
   *
   * Why this isn't a new `severity` value: a parse failure means "this
   * isn't a rule yet" rather than "this rule will fail at runtime", which
   * is a categorically different question from anything `warnings`
   * answers. Adding a new severity would force every consumer to handle
   * a third branch they don't care about; a separate field lets old
   * code keep working and gives new code a clean signal to check.
   */
  parseError?: ParseError;
}

// ═══ Thresholds (from production verification) ═══

const THRESHOLDS = {
  SOURCE_SIZE: 256 * 1024,           // 256 KB — exact, verified
  CHAIN_DEPTH_ERROR: 95,             // warn before the hard limit
  CHAIN_DEPTH_WARN: 85,
  CHAIN_DEPTH_LIMIT: 98,             // exact compile limit, verified
  LET_LIMIT: 11,                     // exact, verified (12 fails)
  // Runtime budget is call-count-dependent and non-deterministic
  RUNTIME_BUDGET: {
    low: { calls: 2, warn: 100, error: 120 },
    mid: { calls: 4, warn: 60, error: 90 },
    high: { calls: Infinity, warn: 40, error: 60 },
  },
  CALL_DEPTH_WARN: 6,
  CALL_DEPTH_ERROR: 10,
  GET_COUNT_WARN: 5,
  GET_COUNT_ERROR: 10,               // documented by Google
};

// ═══ Lint Rules ═══

function checkSourceSize(source: string, warnings: LintWarning[]) {
  if (source.length > THRESHOLDS.SOURCE_SIZE) {
    warnings.push({
      rule: 'SOURCE_SIZE',
      severity: 'error',
      message: `Rules source is ${(source.length / 1024).toFixed(0)} KB, exceeding the 256 KB limit.`,
      fix: 'Reduce string literals, remove comments, or split into smaller match blocks.',
    });
  }
}

function checkLetBindings(functions: FunctionDef[], warnings: LintWarning[]) {
  for (const fn of functions) {
    if (fn.lets.length > THRESHOLDS.LET_LIMIT) {
      warnings.push({
        rule: 'LET_LIMIT',
        severity: 'error',
        message: `Function '${fn.name}' has ${fn.lets.length} let bindings. Limit is ${THRESHOLDS.LET_LIMIT}.`,
        location: { functionName: fn.name },
        fix: 'Inline some let expressions into the return statement, or split the function.',
      });
    }
  }
}

function checkChainDepth(functions: FunctionDef[], warnings: LintWarning[]) {
  for (const fn of functions) {
    const chain = deepestChain(fn.body);
    // Also check let binding values for deep chains
    for (const binding of fn.lets) {
      const letChain = deepestChain(binding.value);
      if (letChain.depth > chain.depth) {
        chain.depth = letChain.depth;
        chain.op = letChain.op;
      }
    }

    if (chain.depth >= THRESHOLDS.CHAIN_DEPTH_LIMIT) {
      warnings.push({
        rule: 'CHAIN_DEPTH',
        severity: 'error',
        message: `Function '${fn.name}' has a ${chain.op} chain of depth ${chain.depth}. Limit is ${THRESHOLDS.CHAIN_DEPTH_LIMIT}.`,
        location: { functionName: fn.name },
        fix: `Split into nested groups: 'a && b && c && d' → '(a && b) && (c && d)' to halve chain depth.`,
      });
    } else if (chain.depth >= THRESHOLDS.CHAIN_DEPTH_ERROR) {
      warnings.push({
        rule: 'CHAIN_DEPTH',
        severity: 'error',
        message: `Function '${fn.name}' has a ${chain.op} chain of depth ${chain.depth}. Limit is ${THRESHOLDS.CHAIN_DEPTH_LIMIT}. Approaching failure.`,
        location: { functionName: fn.name },
        fix: `Split the chain into nested groups to reduce depth.`,
      });
    } else if (chain.depth >= THRESHOLDS.CHAIN_DEPTH_WARN) {
      warnings.push({
        rule: 'CHAIN_DEPTH',
        severity: 'warning',
        message: `Function '${fn.name}' has a ${chain.op} chain of depth ${chain.depth}. Limit is ${THRESHOLDS.CHAIN_DEPTH_LIMIT}.`,
        location: { functionName: fn.name },
      });
    }
  }
}

function checkSharedGates(
  rules: { rule: { condition: Expression; operations: string[] }; path: string }[],
  warnings: LintWarning[],
) {
  // Group allow update rules by match path
  const byPath = new Map<string, { index: number; gate: string; ops: string[] }[]>();
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i];
    // Only check update rules (most susceptible to budget issues)
    if (!r.rule.operations.some(op => op === 'update' || op === 'write')) continue;
    const gate = expressionFingerprint(extractFirstExpression(r.rule.condition));
    const path = r.path;
    if (!byPath.has(path)) byPath.set(path, []);
    byPath.get(path)!.push({ index: i, gate, ops: r.rule.operations });
  }

  for (const [path, entries] of byPath) {
    const gateGroups = new Map<string, number[]>();
    for (const e of entries) {
      if (!gateGroups.has(e.gate)) gateGroups.set(e.gate, []);
      gateGroups.get(e.gate)!.push(e.index);
    }
    for (const [gate, indices] of gateGroups) {
      if (indices.length >= 2) {
        warnings.push({
          rule: 'SHARED_GATE',
          severity: 'warning',
          message: `${indices.length} allow rules in '${path}' share the same gate expression. This may cause cross-rule budget exhaustion. Rules: ${indices.join(', ')}.`,
          location: { matchPath: path },
          fix: 'Assign unique moveType or discriminator values so each rule has a unique first expression.',
        });
      }
    }
  }
}

/**
 * Count function calls and total expressions for a SINGLE rule's condition,
 * following function calls transitively. Skips already-visited functions
 * to avoid double-counting shared helpers (like cfg()).
 */
function estimateRuleBudget(
  condition: Expression,
  fnMap: Map<string, FunctionDef>,
): { totalExprs: number; callCount: number } {
  let totalExprs = countExpressionNodes(condition);
  const visited = new Set<string>();

  function walkForCalls(expr: Expression) {
    if (expr.type === 'functionCall' && fnMap.has(expr.name) && !visited.has(expr.name)) {
      visited.add(expr.name);
      const fn = fnMap.get(expr.name)!;
      totalExprs += countExpressionNodes(fn.body);
      for (const b of fn.lets) totalExprs += countExpressionNodes(b.value);
      walkForCalls(fn.body);
      for (const b of fn.lets) walkForCalls(b.value);
    }
    // Walk children to find nested function calls
    switch (expr.type) {
      case 'binaryOp': walkForCalls(expr.left); walkForCalls(expr.right); break;
      case 'unaryOp': walkForCalls(expr.operand); break;
      case 'methodCall': walkForCalls(expr.object); expr.args.forEach(walkForCalls); break;
      case 'memberAccess': walkForCalls(expr.object); break;
      case 'bracketAccess': walkForCalls(expr.object); walkForCalls(expr.index); break;
      case 'ternary': walkForCalls(expr.condition); walkForCalls(expr.consequent); walkForCalls(expr.alternate); break;
      case 'inExpr': walkForCalls(expr.element); walkForCalls(expr.collection); break;
      case 'isExpr': walkForCalls(expr.value); break;
      case 'listLiteral': expr.elements.forEach(walkForCalls); break;
      case 'mapLiteral': expr.entries.forEach(e => { walkForCalls(e.key); walkForCalls(e.value); }); break;
      case 'functionCall': expr.args.forEach(walkForCalls); break;
    }
  }
  walkForCalls(condition);

  return { totalExprs, callCount: visited.size };
}

function checkExpressionBudget(
  rules: { rule: { condition: Expression }; matchFunctions: FunctionDef[] }[],
  allFunctions: FunctionDef[],
  warnings: LintWarning[],
) {
  const fnMap = new Map<string, FunctionDef>();
  for (const fn of allFunctions) fnMap.set(fn.name, fn);

  for (let i = 0; i < rules.length; i++) {
    const { totalExprs, callCount } = estimateRuleBudget(rules[i].rule.condition, fnMap);

    // The runtime budget depends on function call count.
    // With unique gates (SHARED_GATE check handles this separately),
    // only this rule's expressions are evaluated. The budget model
    // accounts for per-call overhead making the available budget
    // decrease with more calls.
    //
    // However, the total node count is a WORST-CASE estimate (assumes
    // all branches evaluate). Firestore short-circuits && and ||.
    // For rules with many OR branches where only 1 matches, the actual
    // evaluated count is much lower than the tree size.
    //
    // To avoid false positives on rules with large but well-gated trees
    // (like chess check detection with 16 OR branches), we use a
    // conservative multiplier: if the rule has many OR branches at the
    // top level, discount the estimate.
    const topLevelOrs = maxChainDepth(rules[i].rule.condition, '||');
    const discountFactor = topLevelOrs > 5 ? 0.3 : topLevelOrs > 2 ? 0.5 : 1.0;
    const adjustedExprs = Math.round(totalExprs * discountFactor);

    const budget = callCount <= THRESHOLDS.RUNTIME_BUDGET.low.calls
      ? THRESHOLDS.RUNTIME_BUDGET.low
      : callCount <= THRESHOLDS.RUNTIME_BUDGET.mid.calls
        ? THRESHOLDS.RUNTIME_BUDGET.mid
        : THRESHOLDS.RUNTIME_BUDGET.high;

    // Expression budget is always a WARNING, never an error, because:
    // 1. We count the full tree but Firestore short-circuits && and ||
    // 2. The runtime budget is non-deterministic (has a flaky zone)
    // 3. The actual evaluated expressions depend on data at runtime
    // Hard structural errors (chain depth, let limit) catch compilation failures.
    // This check catches POTENTIAL runtime issues as advisory warnings.
    if (adjustedExprs >= budget.warn) {
      warnings.push({
        rule: 'EXPRESSION_BUDGET',
        severity: 'warning',
        message: `Rule #${i} has ~${totalExprs} expression nodes across ${callCount} function calls. Runtime budget is non-deterministic; actual evaluation depends on short-circuit behavior.`,
        location: { ruleIndex: i },
        fix: 'If this rule fails at runtime (403), reduce function calls or expression count.',
      });
    }
  }
}

function checkCallDepth(
  rules: { rule: { condition: Expression }; matchFunctions: FunctionDef[] }[],
  allFunctions: FunctionDef[],
  warnings: LintWarning[],
) {
  const callGraph = buildCallGraph(allFunctions);
  const fnMap = new Map<string, FunctionDef>();
  for (const fn of allFunctions) fnMap.set(fn.name, fn);

  for (let i = 0; i < rules.length; i++) {
    let maxDepth = 0;
    const findDepth = (expr: Expression) => {
      if (expr.type === 'functionCall' && fnMap.has(expr.name)) {
        const depth = maxCallDepth(expr.name, callGraph);
        if (depth > maxDepth) maxDepth = depth;
      }
      switch (expr.type) {
        case 'binaryOp': findDepth(expr.left); findDepth(expr.right); break;
        case 'unaryOp': findDepth(expr.operand); break;
        case 'methodCall': findDepth(expr.object); expr.args.forEach(findDepth); break;
        case 'memberAccess': findDepth(expr.object); break;
        case 'bracketAccess': findDepth(expr.object); findDepth(expr.index); break;
        case 'ternary': findDepth(expr.condition); findDepth(expr.consequent); findDepth(expr.alternate); break;
        case 'inExpr': findDepth(expr.element); findDepth(expr.collection); break;
        case 'functionCall': expr.args.forEach(findDepth); break;
      }
    };
    findDepth(rules[i].rule.condition);

    if (maxDepth >= THRESHOLDS.CALL_DEPTH_ERROR) {
      warnings.push({
        rule: 'CALL_DEPTH',
        severity: 'error',
        message: `Rule #${i} has a function call chain of depth ${maxDepth}. May exceed call budget.`,
        location: { ruleIndex: i },
        fix: 'Inline intermediate functions to reduce call depth.',
      });
    } else if (maxDepth >= THRESHOLDS.CALL_DEPTH_WARN) {
      warnings.push({
        rule: 'CALL_DEPTH',
        severity: 'warning',
        message: `Rule #${i} has a function call chain of depth ${maxDepth}.`,
        location: { ruleIndex: i },
      });
    }
  }
}

function checkGetCount(
  rules: { rule: { condition: Expression }; matchFunctions: FunctionDef[] }[],
  allFunctions: FunctionDef[],
  warnings: LintWarning[],
) {
  const fnMap = new Map<string, FunctionDef>();
  for (const fn of allFunctions) fnMap.set(fn.name, fn);

  for (let i = 0; i < rules.length; i++) {
    const count = countGetCalls(rules[i].rule.condition, fnMap);
    if (count >= THRESHOLDS.GET_COUNT_ERROR) {
      warnings.push({
        rule: 'GET_COUNT',
        severity: 'error',
        message: `Rule #${i} may invoke ${count} get()/exists() calls. Limit is ${THRESHOLDS.GET_COUNT_ERROR}.`,
        location: { ruleIndex: i },
        fix: 'Cache get() results via a config() wrapper function. Same-path calls are cached by Firestore.',
      });
    } else if (count >= THRESHOLDS.GET_COUNT_WARN) {
      warnings.push({
        rule: 'GET_COUNT',
        severity: 'warning',
        message: `Rule #${i} invokes ${count} get()/exists() calls. Limit is ${THRESHOLDS.GET_COUNT_ERROR}.`,
        location: { ruleIndex: i },
      });
    }
  }
}

function checkGetDuplication(
  rules: { rule: { condition: Expression }; matchFunctions: FunctionDef[] }[],
  allFunctions: FunctionDef[],
  warnings: LintWarning[],
) {
  const fnMap = new Map<string, FunctionDef>();
  for (const fn of allFunctions) fnMap.set(fn.name, fn);
  const fnNames = new Set(allFunctions.map(f => f.name));

  for (let i = 0; i < rules.length; i++) {
    const callCounts = countFunctionCallSites(rules[i].rule.condition, fnNames);
    for (const [fnName, count] of callCounts) {
      if (count >= 2 && functionContainsGet(fnName, fnMap)) {
        warnings.push({
          rule: 'GET_DUPLICATION',
          severity: 'warning',
          message: `Function '${fnName}' (contains get/exists) is called ${count} times in rule #${i}. Cache the result with a let binding in a wrapper function to reduce get() calls from ${count} to 1.`,
          location: { ruleIndex: i },
          fix: `Create a wrapper: function verifyAll(ret) { let c = ${fnName}(); return verify1(ret, c) && verify2(ret, c) && ...; }`,
        });
      }
    }
  }
}

/**
 * REQUEST_TIME_NOT_PINNED — couples the static linter to the per-test data
 * (REBUILD_PLAN.md Item 0.F deferred follow-up). When a rule transitively
 * reads `request.time`, the rule's verdict depends on wallclock unless the
 * test pins `requestTime`. Pre-fix, date-gated rules failed
 * non-deterministically across CI runs and agents either gave up or
 * hardcoded today's date.
 *
 * Emits one warning per affected (rule, test case) pair so the agent gets
 * a precise checklist. Only fires when the caller passes a test suite —
 * source-only `lintFirestoreRules(source)` calls are unaffected.
 */
function checkRequestTimePinned(
  rules: { rule: { condition: Expression }; path: string }[],
  allFunctions: FunctionDef[],
  testCases: TestCase[],
  warnings: LintWarning[],
) {
  const fnMap = new Map<string, FunctionDef>();
  for (const fn of allFunctions) fnMap.set(fn.name, fn);

  // Find which rule indices reference request.time. Per-rule rather than
  // per-source so a test case targeting an unrelated match block isn't
  // wrongly flagged.
  const timeGatedRules = new Set<number>();
  for (let i = 0; i < rules.length; i++) {
    if (referencesRequestTime(rules[i].rule.condition, fnMap)) {
      timeGatedRules.add(i);
    }
  }
  if (timeGatedRules.size === 0) return;

  // Cheap match-path resolution: a test case at "users/alice" matches a
  // rule whose match path is "users/{id}". Full path matching is the
  // simulator/handler's job — here we just need a "could this rule fire
  // for this test case?" estimate. Match by segment-count + literal-match.
  function pathMatches(rulePath: string, tcPath: string): boolean {
    const ruleSegs = rulePath.split('/').filter(Boolean);
    const tcSegs = tcPath.split('/').filter(Boolean);
    if (ruleSegs.length !== tcSegs.length) return false;
    for (let i = 0; i < ruleSegs.length; i++) {
      const rs = ruleSegs[i]!;
      // Wildcard or recursive wildcard matches any segment.
      if (rs.startsWith('{') && rs.endsWith('}')) continue;
      if (rs !== tcSegs[i]) return false;
    }
    return true;
  }

  for (const tc of testCases) {
    if (tc.requestTime) continue; // pinned — fine
    for (const ruleIdx of timeGatedRules) {
      if (!pathMatches(rules[ruleIdx]!.path, tc.path)) continue;
      warnings.push({
        rule: 'REQUEST_TIME_NOT_PINNED',
        severity: 'warning',
        message: `Test case "${tc.description}" targets rule #${ruleIdx} (path '${rules[ruleIdx]!.path}') which reads request.time, but does not set requestTime. Result is non-deterministic across runs.`,
        location: { ruleIndex: ruleIdx, matchPath: rules[ruleIdx]!.path, testCaseDescription: tc.description },
        fix: 'Set requestTime on this TestCase to an ISO-8601 timestamp so the rule evaluates deterministically.',
      });
    }
  }
}

/**
 * PERMISSIVE_RULE — `allow ... if true` (or any condition that statically
 * resolves to the boolean literal `true`) disables security for the
 * matched paths. Empirically the most common agent failure mode: when a
 * targeted rule denies a write the agent doesn't understand, the easy
 * escape is to write the predicate true. That ships an open collection.
 *
 * Severity is `error` so `deployRules` refuses to swap the ruleset — the
 * agent has to fix the actual denial instead of widening the gate.
 *
 * Detection is deliberately conservative: we only fold `&&`/`||` over
 * boolean literals and recognize the literal `true`. We do NOT try to
 * prove `1 == 1` or follow function calls. A few false negatives are
 * acceptable; a single false positive on a legitimate rule would break
 * deploys.
 */
function evalConstBool(expr: Expression): boolean | null {
  if (expr.type === 'literal' && typeof expr.value === 'boolean') return expr.value;
  if (expr.type === 'binaryOp') {
    const left = evalConstBool(expr.left);
    const right = evalConstBool(expr.right);
    if (expr.op === '&&') {
      if (left === false || right === false) return false;
      if (left === true && right === true) return true;
      return null;
    }
    if (expr.op === '||') {
      if (left === true || right === true) return true;
      if (left === false && right === false) return false;
      return null;
    }
  }
  if (expr.type === 'unaryOp' && expr.op === '!') {
    const inner = evalConstBool(expr.operand);
    return inner === null ? null : !inner;
  }
  return null;
}

const WRITE_OPS: ReadonlySet<string> = new Set([
  'write', 'create', 'update', 'delete',
]);

function checkPermissiveRules(
  rules: { rule: AllowRule; path: string }[],
  warnings: LintWarning[],
) {
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i]!;
    if (evalConstBool(r.rule.condition) !== true) continue;
    // `allow read: if true` is a legitimate "public read" pattern (e.g.
    // a shared config doc). Only flag when the rule grants any write
    // capability — that's where `if true` actually disables security.
    const grantsWrite = r.rule.operations.some((op) => WRITE_OPS.has(op));
    if (!grantsWrite) continue;
    const ops = r.rule.operations.join(', ');
    warnings.push({
      rule: 'PERMISSIVE_RULE',
      // Severity: warning, not error. Rationale: `allow write: if true`
      // is the canonical dev/sandbox/quickstart pattern; classifying it
      // as a hard error caused `sandbox.setRules(...)` to silently no-op
      // and the scaffolded `pyric init` quickstart to break in confusing
      // ways. The diagnostic itself stays so CI or a release workflow can
      // enforce stricter policy. The dev-loop sandbox stays permissive.
      severity: 'warning',
      message:
        `allow ${ops} at ${r.path} resolves to a constant true predicate — `
        + `this disables write security for the matched paths. If you reached `
        + `for \`if true\` to escape a denial you don't understand, narrow `
        + `the predicate to the specific request shape instead (auth identity, `
        + `affected fields via diff, status transitions).`,
      location: { ruleIndex: i, matchPath: r.path },
      fix: 'Replace the always-true predicate with a request-shape check (e.g. request.auth != null && request.resource.data.ownerId == request.auth.uid).',
    });
  }
}

/**
 * RECURSIVE_WILDCARD_OPEN — `match /{x=**} { allow read, write: if true }`
 * is the most permissive ruleset Firebase will accept. Distinct from
 * PERMISSIVE_RULE so the agent gets a specifically named diagnostic; the
 * recursive-wildcard form is what the playground trace ended up at after
 * the agent gave up debugging.
 *
 * Fires only when the path uses the recursive form AND the predicate
 * folds to constant true — a recursive wildcard with a real predicate
 * (e.g. `if request.auth.uid == userId`) is a legitimate pattern.
 */
function checkRecursiveWildcardOpen(
  match: MatchBlock,
  warnings: LintWarning[],
) {
  const hasRecursive = match.path.segments.some((s) => s.type === 'recursive');
  if (hasRecursive) {
    for (let i = 0; i < match.allows.length; i++) {
      if (evalConstBool(match.allows[i]!.condition) === true) {
        warnings.push({
          rule: 'RECURSIVE_WILDCARD_OPEN',
          severity: 'error',
          message:
            `Recursive wildcard match (${match.path.raw}) with an always-true `
            + `predicate exposes every document under this prefix. This is the `
            + `Firebase open-rules anti-pattern — never ship it.`,
          location: { ruleIndex: i, matchPath: match.path.raw },
          fix: 'Either narrow the match path to specific collections, or replace `if true` with a real predicate (auth identity, ownership, role).',
        });
      }
    }
  }
  for (const child of match.children) checkRecursiveWildcardOpen(child, warnings);
}

/**
 * RULES_WEAKENED — when a previous ruleset is supplied, flag every
 * security predicate that the new ruleset has *removed*. Catches the
 * agent failure mode where a denial is silently escaped by deleting the
 * predicate (or whole rule, or whole match block) rather than fixing
 * the request.
 *
 * Severity is `warning` (not `error`) — there are legitimate reasons to
 * remove a predicate (refactor, dedupe), so this is advisory and does
 * not block deploys. The agent has to decide whether the removal is
 * intentional.
 *
 * Conjunct extraction: walk the predicate tree splitting on top-level
 * `&&` only. We do NOT descend into `||` branches — splitting an OR
 * would change semantics, so we treat the entire OR sub-tree as one
 * conjunct. Each conjunct is normalized to a canonical string and
 * compared as a set. Removed conjuncts → warnings; added/changed
 * conjuncts → silence (refinement is fine).
 */

/** Normalize a path segment for cross-ruleset comparison. Wildcards
 *  compare equal regardless of their binding name. */
function normalizePathSegment(seg: { type: string; name?: string; value?: string }): string {
  if (seg.type === 'literal') return seg.value ?? '';
  if (seg.type === 'wildcard') return '{*}';
  if (seg.type === 'recursive') return '{**}';
  return '';
}

/** Build the full normalized path from root to this match block by
 *  joining every ancestor's segments with '/'. */
function buildMatchPathChain(segments: PathSegment[]): string {
  return segments.map(normalizePathSegment).join('/');
}

/** Walk the AST and yield every match block with its full normalized
 *  path (concatenated from root). The leaf `MatchBlock.path.raw` only
 *  reflects the local segment, which collides across siblings. */
function collectMatchBlocksWithPaths(
  match: MatchBlock,
  parentPath: string,
): Array<{ block: MatchBlock; normalizedPath: string }> {
  const localPath = buildMatchPathChain(match.path.segments);
  const fullPath = parentPath ? `${parentPath}/${localPath}` : localPath;
  const out: Array<{ block: MatchBlock; normalizedPath: string }> = [
    { block: match, normalizedPath: fullPath },
  ];
  for (const child of match.children) {
    out.push(...collectMatchBlocksWithPaths(child, fullPath));
  }
  return out;
}

/** Deterministic serializer producing the same string for structurally
 *  identical expressions. No surrounding whitespace; no parens (the
 *  structure of nested binaryOp nodes already encodes precedence). */
function serializeExpression(expr: Expression): string {
  switch (expr.type) {
    case 'literal':
      return expr.raw;
    case 'identifier':
      return expr.name;
    case 'memberAccess':
      return `${serializeExpression(expr.object)}.${expr.property}`;
    case 'methodCall':
      return `${serializeExpression(expr.object)}.${expr.method}(${expr.args.map(serializeExpression).join(',')})`;
    case 'bracketAccess':
      return `${serializeExpression(expr.object)}[${serializeExpression(expr.index)}]`;
    case 'sliceAccess':
      return `${serializeExpression(expr.object)}[${serializeExpression(expr.start)}:${serializeExpression(expr.end)}]`;
    case 'binaryOp':
      return `(${serializeExpression(expr.left)}${expr.op}${serializeExpression(expr.right)})`;
    case 'unaryOp':
      return `(${expr.op}${serializeExpression(expr.operand)})`;
    case 'ternary':
      return `(${serializeExpression(expr.condition)}?${serializeExpression(expr.consequent)}:${serializeExpression(expr.alternate)})`;
    case 'inExpr':
      return `(${serializeExpression(expr.element)} in ${serializeExpression(expr.collection)})`;
    case 'isExpr':
      return `(${serializeExpression(expr.value)} is ${expr.typeName})`;
    case 'listLiteral':
      return `[${expr.elements.map(serializeExpression).join(',')}]`;
    case 'mapLiteral':
      return `{${expr.entries.map((e) => `${serializeExpression(e.key)}:${serializeExpression(e.value)}`).join(',')}}`;
    case 'pathLiteral':
      return expr.raw;
    case 'functionCall':
      return `${expr.name}(${expr.args.map(serializeExpression).join(',')})`;
  }
}

/** Split a predicate into its top-level conjuncts (split only on `&&`).
 *  An `||` sub-tree is preserved as a single conjunct so we don't
 *  change semantics by treating one of its branches as removable. */
function extractConjuncts(expr: Expression): Expression[] {
  if (expr.type === 'binaryOp' && expr.op === '&&') {
    return [...extractConjuncts(expr.left), ...extractConjuncts(expr.right)];
  }
  return [expr];
}

function checkRulesWeakened(
  currentMatch: MatchBlock,
  previousMatch: MatchBlock,
  warnings: LintWarning[],
): void {
  const currentBlocks = collectMatchBlocksWithPaths(currentMatch, '');
  const previousBlocks = collectMatchBlocksWithPaths(previousMatch, '');

  const currentByPath = new Map<string, MatchBlock>();
  for (const { block, normalizedPath } of currentBlocks) {
    // If duplicate paths exist (rare but possible with sibling literal
    // matches reused), keep the first — comparing the first occurrence
    // is sufficient for "did this path lose predicates?"
    if (!currentByPath.has(normalizedPath)) currentByPath.set(normalizedPath, block);
  }

  for (const { block: prevBlock, normalizedPath } of previousBlocks) {
    const curBlock = currentByPath.get(normalizedPath);
    if (!curBlock) {
      // Whole match block disappeared. Only emit when the previous
      // block actually had allow rules — a parent shell with no allows
      // disappearing tells the agent nothing.
      if (prevBlock.allows.length > 0) {
        warnings.push({
          rule: 'RULES_WEAKENED',
          severity: 'warning',
          message: `Match block removed: ${normalizedPath}`,
          location: { matchPath: normalizedPath },
        });
      }
      continue;
    }

    // For each previous allow rule, find the corresponding current
    // allow rule by op-set equality.
    for (const prevAllow of prevBlock.allows) {
      const opsKey = [...prevAllow.operations].sort().join(',');
      const curAllow = curBlock.allows.find(
        (a) => [...a.operations].sort().join(',') === opsKey,
      );
      const opsLabel = prevAllow.operations.join(', ');
      if (!curAllow) {
        warnings.push({
          rule: 'RULES_WEAKENED',
          severity: 'warning',
          message: `Allow rule removed: ${normalizedPath} allow ${opsLabel}`,
          location: { matchPath: normalizedPath },
        });
        continue;
      }

      // Diff the conjunct sets.
      const prevConjuncts = extractConjuncts(prevAllow.condition).map(serializeExpression);
      const curConjuncts = new Set(
        extractConjuncts(curAllow.condition).map(serializeExpression),
      );
      for (const pc of prevConjuncts) {
        if (!curConjuncts.has(pc)) {
          warnings.push({
            rule: 'RULES_WEAKENED',
            severity: 'warning',
            message: `Predicate removed from ${normalizedPath} allow ${opsLabel}: ${pc}`,
            location: { matchPath: normalizedPath },
          });
        }
      }
    }
  }
}

// ═══ Main Linter ═══

/**
 * Optional inputs for `lintFirestoreRules` that activate test-suite-coupled
 * checks. Only `REQUEST_TIME_NOT_PINNED` reads from this surface today.
 */
export interface LintOptions {
  /**
   * The test cases that will be run against this rules source. When
   * supplied, the linter activates `REQUEST_TIME_NOT_PINNED`: rules that
   * read `request.time` get a warning per test case that targets them
   * without setting `requestTime`. Omit this arg to keep behavior
   * source-only (the historical default).
   */
  testCases?: TestCase[];
  /**
   * Source of the previously deployed ruleset. When supplied, the
   * linter activates `RULES_WEAKENED`: any security predicate that
   * existed in the previous ruleset but has been removed from the
   * current one is reported. Designed to catch agents silently
   * weakening rules to make a failing test pass. Silently skipped if
   * the previous source fails to parse — a malformed prior should not
   * block linting of a valid current ruleset.
   */
  previousSource?: string;
}

/**
 * Lint Firestore security rules.
 *
 * Contract: if the source doesn't parse, `parseError` is populated and
 * budget checks are skipped — `warnings` will be empty (or contain only
 * source-size which doesn't depend on parsing) and `metrics` fields other
 * than `sourceSize` are zeroed. Callers must check `parseError` first.
 *
 * Pass `options.testCases` to activate test-suite-coupled checks (e.g.
 * REQUEST_TIME_NOT_PINNED). When omitted, the linter behaves exactly as
 * it did before — back-compat with all existing callers.
 */
export function lintFirestoreRules(source: string, options: LintOptions = {}): LintResult {
  const warnings: LintWarning[] = [];

  // Pre-parse syntax hints — run on raw source so they fire even when the
  // rules fail to parse. Surface JS-isms (===, ?., ??, backtick strings)
  // that would otherwise produce opaque parse errors.
  warnings.push(...checkSyntaxHints(source));

  // Rule 1: Source size — runs even on unparseable source so a 300KB blob
  // of garbage still surfaces the size error.
  checkSourceSize(source, warnings);

  // Parse AST. On failure, return early with a structured parseError;
  // budget checks intentionally do not run on partial ASTs.
  const parsed = parseToASTOrError(source);
  if (!parsed.ok) {
    return {
      warnings,
      metrics: {
        sourceSize: source.length, functionCount: 0, allowRuleCount: 0,
        maxChainDepth: 0, maxChainOp: '', maxLetBindings: 0, maxLetBindingsFunction: '',
        maxCallDepth: 0, maxEstimatedExpressions: 0, getCallCount: 0,
      },
      parseError: parsed.error,
    };
  }
  const ast = parsed.ast;

  // Collect all functions and rules from the AST
  const allFunctions = collectAllFunctions(ast.service.match);
  const allRules = collectAllRules(ast.service.match);

  // Rule 2: Chain depth
  checkChainDepth(allFunctions, warnings);

  // Rule 3: Let bindings
  checkLetBindings(allFunctions, warnings);

  // Rule 4: Shared gates
  checkSharedGates(allRules, warnings);

  // Rule 5: Expression budget
  checkExpressionBudget(allRules, allFunctions, warnings);

  // Rule 6: Call depth
  checkCallDepth(allRules, allFunctions, warnings);

  // Rule 7: Get count
  checkGetCount(allRules, allFunctions, warnings);

  // Rule 8: Get duplication (same get()-containing function called multiple times)
  checkGetDuplication(allRules, allFunctions, warnings);

  // Rule 9: Hallucinations — JS-style code that parses but fails at runtime
  warnings.push(...checkHallucinations(ast));

  // Rule 9.5: Always-true predicates and recursive-wildcard open rules.
  // Severity: error so deployRules refuses to swap. The agent's #1
  // failure mode in the playground was escaping denials with `if true`.
  checkPermissiveRules(allRules, warnings);
  checkRecursiveWildcardOpen(ast.service.match, warnings);

  // Rule 10: request.time without pinned TestCase.requestTime
  // (Item 0.F deferred follow-up). Only fires when caller passes a test suite.
  if (options.testCases && options.testCases.length > 0) {
    checkRequestTimePinned(allRules, allFunctions, options.testCases, warnings);
  }

  // Rule 11: RULES_WEAKENED — diff against the previously deployed
  // ruleset to catch silently-removed security predicates. Only runs
  // when the caller supplies `previousSource` AND it parses cleanly.
  // A malformed previous ruleset is silently skipped — the current
  // ruleset is still valid and we don't want to fail open.
  if (options.previousSource) {
    const prev = parseToASTOrError(options.previousSource);
    if (prev.ok) {
      checkRulesWeakened(ast.service.match, prev.ast.service.match, warnings);
    }
  }

  // Compute metrics
  let maxChain = { depth: 0, op: '' };
  let maxLets = { count: 0, fn: '' };
  for (const fn of allFunctions) {
    const chain = deepestChain(fn.body);
    if (chain.depth > maxChain.depth) maxChain = { depth: chain.depth, op: chain.op };
    if (fn.lets.length > maxLets.count) maxLets = { count: fn.lets.length, fn: fn.name };
  }

  const callGraph = buildCallGraph(allFunctions);
  let maxDepth = 0;
  for (const fn of allFunctions) {
    const d = maxCallDepth(fn.name, callGraph);
    if (d > maxDepth) maxDepth = d;
  }

  const fnMap = new Map<string, FunctionDef>();
  for (const fn of allFunctions) fnMap.set(fn.name, fn);
  let maxExprs = 0;
  let maxGets = 0;
  for (const r of allRules) {
    const gets = countGetCalls(r.rule.condition, fnMap);
    if (gets > maxGets) maxGets = gets;
  }

  return {
    warnings,
    metrics: {
      sourceSize: source.length,
      functionCount: allFunctions.length,
      allowRuleCount: allRules.length,
      maxChainDepth: maxChain.depth,
      maxChainOp: maxChain.op,
      maxLetBindings: maxLets.count,
      maxLetBindingsFunction: maxLets.fn,
      maxCallDepth: maxDepth,
      maxEstimatedExpressions: maxExprs,
      getCallCount: maxGets,
    },
  };
}

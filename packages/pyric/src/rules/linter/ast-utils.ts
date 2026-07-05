/**
 * AST utility functions for the Firestore rules linter.
 *
 * These are low-level tree-walking primitives that the lint rules compose.
 * Each is independently testable against the linter corpus.
 */
import type { Expression, FunctionDef, AllowRule, MatchBlock } from '../grammar/FirestoreAST.js';

/**
 * Count the maximum flat binary chain depth for a given operator.
 *
 * A flat chain `a && b && c` has depth 3 (three operands joined by &&).
 * Nested chains `(a && b) || (c && d)` have OR-depth 2 and AND-depth 2.
 *
 * The Firestore compilation limit is 98 for both AND and OR chains.
 *
 * The parser builds right-associative trees: `a && b && c` becomes
 * `binaryOp(&&, a, binaryOp(&&, b, c))`. So we count by following the
 * right branch while the operator matches.
 */
export function maxChainDepth(expr: Expression, op: string): number {
  if (expr.type !== 'binaryOp' || expr.op !== op) return 0;
  // Count: 1 for this node + continue down the right branch
  return 1 + maxChainDepth(expr.right, op);
}

/**
 * Find the maximum chain depth for ANY binary operator in an expression tree.
 * Walks all subexpressions to find the deepest chain anywhere.
 */
export function deepestChain(expr: Expression): { op: string; depth: number } {
  let max = { op: '', depth: 0 };

  function walk(e: Expression) {
    if (e.type === 'binaryOp') {
      const andDepth = maxChainDepth(e, '&&');
      const orDepth = maxChainDepth(e, '||');
      if (andDepth > max.depth) max = { op: '&&', depth: andDepth };
      if (orDepth > max.depth) max = { op: '||', depth: orDepth };
      walk(e.left);
      walk(e.right);
    } else {
      walkChildren(e);
    }
  }

  function walkChildren(e: Expression) {
    switch (e.type) {
      case 'unaryOp': walk(e.operand); break;
      case 'methodCall': walk(e.object); e.args.forEach(walk); break;
      case 'memberAccess': walk(e.object); break;
      case 'bracketAccess': walk(e.object); walk(e.index); break;
      case 'ternary': walk(e.condition); walk(e.consequent); walk(e.alternate); break;
      case 'inExpr': walk(e.element); walk(e.collection); break;
      case 'isExpr': walk(e.value); break;
      case 'listLiteral': e.elements.forEach(walk); break;
      case 'mapLiteral': e.entries.forEach(en => { walk(en.key); walk(en.value); }); break;
      case 'functionCall': e.args.forEach(walk); break;
    }
  }

  walk(expr);
  return max;
}

/**
 * Count total expression nodes in an expression tree.
 * Used for runtime budget estimation.
 */
export function countExpressionNodes(expr: Expression): number {
  let count = 1; // this node
  switch (expr.type) {
    case 'binaryOp':
      count += countExpressionNodes(expr.left) + countExpressionNodes(expr.right);
      break;
    case 'unaryOp':
      count += countExpressionNodes(expr.operand);
      break;
    case 'methodCall':
      count += countExpressionNodes(expr.object);
      for (const a of expr.args) count += countExpressionNodes(a);
      break;
    case 'memberAccess':
      count += countExpressionNodes(expr.object);
      break;
    case 'bracketAccess':
      count += countExpressionNodes(expr.object) + countExpressionNodes(expr.index);
      break;
    case 'ternary':
      count += countExpressionNodes(expr.condition) + countExpressionNodes(expr.consequent) + countExpressionNodes(expr.alternate);
      break;
    case 'inExpr':
      count += countExpressionNodes(expr.element) + countExpressionNodes(expr.collection);
      break;
    case 'isExpr':
      count += countExpressionNodes(expr.value);
      break;
    case 'listLiteral':
      for (const el of expr.elements) count += countExpressionNodes(el);
      break;
    case 'mapLiteral':
      for (const en of expr.entries) count += countExpressionNodes(en.key) + countExpressionNodes(en.value);
      break;
    case 'functionCall':
      for (const a of expr.args) count += countExpressionNodes(a);
      break;
    case 'pathLiteral':
      for (const seg of expr.segments) {
        if (typeof seg !== 'string') count += countExpressionNodes(seg);
      }
      break;
  }
  return count;
}

/**
 * Produce a structural fingerprint of an expression for comparison.
 * Used by SHARED_GATE to detect identical first expressions across allow rules.
 *
 * Two expressions with the same fingerprint are structurally identical
 * (same operators, same field names, same literals, same nesting).
 */
export function expressionFingerprint(expr: Expression): string {
  switch (expr.type) {
    case 'literal': return `L:${expr.raw}`;
    case 'identifier': return `I:${expr.name}`;
    case 'memberAccess': return `M:${expressionFingerprint(expr.object)}.${expr.property}`;
    case 'methodCall': return `MC:${expressionFingerprint(expr.object)}.${expr.method}(${expr.args.map(expressionFingerprint).join(',')})`;
    case 'bracketAccess': return `B:${expressionFingerprint(expr.object)}[${expressionFingerprint(expr.index)}]`;
    case 'binaryOp': return `BO:${expressionFingerprint(expr.left)}${expr.op}${expressionFingerprint(expr.right)}`;
    case 'unaryOp': return `UO:${expr.op}${expressionFingerprint(expr.operand)}`;
    case 'ternary': return `T:${expressionFingerprint(expr.condition)}?${expressionFingerprint(expr.consequent)}:${expressionFingerprint(expr.alternate)}`;
    case 'inExpr': return `IN:${expressionFingerprint(expr.element)}in${expressionFingerprint(expr.collection)}`;
    case 'isExpr': return `IS:${expressionFingerprint(expr.value)}is${expr.typeName}`;
    case 'listLiteral': return `LL:[${expr.elements.map(expressionFingerprint).join(',')}]`;
    case 'mapLiteral': return `ML:{${expr.entries.map(e => expressionFingerprint(e.key) + ':' + expressionFingerprint(e.value)).join(',')}}`;
    case 'functionCall': return `FC:${expr.name}(${expr.args.map(expressionFingerprint).join(',')})`;
    case 'pathLiteral': return `PL:${expr.raw}`;
    case 'sliceAccess': return `SL:${expressionFingerprint(expr.object)}[${expressionFingerprint(expr.start)}:${expressionFingerprint(expr.end)}]`;
    default: {
      const _exhaustive: never = expr;
      throw new Error(`expressionFingerprint: unhandled type ${(_exhaustive as { type: string }).type}`);
    }
  }
}

/**
 * Extract the first (leftmost) condition from a binary AND chain.
 * For `a && b && c`, returns `a` (the gate expression).
 *
 * The parser builds: binaryOp(&&, a, binaryOp(&&, b, c))
 * So the first expression is always the left child of the outermost &&.
 */
export function extractFirstExpression(condition: Expression): Expression {
  if (condition.type === 'binaryOp' && condition.op === '&&') {
    return extractFirstExpression(condition.left);
  }
  return condition;
}

/**
 * Build a call graph: function name → list of functions it calls.
 * Includes both direct and let-binding calls.
 */
export function buildCallGraph(functions: FunctionDef[]): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const fnNames = new Set(functions.map(f => f.name));
  const builtins = new Set(['get', 'exists', 'getAfter', 'debug']);

  function collectCalls(expr: Expression): string[] {
    const calls: string[] = [];
    const walk = (e: Expression) => {
      switch (e.type) {
        case 'functionCall':
          if (fnNames.has(e.name) && !builtins.has(e.name)) calls.push(e.name);
          e.args.forEach(walk);
          break;
        case 'binaryOp': walk(e.left); walk(e.right); break;
        case 'unaryOp': walk(e.operand); break;
        case 'methodCall': walk(e.object); e.args.forEach(walk); break;
        case 'memberAccess': walk(e.object); break;
        case 'bracketAccess': walk(e.object); walk(e.index); break;
        case 'ternary': walk(e.condition); walk(e.consequent); walk(e.alternate); break;
        case 'inExpr': walk(e.element); walk(e.collection); break;
        case 'isExpr': walk(e.value); break;
        case 'listLiteral': e.elements.forEach(walk); break;
        case 'mapLiteral': e.entries.forEach(en => { walk(en.key); walk(en.value); }); break;
      }
    };
    walk(expr);
    return [...new Set(calls)];
  }

  for (const fn of functions) {
    const calls: string[] = [];
    calls.push(...collectCalls(fn.body));
    for (const binding of fn.lets) {
      calls.push(...collectCalls(binding.value));
    }
    graph.set(fn.name, [...new Set(calls)]);
  }

  return graph;
}

/**
 * Find the maximum call chain depth from a starting point.
 */
export function maxCallDepth(start: string, graph: Map<string, string[]>, visited = new Set<string>()): number {
  if (visited.has(start)) return 0;
  visited.add(start);
  const callees = graph.get(start) || [];
  if (callees.length === 0) return 1;
  let max = 0;
  for (const callee of callees) {
    max = Math.max(max, maxCallDepth(callee, graph, new Set(visited)));
  }
  return 1 + max;
}

/**
 * Count get() and exists() calls reachable from an expression,
 * following function calls transitively.
 */
export function countGetCalls(expr: Expression, functions: Map<string, FunctionDef>, visited = new Set<string>()): number {
  let count = 0;
  const walk = (e: Expression) => {
    switch (e.type) {
      case 'functionCall':
        if (e.name === 'get' || e.name === 'exists') {
          count++;
        } else if (functions.has(e.name) && !visited.has(e.name)) {
          visited.add(e.name);
          const fn = functions.get(e.name)!;
          walk(fn.body);
          for (const b of fn.lets) walk(b.value);
        }
        e.args.forEach(walk);
        break;
      case 'binaryOp': walk(e.left); walk(e.right); break;
      case 'unaryOp': walk(e.operand); break;
      case 'methodCall': walk(e.object); e.args.forEach(walk); break;
      case 'memberAccess': walk(e.object); break;
      case 'bracketAccess': walk(e.object); walk(e.index); break;
      case 'ternary': walk(e.condition); walk(e.consequent); walk(e.alternate); break;
      case 'inExpr': walk(e.element); walk(e.collection); break;
      case 'isExpr': walk(e.value); break;
      case 'listLiteral': e.elements.forEach(walk); break;
      case 'mapLiteral': e.entries.forEach(en => { walk(en.key); walk(en.value); }); break;
    }
  };
  walk(expr);
  return count;
}

/**
 * Count how many times each user-defined function is called in an expression.
 * Unlike countGetCalls (which deduplicates), this counts raw call-site occurrences.
 */
export function countFunctionCallSites(expr: Expression, fnNames: Set<string>): Map<string, number> {
  const counts = new Map<string, number>();
  const walk = (e: Expression) => {
    switch (e.type) {
      case 'functionCall':
        if (fnNames.has(e.name)) {
          counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
        }
        e.args.forEach(walk);
        break;
      case 'binaryOp': walk(e.left); walk(e.right); break;
      case 'unaryOp': walk(e.operand); break;
      case 'methodCall': walk(e.object); e.args.forEach(walk); break;
      case 'memberAccess': walk(e.object); break;
      case 'bracketAccess': walk(e.object); walk(e.index); break;
      case 'ternary': walk(e.condition); walk(e.consequent); walk(e.alternate); break;
      case 'inExpr': walk(e.element); walk(e.collection); break;
      case 'isExpr': walk(e.value); break;
      case 'listLiteral': e.elements.forEach(walk); break;
      case 'mapLiteral': e.entries.forEach(en => { walk(en.key); walk(en.value); }); break;
    }
  };
  walk(expr);
  return counts;
}

/**
 * Check if a function transitively contains get() or exists() calls.
 */
export function functionContainsGet(fnName: string, fnMap: Map<string, FunctionDef>, visited = new Set<string>()): boolean {
  if (visited.has(fnName)) return false;
  visited.add(fnName);
  const fn = fnMap.get(fnName);
  if (!fn) return false;

  const check = (e: Expression): boolean => {
    switch (e.type) {
      case 'functionCall':
        if (e.name === 'get' || e.name === 'exists') return true;
        if (fnMap.has(e.name)) return functionContainsGet(e.name, fnMap, visited);
        return e.args.some(check);
      case 'binaryOp': return check(e.left) || check(e.right);
      case 'unaryOp': return check(e.operand);
      case 'methodCall': return check(e.object) || e.args.some(check);
      case 'memberAccess': return check(e.object);
      case 'bracketAccess': return check(e.object) || check(e.index);
      case 'ternary': return check(e.condition) || check(e.consequent) || check(e.alternate);
      case 'inExpr': return check(e.element) || check(e.collection);
      case 'isExpr': return check(e.value);
      case 'listLiteral': return e.elements.some(check);
      case 'mapLiteral': return e.entries.some(en => check(en.key) || check(en.value));
      default: return false;
    }
  };

  return check(fn.body) || fn.lets.some(b => check(b.value));
}

/**
 * Check if an expression transitively references `request.time`. Walks
 * subexpressions and follows user-defined function calls. Used by the
 * REQUEST_TIME_NOT_PINNED lint rule (REBUILD_PLAN.md Item 0.F follow-up):
 * a rule that reads `request.time` produces non-deterministic outcomes
 * across CI runs unless the test pins `requestTime`.
 *
 * Matches both the dot form (`request.time`) — `memberAccess` whose
 * object is the identifier `request` and property is `time` — and the
 * bracket form (`request['time']`).
 */
export function referencesRequestTime(
  expr: Expression,
  fnMap: Map<string, FunctionDef>,
  visited = new Set<string>(),
): boolean {
  const check = (e: Expression): boolean => {
    switch (e.type) {
      case 'memberAccess':
        if (
          e.property === 'time' &&
          e.object.type === 'identifier' &&
          e.object.name === 'request'
        ) return true;
        return check(e.object);
      case 'bracketAccess':
        if (
          e.object.type === 'identifier' &&
          e.object.name === 'request' &&
          e.index.type === 'literal' &&
          e.index.value === 'time'
        ) return true;
        return check(e.object) || check(e.index);
      case 'functionCall':
        if (fnMap.has(e.name) && !visited.has(e.name)) {
          visited.add(e.name);
          const fn = fnMap.get(e.name)!;
          if (referencesRequestTime(fn.body, fnMap, visited)) return true;
          if (fn.lets.some(b => referencesRequestTime(b.value, fnMap, visited))) return true;
        }
        return e.args.some(check);
      case 'binaryOp': return check(e.left) || check(e.right);
      case 'unaryOp': return check(e.operand);
      case 'methodCall': return check(e.object) || e.args.some(check);
      case 'ternary': return check(e.condition) || check(e.consequent) || check(e.alternate);
      case 'inExpr': return check(e.element) || check(e.collection);
      case 'isExpr': return check(e.value);
      case 'listLiteral': return e.elements.some(check);
      case 'mapLiteral': return e.entries.some(en => check(en.key) || check(en.value));
      default: return false;
    }
  };
  return check(expr);
}

/**
 * Collect all functions from a match block and its children (recursive).
 */
export function collectAllFunctions(match: MatchBlock): FunctionDef[] {
  const fns = [...match.functions];
  for (const child of match.children) {
    fns.push(...collectAllFunctions(child));
  }
  return fns;
}

/**
 * Collect all allow rules from a match block and its children (recursive).
 */
export function collectAllRules(match: MatchBlock): { rule: AllowRule; path: string; matchFunctions: FunctionDef[] }[] {
  const results: { rule: AllowRule; path: string; matchFunctions: FunctionDef[] }[] = [];
  for (const rule of match.allows) {
    results.push({ rule, path: match.path.raw, matchFunctions: match.functions });
  }
  for (const child of match.children) {
    const childResults = collectAllRules(child);
    // Child rules can access parent functions too
    for (const cr of childResults) {
      cr.matchFunctions = [...match.functions, ...cr.matchFunctions];
    }
    results.push(...childResults);
  }
  return results;
}

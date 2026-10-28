/**
 * AST utility functions for the Firestore rules linter.
 *
 * These are low-level tree-walking primitives that the lint rules compose.
 * Each is independently testable against the linter corpus.
 */
import type { Expression, FunctionDef, AllowRule, MatchBlock, FirestoreRules } from '../grammar/FirestoreAST.js';
import { RULES_BUILTIN_FUNCTIONS } from '../grammar/builtin-functions.js';

/**
 * Count the maximum flat binary chain depth for a given operator.
 *
 * A flat chain `a && b && c` has depth 3 (three operands joined by &&).
 * Nested chains `(a && b) || (c && d)` have OR-depth 2 and AND-depth 2.
 *
 * The Firestore compilation limit is 98 operands for both AND and OR chains.
 *
 * The grammar's `&&` and `||` rules are left-recursive, so the parser builds
 * left-associative trees: `a && b && c` becomes
 * `binaryOp(&&, binaryOp(&&, a, b), c)`. The count follows the left branch
 * while the operator matches. A parenthesized group on the right, as in
 * `a && (b && c)`, starts a separate chain.
 */
export function maxChainDepth(expr: Expression, op: string): number {
  if (expr.type !== 'binaryOp' || expr.op !== op) return 0;
  let operands = 1;
  let node: Expression = expr;
  while (node.type === 'binaryOp' && node.op === op) {
    operands++;
    node = node.left;
  }
  return operands;
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

  function collectCalls(expr: Expression): string[] {
    const calls: string[] = [];
    const walk = (e: Expression) => {
      switch (e.type) {
        case 'functionCall':
          if (fnNames.has(e.name) && !RULES_BUILTIN_FUNCTIONS.has(e.name)) calls.push(e.name);
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
 * Count how many times each user-defined function is called in an expression.
 * Counts raw call-site occurrences at the top level only: it does not expand
 * nested user-function bodies the way countDocumentAccessCalls does.
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
export function functionContainsGet(
  fnName: string,
  fnMap: ReadonlyMap<string, FunctionDef>,
  visited = new Set<string>(),
  fnScopes?: ReadonlyMap<FunctionDef, ReadonlyMap<string, FunctionDef>>,
  visitedFns = new Set<FunctionDef>(),
): boolean {
  const fn = fnMap.get(fnName);
  if (!fn) return false;
  if (visitedFns.has(fn) || visited.has(fnName)) return false;
  visited.add(fnName);
  visitedFns.add(fn);
  const scope = fnScopes?.get(fn) ?? fnMap;

  const check = (e: Expression): boolean => {
    switch (e.type) {
      case 'functionCall':
        if (e.name === 'get' || e.name === 'exists' || e.name === 'getAfter' || e.name === 'existsAfter') return true;
        if (scope.has(e.name) && functionContainsGet(e.name, scope, new Set(), fnScopes, visitedFns)) return true;
        return e.args.some(check);
      case 'binaryOp': return check(e.left) || check(e.right);
      case 'unaryOp': return check(e.operand);
      case 'methodCall':
        if (
          e.object.type === 'identifier' &&
          e.object.name === 'firestore' &&
          (e.method === 'get' || e.method === 'exists')
        ) {
          return true;
        }
        return check(e.object) || e.args.some(check);
      case 'memberAccess': return check(e.object);
      case 'bracketAccess': return check(e.object) || check(e.index);
      case 'sliceAccess': return check(e.object) || check(e.start) || check(e.end);
      case 'ternary': return check(e.condition) || check(e.consequent) || check(e.alternate);
      case 'inExpr': return check(e.element) || check(e.collection);
      case 'isExpr': return check(e.value);
      case 'listLiteral': return e.elements.some(check);
      case 'mapLiteral': return e.entries.some(en => check(en.key) || check(en.value));
      case 'pathLiteral': return e.segments.some(s => typeof s !== 'string' && check(s));
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
  fnMap: ReadonlyMap<string, FunctionDef>,
  visited = new Set<string>(),
  fnScopes?: ReadonlyMap<FunctionDef, ReadonlyMap<string, FunctionDef>>,
  visitedFns = new Set<FunctionDef>(),
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
      case 'sliceAccess':
        return check(e.object) || check(e.start) || check(e.end);
      case 'functionCall': {
        const fn = fnMap.get(e.name);
        if (fn && !visitedFns.has(fn) && !visited.has(e.name)) {
          visited.add(e.name);
          visitedFns.add(fn);
          const calleeScope = fnScopes?.get(fn) ?? fnMap;
          if (referencesRequestTime(fn.body, calleeScope, new Set(), fnScopes, visitedFns)) return true;
          if (fn.lets.some(b => referencesRequestTime(b.value, calleeScope, new Set(), fnScopes, visitedFns))) return true;
        }
        return e.args.some(check);
      }
      case 'binaryOp': return check(e.left) || check(e.right);
      case 'unaryOp': return check(e.operand);
      case 'methodCall': return check(e.object) || e.args.some(check);
      case 'ternary': return check(e.condition) || check(e.consequent) || check(e.alternate);
      case 'inExpr': return check(e.element) || check(e.collection);
      case 'isExpr': return check(e.value);
      case 'listLiteral': return e.elements.some(check);
      case 'mapLiteral': return e.entries.some(en => check(en.key) || check(en.value));
      case 'pathLiteral': return e.segments.some(s => typeof s !== 'string' && check(s));
      default: return false;
    }
  };
  return check(expr);
}

/**
 * Collect every function a ruleset declares: global scope, then service
 * scope, then the match tree. The order is outer to inner, so a name map
 * built by inserting in this order resolves a name to its innermost
 * declaration, the same inner-shadows-outer order the simulator uses.
 */
export function collectDeclaredFunctions(ast: FirestoreRules): FunctionDef[] {
  return [
    ...(ast.functions ?? []),
    ...(ast.service.functions ?? []),
    ...collectAllFunctions(ast.service.match),
  ];
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

function joinMatchPath(parentPath: string, childRaw: string): string {
  if (!parentPath) return childRaw;
  const left = parentPath.endsWith('/') ? parentPath.slice(0, -1) : parentPath;
  const right = childRaw.startsWith('/') ? childRaw : `/${childRaw}`;
  return `${left}${right}`;
}

/**
 * Collect all allow rules from a match block and its children (recursive),
 * joining nested match paths relative to the documents root.
 */
export function collectAllRules(
  match: MatchBlock,
  parentPath = '',
): { rule: AllowRule; path: string; matchFunctions: FunctionDef[] }[] {
  const isDocumentsRoot =
    (match.path.raw.includes('databases') && match.path.raw.includes('documents')) ||
    (match.path.raw.includes('/b/') && match.path.raw.includes('/o')) ||
    /^\/?b\/[^/]+\/o$/.test(match.path.raw);
  const currentPath = joinMatchPath(parentPath, match.path.raw);
  const childPrefix = isDocumentsRoot && !parentPath ? '' : currentPath;
  const results: { rule: AllowRule; path: string; matchFunctions: FunctionDef[] }[] = [];
  for (const rule of match.allows) {
    results.push({ rule, path: currentPath, matchFunctions: match.functions });
  }
  for (const child of match.children) {
    const childResults = collectAllRules(child, childPrefix);
    // Child rules can access parent functions too (outermost first so inner shadows outer)
    for (const cr of childResults) {
      cr.matchFunctions = [...match.functions, ...cr.matchFunctions];
    }
    results.push(...childResults);
  }
  return results;
}

/**
 * Strip line/block comments and replace string literal interiors with spaces
 * so regex-based syntax checks do not match inside strings or comments.
 */
export function stripCommentsAndStrings(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i++;
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i++;
      }
      if (i < source.length) i += 2;
    } else if (ch === "'" || ch === '"') {
      const quote = ch;
      out += quote;
      i++;
      while (i < source.length && source[i] !== quote && source[i] !== '\n') {
        if (source[i] === '\\' && i + 1 < source.length) {
          out += '  ';
          i += 2;
        } else {
          out += ' ';
          i++;
        }
      }
      if (i < source.length && source[i] === quote) {
        out += quote;
        i++;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

export function evalConstBool(expr: Expression): boolean | null {
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
  if (expr.type === 'ternary') {
    const cond = evalConstBool(expr.condition);
    if (cond === true) return evalConstBool(expr.consequent);
    if (cond === false) return evalConstBool(expr.alternate);
    return null;
  }
  return null;
}

export function serializeExpression(expr: Expression): string {
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

export function extractConjuncts(expr: Expression): Expression[] {
  if (expr.type === 'binaryOp' && expr.op === '&&') {
    return [...extractConjuncts(expr.left), ...extractConjuncts(expr.right)];
  }
  return [expr];
}

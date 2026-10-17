/**
 * Lexical name resolution for a Firestore ruleset: which functions and
 * variables each rule and each function body can reach.
 *
 * Production resolves names by declaration scope, not by caller:
 * - A global function (above `service`) sees global functions.
 * - A service function sees global and service functions.
 * - A match function and an allow rule see global, service, and the
 *   functions of every enclosing match block, the innermost declaration
 *   winning. A sibling match block's functions are not visible.
 * - Path captures are visible to rules and functions inside the match that
 *   binds them. A service or global function sees no capture.
 * - Inside a function, its parameters and its `let` bindings are visible.
 *
 * A name that resolves nowhere compiles with a warning ("Invalid function
 * name: s." or "Invalid variable name: d.") and is an error at evaluation.
 * The Rules Test API capture in
 * `test/rules/grammar/fixtures/name-resolution/captures.json` records each
 * case.
 */
import type { AllowRule, Expression, FirestoreRules, FunctionDef, MatchBlock } from './FirestoreAST.js';

/** Bare-call functions every Firestore rule can call: the document lookups,
 *  the `int`, `float`, and `string` conversions, and `path`. `debug` is not
 *  supported in Firestore rules and is reported as undefined (SEM-4). A
 *  ruleset function with the same name shadows one. */
export const FIRESTORE_GLOBAL_FUNCTIONS: ReadonlySet<string> = new Set([
  'get',
  'exists',
  'getAfter',
  'existsAfter',
  'int',
  'float',
  'string',
  'path',
]);

/** Identifiers every Firestore rule can read: the request and resource
 *  values and the method namespaces. */
export const FIRESTORE_GLOBAL_IDENTIFIERS: ReadonlySet<string> = new Set([
  'request',
  'resource',
  'math',
  'timestamp',
  'duration',
  'latlng',
  'hashing',
]);

/** The names visible where one rule or function is declared. */
export interface NameScope {
  /** Label of the declaring scope: a match path, `service <name>`, or `global scope`. */
  label: string;
  /** Functions by name, innermost declaration winning. */
  functions: ReadonlyMap<string, FunctionDef>;
  /** Path captures bound by the enclosing match blocks. */
  captures: ReadonlySet<string>;
}

export interface ScopedFunction extends NameScope { fn: FunctionDef }
export interface ScopedRule extends NameScope { rule: AllowRule; match: MatchBlock }

export interface RulesetScopes {
  functions: ScopedFunction[];
  rules: ScopedRule[];
}

/** Every function declaration and allow rule, each with the names its scope makes visible. */
export function collectRulesetScopes(ast: FirestoreRules): RulesetScopes {
  const out: RulesetScopes = { functions: [], rules: [] };
  const globalFns = ast.functions ?? [];
  const serviceFns = ast.service.functions ?? [];
  const globalScope = withFunctions(new Map(), globalFns);
  const serviceScope = withFunctions(globalScope, serviceFns);
  const none: ReadonlySet<string> = new Set();
  for (const fn of globalFns) out.functions.push({ fn, label: 'global scope', functions: globalScope, captures: none });
  const serviceLabel = `service ${ast.service.name}`;
  for (const fn of serviceFns) out.functions.push({ fn, label: serviceLabel, functions: serviceScope, captures: none });

  const walk = (match: MatchBlock, outerFns: ReadonlyMap<string, FunctionDef>, outerCaptures: ReadonlySet<string>) => {
    const functions = withFunctions(outerFns, match.functions);
    const captures = new Set(outerCaptures);
    for (const seg of match.path.segments) if (seg.type !== 'literal') captures.add(seg.name);
    const label = match.path.raw;
    for (const fn of match.functions) out.functions.push({ fn, label, functions, captures });
    for (const rule of match.allows) out.rules.push({ rule, match, label, functions, captures });
    for (const child of match.children) walk(child, functions, captures);
  };
  walk(ast.service.match, serviceScope, none);
  return out;
}

function withFunctions(outer: ReadonlyMap<string, FunctionDef>, fns: readonly FunctionDef[]): Map<string, FunctionDef> {
  const map = new Map(outer);
  for (const fn of fns) map.set(fn.name, fn);
  return map;
}

/** What one rule condition or function body references. */
export interface NameReferences {
  /** Declarations the calls resolve to, in first-call order. */
  callees: FunctionDef[];
  /** Called names no visible function or global function declares. */
  undefinedCalls: string[];
  /** Read names that are no local binding, capture, or global identifier. */
  unboundVariables: string[];
}

/** Resolve the names an allow rule's condition references. */
export function ruleReferences(scoped: ScopedRule): NameReferences {
  const refs = emptyRefs();
  collectReferences(scoped.rule.condition, scoped, new Set(), refs);
  return refs;
}

/** Resolve the names a function's `let` values and return expression reference. */
export function functionReferences(scoped: ScopedFunction): NameReferences {
  const refs = emptyRefs();
  const locals = new Set(scoped.fn.parameters);
  for (const binding of scoped.fn.lets) {
    collectReferences(binding.value, scoped, locals, refs);
    locals.add(binding.name);
  }
  collectReferences(scoped.fn.body, scoped, locals, refs);
  return refs;
}

function emptyRefs(): NameReferences {
  return { callees: [], undefinedCalls: [], unboundVariables: [] };
}

function collectReferences(expr: Expression, scope: NameScope, locals: ReadonlySet<string>, refs: NameReferences): void {
  const addOnce = <T>(list: T[], value: T) => { if (!list.includes(value)) list.push(value); };
  const walk = (e: Expression): void => {
    switch (e.type) {
      case 'identifier':
        if (!locals.has(e.name) && !scope.captures.has(e.name) && !FIRESTORE_GLOBAL_IDENTIFIERS.has(e.name)) {
          addOnce(refs.unboundVariables, e.name);
        }
        return;
      case 'functionCall': {
        const target = scope.functions.get(e.name);
        if (target) addOnce(refs.callees, target);
        else if (!FIRESTORE_GLOBAL_FUNCTIONS.has(e.name)) addOnce(refs.undefinedCalls, e.name);
        e.args.forEach(walk);
        return;
      }
      case 'binaryOp': walk(e.left); walk(e.right); return;
      case 'unaryOp': walk(e.operand); return;
      case 'ternary': walk(e.condition); walk(e.consequent); walk(e.alternate); return;
      case 'methodCall': walk(e.object); e.args.forEach(walk); return;
      case 'bracketAccess': walk(e.object); walk(e.index); return;
      case 'sliceAccess': walk(e.object); walk(e.start); walk(e.end); return;
      case 'memberAccess': walk(e.object); return;
      case 'inExpr': walk(e.element); walk(e.collection); return;
      case 'isExpr': walk(e.value); return;
      case 'listLiteral': e.elements.forEach(walk); return;
      case 'mapLiteral': e.entries.forEach(en => { walk(en.key); walk(en.value); }); return;
      case 'pathLiteral': for (const seg of e.segments) if (typeof seg !== 'string') walk(seg); return;
      case 'literal': return;
      default: {
        const exhaustive: never = e;
        throw new Error(`collectReferences: unhandled type ${(exhaustive as { type: string }).type}`);
      }
    }
  };
  walk(expr);
}

/**
 * The longest call chain starting at each function, counted in functions
 * (a function that calls nothing has depth 1). Calls resolve by scope. A
 * cycle contributes no further depth and does not poison cached depths for
 * callers entering the cycle at another node.
 */
export function callChainDepths(scopes: RulesetScopes): Map<FunctionDef, number> {
  return analyzeCallChains(scopes).depths;
}

/**
 * Functions that participate in or reach a recursive call cycle, resolved by
 * declaration scope.
 */
export function cyclicFunctions(scopes: RulesetScopes): ReadonlySet<FunctionDef> {
  return analyzeCallChains(scopes).cyclic;
}

export function analyzeCallChains(scopes: RulesetScopes): {
  depths: Map<FunctionDef, number>;
  cyclic: ReadonlySet<FunctionDef>;
} {
  const callees = new Map<FunctionDef, FunctionDef[]>();
  for (const scoped of scopes.functions) callees.set(scoped.fn, functionReferences(scoped).callees);
  const cleanDepths = new Map<FunctionDef, number>();
  const depths = new Map<FunctionDef, number>();
  const cyclic = new Set<FunctionDef>();
  const visit = (fn: FunctionDef, onStack: Set<FunctionDef>): { depth: number; hitStack: boolean } => {
    const known = cleanDepths.get(fn);
    if (known !== undefined) return { depth: known, hitStack: false };
    if (onStack.has(fn)) return { depth: 0, hitStack: true };
    onStack.add(fn);
    let deepest = 0;
    let hitStack = false;
    for (const callee of callees.get(fn) ?? []) {
      const sub = visit(callee, onStack);
      deepest = Math.max(deepest, sub.depth);
      if (sub.hitStack) hitStack = true;
    }
    onStack.delete(fn);
    const result = 1 + deepest;
    if (!hitStack) cleanDepths.set(fn, result);
    return { depth: result, hitStack };
  };
  for (const scoped of scopes.functions) {
    const res = visit(scoped.fn, new Set());
    depths.set(scoped.fn, res.depth);
    if (res.hitStack) cyclic.add(scoped.fn);
  }
  return { depths, cyclic };
}

function substituteLets(expr: Expression, bindings: ReadonlyMap<string, Expression>): Expression {
  if (bindings.size === 0) return expr;
  switch (expr.type) {
    case 'identifier':
      return bindings.get(expr.name) ?? expr;
    case 'binaryOp':
      return { ...expr, left: substituteLets(expr.left, bindings), right: substituteLets(expr.right, bindings) };
    case 'unaryOp':
      return { ...expr, operand: substituteLets(expr.operand, bindings) };
    case 'ternary':
      return {
        ...expr,
        condition: substituteLets(expr.condition, bindings),
        consequent: substituteLets(expr.consequent, bindings),
        alternate: substituteLets(expr.alternate, bindings),
      };
    case 'methodCall':
      return {
        ...expr,
        object: substituteLets(expr.object, bindings),
        args: expr.args.map(a => substituteLets(a, bindings)),
      };
    case 'functionCall':
      return { ...expr, args: expr.args.map(a => substituteLets(a, bindings)) };
    case 'bracketAccess':
      return { ...expr, object: substituteLets(expr.object, bindings), index: substituteLets(expr.index, bindings) };
    case 'sliceAccess':
      return {
        ...expr,
        object: substituteLets(expr.object, bindings),
        start: substituteLets(expr.start, bindings),
        end: substituteLets(expr.end, bindings),
      };
    case 'memberAccess':
      return { ...expr, object: substituteLets(expr.object, bindings) };
    case 'inExpr':
      return { ...expr, element: substituteLets(expr.element, bindings), collection: substituteLets(expr.collection, bindings) };
    case 'isExpr':
      return { ...expr, value: substituteLets(expr.value, bindings) };
    case 'listLiteral':
      return { ...expr, elements: expr.elements.map(e => substituteLets(e, bindings)) };
    case 'mapLiteral':
      return {
        ...expr,
        entries: expr.entries.map(e => ({
          key: substituteLets(e.key, bindings),
          value: substituteLets(e.value, bindings),
        })),
      };
    case 'pathLiteral':
      return {
        ...expr,
        segments: expr.segments.map(s => {
          if (typeof s === 'string') return s;
          return substituteLets(s, bindings);
        }),
      };
    default:
      return expr;
  }
}

/**
 * Expand a function's `let` bindings sequentially into its return body.
 */
export function expandFunctionBody(fn: FunctionDef): Expression {
  if (fn.lets.length === 0) return fn.body;
  const bindings = new Map<string, Expression>();
  const params = new Set(fn.parameters);
  for (const b of fn.lets) {
    if (params.has(b.name)) continue;
    bindings.set(b.name, substituteLets(b.value, bindings));
  }
  return substituteLets(fn.body, bindings);
}

export function exprDepth(expr: Expression): number {
  switch (expr.type) {
    case 'binaryOp': return 1 + Math.max(exprDepth(expr.left), exprDepth(expr.right));
    case 'unaryOp': return 1 + exprDepth(expr.operand);
    case 'ternary': return 1 + Math.max(exprDepth(expr.condition), exprDepth(expr.consequent), exprDepth(expr.alternate));
    case 'methodCall': return 1 + Math.max(exprDepth(expr.object), ...expr.args.map(exprDepth));
    case 'functionCall': return 1 + Math.max(0, ...expr.args.map(exprDepth));
    case 'bracketAccess': return 1 + Math.max(exprDepth(expr.object), exprDepth(expr.index));
    case 'sliceAccess': return 1 + Math.max(exprDepth(expr.object), exprDepth(expr.start), exprDepth(expr.end));
    case 'memberAccess': return 1 + exprDepth(expr.object);
    case 'inExpr': return 1 + Math.max(exprDepth(expr.element), exprDepth(expr.collection));
    case 'isExpr': return 1 + exprDepth(expr.value);
    case 'pathLiteral': {
      const exprSegs = expr.segments.filter((s): s is Expression => typeof s !== 'string');
      if (exprSegs.length === 0) return 0;
      return 1 + Math.max(...exprSegs.map(exprDepth));
    }
    default: return 0;
  }
}

export function exprContains(expr: Expression, predicate: (e: Expression) => boolean): boolean {
  if (predicate(expr)) return true;
  switch (expr.type) {
    case 'binaryOp': return exprContains(expr.left, predicate) || exprContains(expr.right, predicate);
    case 'unaryOp': return exprContains(expr.operand, predicate);
    case 'ternary': return exprContains(expr.condition, predicate) || exprContains(expr.consequent, predicate) || exprContains(expr.alternate, predicate);
    case 'methodCall': return exprContains(expr.object, predicate) || expr.args.some(a => exprContains(a, predicate));
    case 'functionCall': return expr.args.some(a => exprContains(a, predicate));
    case 'bracketAccess': return exprContains(expr.object, predicate) || exprContains(expr.index, predicate);
    case 'sliceAccess': return exprContains(expr.object, predicate) || exprContains(expr.start, predicate) || exprContains(expr.end, predicate);
    case 'memberAccess': return exprContains(expr.object, predicate);
    case 'inExpr': return exprContains(expr.element, predicate) || exprContains(expr.collection, predicate);
    case 'isExpr': return exprContains(expr.value, predicate);
    case 'listLiteral': return expr.elements.some(e => exprContains(e, predicate));
    case 'mapLiteral': return expr.entries.some(e => exprContains(e.key, predicate) || exprContains(e.value, predicate));
    case 'pathLiteral': return expr.segments.some(s => typeof s !== 'string' && exprContains(s, predicate));
    default: return false;
  }
}

export function walkExpr(expr: Expression, visitor: (e: Expression) => void): void {
  visitor(expr);
  switch (expr.type) {
    case 'binaryOp': walkExpr(expr.left, visitor); walkExpr(expr.right, visitor); break;
    case 'unaryOp': walkExpr(expr.operand, visitor); break;
    case 'ternary': walkExpr(expr.condition, visitor); walkExpr(expr.consequent, visitor); walkExpr(expr.alternate, visitor); break;
    case 'methodCall': walkExpr(expr.object, visitor); expr.args.forEach(a => walkExpr(a, visitor)); break;
    case 'functionCall': expr.args.forEach(a => walkExpr(a, visitor)); break;
    case 'bracketAccess': walkExpr(expr.object, visitor); walkExpr(expr.index, visitor); break;
    case 'sliceAccess': walkExpr(expr.object, visitor); walkExpr(expr.start, visitor); walkExpr(expr.end, visitor); break;
    case 'memberAccess': walkExpr(expr.object, visitor); break;
    case 'inExpr': walkExpr(expr.element, visitor); walkExpr(expr.collection, visitor); break;
    case 'isExpr': walkExpr(expr.value, visitor); break;
    case 'listLiteral': expr.elements.forEach(e => walkExpr(e, visitor)); break;
    case 'mapLiteral': expr.entries.forEach(e => { walkExpr(e.key, visitor); walkExpr(e.value, visitor); }); break;
    case 'pathLiteral': expr.segments.forEach(s => { if (typeof s !== 'string') walkExpr(s, visitor); }); break;
  }
}

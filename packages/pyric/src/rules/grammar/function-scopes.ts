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
import { RULES_BUILTIN_FUNCTIONS } from './builtin-functions.js';

/** Bare-call functions every Firestore rule can call: the document lookups,
 *  `debug`, the `int`, `float`, and `string` conversions, and `path`. A
 *  ruleset function with the same name shadows one. */
export const FIRESTORE_GLOBAL_FUNCTIONS: ReadonlySet<string> = new Set([
  ...RULES_BUILTIN_FUNCTIONS,
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
  const locals = new Set([...scoped.fn.parameters, ...scoped.fn.lets.map(l => l.name)]);
  for (const binding of scoped.fn.lets) collectReferences(binding.value, scoped, locals, refs);
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
 * cycle contributes no further depth.
 */
export function callChainDepths(scopes: RulesetScopes): Map<FunctionDef, number> {
  const callees = new Map<FunctionDef, FunctionDef[]>();
  for (const scoped of scopes.functions) callees.set(scoped.fn, functionReferences(scoped).callees);
  const depths = new Map<FunctionDef, number>();
  const depth = (fn: FunctionDef, onStack: Set<FunctionDef>): number => {
    const known = depths.get(fn);
    if (known !== undefined) return known;
    if (onStack.has(fn)) return 0;
    onStack.add(fn);
    let deepest = 0;
    for (const callee of callees.get(fn) ?? []) deepest = Math.max(deepest, depth(callee, onStack));
    onStack.delete(fn);
    depths.set(fn, 1 + deepest);
    return 1 + deepest;
  };
  for (const scoped of scopes.functions) depth(scoped.fn, new Set());
  return depths;
}

// Unified static checker for Policy IR: extensions, lexical scope, int64 literals,
// strict call-graph acyclicity (DAG), bounded iteration caps, and target method/builtin allowlists.
import type { Expression, FunctionDef } from '../grammar/FirestoreAST.js';
import { isNegatedLiteral } from '../grammar/compile-limits.js';
import { isPureValueMethod } from '../simulator/evaluation-builtins.js';
import { invalidNumberLiteralMessage, outOfRangeLiteral } from '../simulator/rules-int.js';
import { checkLoop, type CheckedLoop } from './for-of.js';
import {
  asPureRulesExpr,
  irChildren,
  irFieldPath,
  isPureRulesExpr,
  type IRExpr,
  type IRFunction,
  type IRLetBinding,
  type IRProgram,
  type PolicyProgramKind,
} from './ir.js';

export const STANDALONE_HELPER_ARITIES: ReadonlyMap<string, number> = new Map(
  Object.entries({
    size: 1,
    replaceAt: 3,
    range: 1,
    locate: 2,
    sorted: 1,
    chain: 2,
    omit: 2,
    fail: 1,
    abs: 1,
    sign: 1,
    kind: 1,
  }),
);

export const RULES_CONVERSION_ARITIES: ReadonlyMap<string, number> = new Map([
  ['int', 1],
  ['float', 1],
  ['string', 1],
]);

export const RULES_NAMESPACE_METHODS: Readonly<Record<string, ReadonlyMap<string, number>>> = {
  math: new Map([
    ['abs', 1],
    ['ceil', 1],
    ['floor', 1],
    ['round', 1],
    ['sqrt', 1],
    ['pow', 2],
    ['isNaN', 1],
  ]),
  timestamp: new Map([
    ['date', 3],
    ['value', 1],
  ]),
  duration: new Map([
    ['value', 2],
    ['time', 4],
    ['abs', 1],
  ]),
};

export const RULES_VALUE_METHOD_ARITIES: ReadonlyMap<string, ReadonlySet<number>> = new Map([
  ['size', new Set([0])],
  ['lower', new Set([0])],
  ['upper', new Set([0])],
  ['trim', new Set([0])],
  ['toUtf8', new Set([0])],
  ['matches', new Set([1])],
  ['split', new Set([1])],
  ['replace', new Set([2])],
  ['hasAll', new Set([1])],
  ['hasAny', new Set([1])],
  ['hasOnly', new Set([1])],
  ['concat', new Set([1])],
  ['join', new Set([1])],
  ['removeAll', new Set([1])],
  ['toSet', new Set([0])],
  ['keys', new Set([0])],
  ['values', new Set([0])],
  ['get', new Set([2])],
  ['diff', new Set([1])],
  ['difference', new Set([1])],
  ['union', new Set([1])],
  ['intersection', new Set([1])],
  ['addedKeys', new Set([0])],
  ['removedKeys', new Set([0])],
  ['changedKeys', new Set([0])],
  ['affectedKeys', new Set([0])],
  ['unchangedKeys', new Set([0])],
  ['toBase64', new Set([0])],
  ['toHexString', new Set([0])],
  ['seconds', new Set([0])],
  ['nanos', new Set([0])],
  ['toMillis', new Set([0])],
  ['year', new Set([0])],
  ['month', new Set([0])],
  ['day', new Set([0])],
  ['hours', new Set([0])],
  ['minutes', new Set([0])],
  ['dayOfWeek', new Set([0])],
  ['dayOfYear', new Set([0])],
  ['date', new Set([0])],
  ['time', new Set([0])],
]);

export const RULES_TYPE_NAMES: ReadonlySet<string> = new Set([
  'string',
  'int',
  'float',
  'number',
  'bool',
  'null',
  'list',
  'set',
  'map',
  'timestamp',
  'duration',
  'bytes',
  'path',
  'latlng',
  'reference',
]);

const RESERVED_EXPORTS = new Set(['default', 'await', 'yield', 'eval', 'arguments']);
const KNOWN_EXTENSIONS = new Set(['bounded', 'derive', 'loops']);

export interface CheckOptions {
  expressionLimit?: number;
}

export interface CheckedFunction {
  id: number;
  fn: IRFunction;
  deps: ReadonlySet<string>;
  loop?: CheckedLoop;
}

export interface CheckedPolicyIR {
  program: IRProgram;
  expressionLimit: number;
  extensions: ReadonlySet<string>;
  functions: ReadonlyMap<string, CheckedFunction>;
  topoOrder: readonly string[];
  exports: readonly string[];
  reads: ReadonlyMap<string, ReadonlySet<string>>;
  usesDerived: ReadonlySet<string>;
  requirementNames: readonly string[];
}

export function checkExpressionLimit(expressionLimit: number, maxLimit = 32768): void {
  if (!Number.isSafeInteger(expressionLimit) || expressionLimit < 1 || expressionLimit > maxLimit) {
    throw new Error('Policy expression limit must be an integer from 1 to ' + maxLimit);
  }
}

/** Add a unique identifier to a lexical scope (avoiding Bun's `declare(...)` parser pitfall). */
function addBinding(names: Set<string>, name: string): void {
  if (names.has(name)) throw new Error('Duplicate binding: ' + name);
  names.add(name);
}

/** Enforce Rules int64 literal bounds across every reachable or unreachable IR subtree. */
export function checkIRIntegerLiterals(expr: IRExpr): void {
  if (expr.type === 'unaryOp' && expr.op === '-' && isPureRulesExpr(expr) && isNegatedLiteral(expr, true)) {
    const operand = expr.operand;
    if (operand.type === 'literal') {
      const invalid = outOfRangeLiteral(operand.value, operand.raw, true);
      if (invalid) throw new Error(invalidNumberLiteralMessage(invalid));
      return;
    }
  }
  if (expr.type === 'literal') {
    const invalid = outOfRangeLiteral(expr.value, expr.raw, false);
    if (invalid) throw new Error(invalidNumberLiteralMessage(invalid));
    return;
  }
  for (const child of irChildren(expr)) checkIRIntegerLiterals(child);
}

function checkAcyclicity(
  fnOrder: Iterable<string>,
  depsMap: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const visited = new Set<string>();
  const active = new Set<string>();
  const topo: string[] = [];
  function visit(name: string): void {
    if (active.has(name)) throw new Error('Recursive calls are unsupported at ' + name);
    if (visited.has(name)) return;
    active.add(name);
    for (const dep of depsMap.get(name) ?? []) visit(dep);
    active.delete(name);
    visited.add(name);
    topo.push(name);
  }
  for (const name of fnOrder) visit(name);
  return topo;
}

function checkExtensions(program: IRProgram): Set<string> {
  const extensions = new Set<string>();
  for (const ext of program.extensions) {
    if (!KNOWN_EXTENSIONS.has(ext)) throw new Error('Unknown extension');
    extensions.add(ext);
  }
  if (program.kind === 'transition') {
    for (const ext of extensions) {
      if (ext !== 'bounded' && ext !== 'derive') throw new Error('Unknown extension');
    }
  } else if (program.kind === 'module') {
    if (!extensions.has('bounded')) throw new Error('Bounded module requires use extension bounded;');
    for (const ext of extensions) {
      if (ext !== 'bounded' && ext !== 'loops') throw new Error('Unknown extension');
    }
  } else {
    const fn = program.functions[0];
    if (fn?.loop) {
      if (program.extensions.length !== 1 || program.extensions[0] !== 'loops') {
        throw new Error('for...of requires use extension loops;');
      }
    } else if (program.extensions.some((ext) => ext !== 'bounded' && ext !== 'loops')) {
      throw new Error('Unknown extension');
    }
  }
  return extensions;
}

interface ExprCheckContext {
  kind: PolicyProgramKind;
  extensions: ReadonlySet<string>;
  functions: ReadonlyMap<string, IRFunction>;
  deps?: Set<string>;
  read?: (path: string) => void;
  locationPrefix?: string;
}

function maxBoundedLimit(kind: PolicyProgramKind): number {
  return kind === 'module' ? 4096 : 400;
}

function checkExpr(expr: IRExpr, names: Set<string>, ctx: ExprCheckContext): void {
  const visit = (child: IRExpr, scope = names) => checkExpr(child, scope, ctx);
  const path = irFieldPath(expr);
  if (path) ctx.read?.(path);

  switch (expr.type) {
    case 'literal':
      return;
    case 'listLiteral':
      for (const item of expr.elements) visit(item);
      return;
    case 'mapLiteral': {
      const staticKeys = ctx.kind === 'module' ? new Set<string>() : undefined;
      for (const entry of expr.entries) {
        if (ctx.kind === 'module') {
          const k =
            entry.key.type === 'identifier'
              ? entry.key.name
              : entry.key.type === 'literal' && typeof entry.key.value === 'string'
                ? entry.key.value
                : undefined;
          if (k === undefined) throw new Error('Expected a static record key');
          if (staticKeys!.has(k)) throw new Error('Duplicate record key ' + k);
          staticKeys!.add(k);
        } else {
          visit(entry.key);
        }
        visit(entry.value);
      }
      return;
    }
    case 'identifier':
      if (!names.has(expr.name)) throw new Error('Undeclared binding: ' + expr.name);
      return;
    case 'memberAccess':
      checkExpr(expr.object, names, path ? { ...ctx, read: undefined } : ctx);
      return;
    case 'binaryOp':
      visit(expr.left);
      visit(expr.right);
      return;
    case 'unaryOp':
      visit(expr.operand);
      return;
    case 'inExpr':
      visit(expr.element);
      visit(expr.collection);
      return;
    case 'isExpr':
      if (!RULES_TYPE_NAMES.has(expr.typeName)) {
        throw new Error('Unknown Rules type: ' + expr.typeName);
      }
      visit(expr.value);
      return;
    case 'ternary':
      visit(expr.condition);
      visit(expr.consequent);
      visit(expr.alternate);
      return;
    case 'bracketAccess':
      if (ctx.kind === 'transition') break;
      visit(expr.object);
      visit(expr.index);
      return;
    case 'sliceAccess':
      if (ctx.kind !== 'module') break;
      visit(expr.object);
      visit(expr.start);
      visit(expr.end);
      return;
    case 'methodCall': {
      if (expr.object.type === 'identifier' && expr.object.name === 'bounded' && !names.has('bounded')) {
        throw new Error('Invalid bounded.' + expr.method + ' call or bound');
      }
      if (ctx.kind === 'transition') break;
      if (ctx.kind === 'function') {
        if (!isPureValueMethod(expr.method, expr.args.length)) break;
        visit(expr.object);
        for (const arg of expr.args) visit(arg);
        return;
      }
      // Module profile: support Rules namespaces (`math.*`, `timestamp.*`, `duration.*`)
      // when not shadowed by a lexical binding, plus standard Rules value methods.
      if (
        expr.object.type === 'identifier' &&
        !names.has(expr.object.name) &&
        Object.hasOwn(RULES_NAMESPACE_METHODS, expr.object.name)
      ) {
        const nsMethods = RULES_NAMESPACE_METHODS[expr.object.name]!;
        if (nsMethods.get(expr.method) !== expr.args.length) {
          throw new Error(`Unknown namespace method or invalid arity for ${expr.object.name}.${expr.method}`);
        }
        for (const arg of expr.args) visit(arg);
        return;
      }
      const allowedArities = RULES_VALUE_METHOD_ARITIES.get(expr.method);
      if (!allowedArities || !allowedArities.has(expr.args.length)) {
        throw new Error(`Unsupported method or invalid arity for .${expr.method}`);
      }
      visit(expr.object);
      for (const arg of expr.args) visit(arg);
      return;
    }
    case 'functionCall': {
      const callee = ctx.functions.get(expr.name);
      if (callee) {
        if (expr.args.length !== callee.parameters.length) {
          throw new Error('Invalid arity for ' + expr.name);
        }
        ctx.deps?.add(expr.name);
        for (const arg of expr.args) visit(arg);
        return;
      }
      if (ctx.kind !== 'module') break;
      const helperArity = STANDALONE_HELPER_ARITIES.get(expr.name);
      const convArity = RULES_CONVERSION_ARITIES.get(expr.name);
      if (helperArity === expr.args.length || convArity === expr.args.length) {
        for (const arg of expr.args) visit(arg);
        return;
      }
      throw new Error('Unknown function or invalid arity for ' + expr.name);
    }
    case 'boundedOp': {
      if (!ctx.extensions.has('bounded')) {
        throw new Error((ctx.locationPrefix ?? '') + 'bounded.' + expr.op + ' requires use extension bounded;');
      }
      const cap = maxBoundedLimit(ctx.kind);
      if (!Number.isInteger(expr.limit) || expr.limit < 1 || expr.limit > cap) {
        throw new Error(ctx.kind === 'module' ? 'Invalid traversal bound' : `Collection limit must be 1..${cap}`);
      }
      visit(expr.list);
      if (expr.op === 'append') {
        visit(expr.suffix);
        return;
      }
      const nested = new Set(names);
      if (expr.op === 'fold') {
        visit(expr.initial);
        addBinding(nested, expr.accumulator);
        addBinding(nested, expr.item);
        for (const binding of expr.lets) {
          visit(binding.value, nested);
          addBinding(nested, binding.name);
        }
        visit(expr.body, nested);
        return;
      }
      addBinding(nested, expr.item);
      visit(expr.body, nested);
      return;
    }
  }
  throw new Error(
    ctx.kind === 'module'
      ? 'Unsupported standalone expression ' + expr.type
      : expr.type + ' is outside the experimental pure expression subset',
  );
}

function checkLetList(lets: readonly IRLetBinding[], names: Set<string>, ctx: ExprCheckContext): void {
  for (const binding of lets) {
    checkExpr(binding.value, names, ctx);
    addBinding(names, binding.name);
  }
}

function checkFunctionLoop(fn: IRFunction, names: Set<string>, ctx: ExprCheckContext): CheckedLoop {
  if (!ctx.extensions.has('loops')) {
    throw new Error('for...of requires use extension loops;');
  }
  const loop = fn.loop!;
  if (!isPureRulesExpr(loop.collection) || !isPureRulesExpr(fn.body)) {
    throw new Error(fn.name + ': for...of loop requires pure loop header and return expression');
  }
  const pureLets = fn.lets.map((l) => ({ name: l.name, value: asPureRulesExpr(l.value), loc: l.loc }));
  const pureFn: FunctionDef = {
    name: fn.name,
    parameters: fn.parameters,
    exported: fn.exported,
    lets: pureLets,
    body: asPureRulesExpr(fn.body),
    loc: fn.loc,
    returnLoc: fn.returnLoc,
  };
  const pureStep =
    loop.step.kind === 'guards'
      ? {
          kind: 'guards' as const,
          guards: loop.step.guards.map((g) => ({
            condition: asPureRulesExpr(g.condition),
            result: asPureRulesExpr(g.result),
          })),
        }
      : { kind: 'update' as const, target: loop.step.target, value: asPureRulesExpr(loop.step.value) };
  return checkLoop(
    pureFn,
    { item: loop.item, collection: asPureRulesExpr(loop.collection), step: pureStep },
    names,
    (expr: Expression, scope: Set<string>) => checkExpr(expr, scope, ctx),
  );
}

/** Statically check a parsed Policy IR program and return a verified CheckedPolicyIR. */
export function checkPolicyIR(program: IRProgram, options: CheckOptions = {}): CheckedPolicyIR {
  const maxLimit = program.kind === 'module' ? 1000000 : 32768;
  const expressionLimit = options.expressionLimit ?? (program.kind === 'module' ? 1000000 : 8192);
  checkExpressionLimit(expressionLimit, maxLimit);
  const extensions = checkExtensions(program);

  const fnDefs = new Map<string, IRFunction>();
  for (const fn of program.functions) {
    if (fnDefs.has(fn.name)) throw new Error('Duplicate function ' + fn.name);
    if (
      program.kind === 'module' &&
      (STANDALONE_HELPER_ARITIES.has(fn.name) || RULES_CONVERSION_ARITIES.has(fn.name))
    ) {
      throw new Error('Duplicate function ' + fn.name);
    }
    if (program.kind === 'module' && RESERVED_EXPORTS.has(fn.name)) {
      throw new Error('Reserved function name ' + fn.name);
    }
    fnDefs.set(fn.name, fn);
  }

  const checkedFunctions = new Map<string, CheckedFunction>();
  const depsMap = new Map<string, Set<string>>();
  const exports: string[] = [];

  for (const fn of program.functions) {
    const deps = new Set<string>();
    depsMap.set(fn.name, deps);
    const names = new Set<string>();
    for (const param of fn.parameters) addBinding(names, param);
    const ctx: ExprCheckContext = {
      kind: program.kind,
      extensions,
      functions: fnDefs,
      deps,
    };
    for (const binding of fn.lets) checkIRIntegerLiterals(binding.value);
    checkIRIntegerLiterals(fn.body);
    checkLetList(fn.lets, names, ctx);
    let checkedLoop: CheckedLoop | undefined;
    if (fn.loop) {
      checkedLoop = checkFunctionLoop(fn, names, ctx);
    }
    checkExpr(fn.body, names, ctx);
    checkedFunctions.set(fn.name, {
      id: checkedFunctions.size,
      fn,
      deps,
      loop: checkedLoop,
    });
    if (fn.exported) exports.push(fn.name);
  }

  const topoOrder = checkAcyclicity(fnDefs.keys(), depsMap);
  if (program.kind === 'module' && !exports.length) {
    throw new Error('Bounded module needs a public function');
  }

  const reads = new Map<string, Set<string>>();
  const usesDerived = new Set<string>();
  const requirementNames: string[] = [];

  if (program.transition) {
    const { derivation, requirements } = program.transition;
    if (derivation) {
      if (!extensions.has('derive')) throw new Error('derive requires use extension derive;');
      const names = new Set(['before', 'input']);
      const ctx: ExprCheckContext = { kind: 'transition', extensions, functions: fnDefs };
      for (const binding of derivation.lets) checkIRIntegerLiterals(binding.value);
      checkIRIntegerLiterals(derivation.expr);
      checkLetList(derivation.lets, names, ctx);
      if (derivation.expr.type !== 'mapLiteral') throw new Error('derive must return a map literal');
      for (const { key, value } of derivation.expr.entries) {
        checkExpr(key, names, ctx);
        checkExpr(value, names, ctx);
      }
    }
    const seen = new Set<string>();
    for (const rule of requirements) {
      addBinding(seen, rule.name);
      requirementNames.push(rule.name);
      const inputs = new Set<string>();
      reads.set(rule.name, inputs);
      const names = new Set(['before', 'after', 'input']);
      if (derivation) names.add('derived');
      const roots = new Set(names);
      const recordRead = (path: string) => {
        const root = path.split('.')[0]!;
        if (roots.has(root)) inputs.add(path);
        if (derivation && root === 'derived') usesDerived.add(rule.name);
      };
      const ctx: ExprCheckContext = {
        kind: 'transition',
        extensions,
        functions: fnDefs,
        read: recordRead,
        locationPrefix: rule.location + ': ',
      };
      try {
        for (const binding of rule.lets) checkIRIntegerLiterals(binding.value);
        checkIRIntegerLiterals(rule.condition);
        checkLetList(rule.lets, names, ctx);
        checkExpr(rule.condition, names, ctx);
      } catch (error) {
        throw new Error(rule.name + ' at ' + rule.location + ': ' + (error instanceof Error ? error.message : error));
      }
    }
  }

  return {
    program,
    expressionLimit,
    extensions,
    functions: checkedFunctions,
    topoOrder,
    exports,
    reads,
    usesDerived,
    requirementNames,
  };
}

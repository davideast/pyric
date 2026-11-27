// Experimental opt-in entry. Standard rules loaders never import this grammar.
import { emitRtdbNumericPredicate, type NumericSnapshot } from './rtdb-predicate.js';
import { bindRealtime, composeFirestore, type FirestoreTemplate, type RealtimePlacement } from './placement.js';
import { compileProjections, emitFirestoreModule, emitPureFunctionModule, lowerFirestore, field, type FirestoreBindings } from './firestore.js';
import { bindDerivedLocals, derivedCollectionReads, projectDerivedField } from './derived-field.js';
import * as ohm from 'ohm-js';
import { checkLoop, evaluateLoop, emitLoopModule, type FunctionLoop, type GuardReturn, type LoopBody, type LoopFunction } from './for-of.js';
import { firestoreGrammar, firestoreSemantics } from '../grammar/FirestoreParser.js';
import type { Expression, FunctionDef } from '../grammar/FirestoreAST.js';
import { isPureValueMethod } from '../simulator/evaluation-builtins.js';
import { TraceRecorder } from '../simulator/trace-recorder.js';
import { boundSourceNesting } from '../grammar/source-nesting-bound.js';
import { evaluate, evaluateBinding, isErrorValue } from '../simulator/evaluator.js';
import { EvalError, ExpressionLimitError, ResourceLimitError } from '../simulator/eval-error.js';
import { ExpressionBudget } from '../simulator/expression-budget.js';

const grammar = ohm.grammar(`Policy <: FirestoreRules {
  PureFunction = LoopFunction | FunctionDef
  LoopFunction = LoopImport* "export"? functionToken ident "(" ParameterList ")" "{" LetBinding* ForOf ReturnStatement "}"
  LoopImport = useToken extensionToken ident ";"
  useToken = "use" ~identChar
  extensionToken = "extension" ~identChar
  functionToken = "function" ~identChar
  constToken = "const" ~identChar
  ofToken = "of" ~identChar
  ForOf = "for" "(" constToken ident ofToken Expr ")" "{" LoopBody "}"
  LoopBody = GuardReturn+ -- guards
           | ident "=" Expr ";" -- update
  GuardReturn = "if" "(" Expr ")" ReturnStatement
  PolicyFile = Import* "transition" ident "{" Derivation? Requirement+ "}"
  Import = "use" "extension" ident ";"
  Derivation = "derive" "{" DeriveLet* ReturnStatement "}"
  DeriveLet = Fold | BlockLet
  BlockLet = Append | LetBinding
  Append = "let" ident "=" "bounded.append" "(" Expr "," Expr "," digit+ ")" ";"
  FoldBody = "{" BlockLet* ReturnStatement "}" -- block
           | Expr -- expression
  Requirement = "require" ident "{" Binding? "return" Expr ";" "}"
  Binding = Count | Fold
  Fold = "let" ident "=" "bounded.fold" "(" Expr "," Expr "," "(" ident "," ident ")" "=>" FoldBody "," digit+ ")" ";"
  Count = "let" ident "=" "bounded.count" "(" Expr "," ident "=>" Expr "," digit+ ")" ";"
}`, { FirestoreRules: firestoreGrammar });

type Scope = Record<string, unknown>;
interface CollectionBinding {
  variable: string;
  list: Expression;
  item: string;
  body: Expression;
  limit: number;
}
type Append = { operation: 'append'; variable: string; list: Expression; suffix: Expression; limit: number };
type BlockLet = FunctionDef['lets'][number] | Append;
type FoldBody = { lets: BlockLet[]; expr: Expression };
type Binding = CollectionBinding & (
  | { operation: 'count' }
  | { operation: 'fold'; initial: Expression; accumulator: string; lets: BlockLet[] }
);
interface Requirement {
  name: string;
  location: string;
  source: string;
  condition: Expression;
  binding?: Binding;
}
interface Program {
  name: string;
  imports: string[];
  derivation?: { lets: (BlockLet | Extract<Binding, { operation: 'fold' }>)[]; expr: Expression };
  requirements: Requirement[];
}
const semantics = grammar.extendSemantics(firestoreSemantics);
semantics.extendOperation<Program | NonNullable<Program['derivation']> | Requirement | Binding | Append | FoldBody | string | LoopFunction | FunctionLoop | LoopBody | GuardReturn>('toAST', {
  LoopFunction(imports, exported, _fn, name, _lp, parameters, _rp, _lb, lets, loop, ret, _rb): LoopFunction {
    const extensions = imports.children.map(node => node.toAST());
    if (extensions.length !== 1 || extensions[0] !== 'loops') throw new Error('for...of requires use extension loops;');
    return { name: name.sourceString, exported: Boolean(exported.children.length), parameters: parameters.toAST(),
      lets: lets.children.map(node => node.toAST()), loop: loop.toAST(), body: ret.toAST() };
  },
  LoopImport(_use, _extension, name, _semi) { return name.sourceString; },
  ForOf(_for, _lp, _const, item, _of, collection, _rp, _lb, step, _rb): FunctionLoop {
    return { item: item.sourceString, collection: collection.toAST(), step: step.toAST() };
  },
  LoopBody_guards(guards): LoopBody {
    return { kind: 'guards', guards: guards.children.map(node => node.toAST()) };
  },
  GuardReturn(_if, _lp, condition, _rp, ret): GuardReturn {
    return { condition: condition.toAST(), result: ret.toAST() };
  },
  LoopBody_update(target, _eq, expr, _semi): LoopBody {
    return { kind: 'update', target: target.sourceString, value: expr.toAST() };
  },
  PolicyFile(imports, _kw, name, _lb, derivation, requirements, _rb): Program {
    return { name: name.sourceString, imports: imports.children.map(n => n.toAST()),
      derivation: derivation.children[0]?.toAST(), requirements: requirements.children.map(n => n.toAST()) };
  },
  Import(_use, _extension, name, _semi) { return name.sourceString; },
  Derivation(_kw, _open, lets, ret, _close) {
    return { lets: lets.children.map(n => n.toAST()), expr: ret.toAST() };
  },
  Requirement(kw, name, _lb, binding, _return, expr, _semi, _rb): Requirement {
    const { lineNum, colNum } = kw.source.getLineAndColumn();
    return { name: name.sourceString, location: lineNum + ':' + colNum, source: expr.sourceString, condition: expr.toAST(), binding: binding.children[0]?.toAST() };
  },
  FoldBody_block(_open, lets, ret, _close): FoldBody {
    return { lets: lets.children.map(n => n.toAST()), expr: ret.toAST() };
  },
  FoldBody_expression(expr): FoldBody { return { lets: [], expr: expr.toAST() }; },
  Append(_let, name, _eq, _op, _lp, list, _c1, suffix, _c2, limit, _rp, _semi): Append {
    return { operation: 'append', variable: name.sourceString, list: list.toAST(), suffix: suffix.toAST(), limit: Number(limit.sourceString) };
  },
  Count(_let, name, _eq, _count, _lp, list, _comma, item, _arrow, predicate, _comma2, limit, _rp, _semi): Binding {
    return { operation: 'count', variable: name.sourceString, list: list.toAST(), item: item.sourceString, body: predicate.toAST(), limit: Number(limit.sourceString) };
  },
  Fold(_let, name, _eq, _fold, _lp, list, _c1, initial, _c2, _args, accumulator, _c3, item, _endArgs, _arrow, body, _c4, limit, _rp, _semi): Binding {
    const step: FoldBody = body.toAST();
    return { operation: 'fold', variable: name.sourceString, list: list.toAST(), initial: initial.toAST(),
      accumulator: accumulator.sourceString, item: item.sourceString, body: step.expr, lets: step.lets, limit: Number(limit.sourceString) };
  },
});

function parse(source: string, entry: 'PolicyFile' | 'PureFunction') {
  if (source.length > 8192) throw new Error('Source exceeds 8192 characters');
  const bounded = boundSourceNesting(source);
  if ('offset' in bounded || bounded.elided?.length) throw new Error('Source exceeds parser nesting limit');
  const match = grammar.match(source, entry);
  if (match.failed()) throw new Error(match.message);
  return semantics(match).toAST();
}

function context(expressionLimit = 8192) {
  return { expressionBudget: new ExpressionBudget((_message, loc) => new ExpressionLimitError(`Policy evaluation exceeds ${expressionLimit} expression units`, loc), expressionLimit) };
}

// Closed subset: binding checks happen even on branches that never execute.
function check(expr: Expression, names: Set<string>, read?: (path: string) => void, functionCollections = false): void {
  const visit = (child: Expression) => check(child, names, read, functionCollections);
  const path = field(expr);
  if (path) read?.(path);
  switch (expr.type) {
    case 'literal': return;
    case 'listLiteral': for (const item of expr.elements) visit(item); return;
    case 'mapLiteral': for (const entry of expr.entries) { visit(entry.key); visit(entry.value); } return;
    case 'identifier':
      if (!names.has(expr.name)) throw new Error('Undeclared binding: ' + expr.name);
      return;
    case 'memberAccess':
      // A dotted read names its whole path. A computed receiver can read several roots.
      return check(expr.object, names, path ? undefined : read, functionCollections);
    case 'binaryOp': visit(expr.left); return visit(expr.right);
    case 'unaryOp': return visit(expr.operand);
    case 'inExpr': visit(expr.element); return visit(expr.collection);
    case 'isExpr': return visit(expr.value);
    case 'ternary': visit(expr.condition); visit(expr.consequent); return visit(expr.alternate);
    case 'bracketAccess':
      if (!functionCollections) break;
      visit(expr.object); return visit(expr.index);
    case 'methodCall':
      if (!functionCollections || !isPureValueMethod(expr.method, expr.args.length)) break;
      visit(expr.object);
      for (const arg of expr.args) visit(arg);
      return;
  }
  throw new Error(expr.type + ' is outside the experimental pure expression subset');
}

function declare(names: Set<string>, name: string) {
  if (names.has(name)) throw new Error('Duplicate binding: ' + name);
  names.add(name);
}

export function compileFunction(source: string, { expressionLimit = 8192 } = {}) {
  checkExpressionLimit(expressionLimit);
  const fn: LoopFunction = parse(source, 'PureFunction');
  const names = new Set<string>();
  for (const parameter of fn.parameters) declare(names, parameter);
  for (const binding of fn.lets) {
    check(binding.value, names, undefined, true);
    declare(names, binding.name);
  }
  const loop = fn.loop && checkLoop(fn, fn.loop, names, (expr, scope) => check(expr, scope, undefined, true));
  check(fn.body, names, undefined, true);
  const invoke = (...args: unknown[]) => {
    if (args.length !== fn.parameters.length) throw new Error(fn.name + ' argument count mismatch');
    const scope: Scope = Object.create(null);
    const ctx = { ...context(expressionLimit), readValue: loop?.readValue };
    fn.parameters.forEach((name, i) => { scope[name] = args[i]; });
    for (const binding of fn.lets) scope[binding.name] = evaluateBinding(binding.value, ctx, scope);
    if (loop) return evaluateLoop(fn, loop, ctx, scope);
    return evaluate(fn.body, ctx, scope);
  };
  return Object.assign(invoke, {
    firestoreModule: () => loop ? emitLoopModule(fn, loop, expressionLimit) : emitPureFunctionModule(fn),
    rtdbNumericPredicate(bindings: Record<string, NumericSnapshot>) {
      if (loop) throw new Error('Loops have no RTDB numeric lowering');
      return emitRtdbNumericPredicate(fn, bindings);
    },
  });
}

export interface Transition { before: unknown; after: unknown; input: unknown }
export type Verdict = { ok: true } | { ok: false; requirement: string; location: string; reason: string };

function evaluateCollection(binding: Binding | Append, ctx: ReturnType<typeof context>, scope: Scope): unknown {
  const items = evaluate(binding.list, ctx, scope);
  if (!Array.isArray(items)) throw new EvalError('bounded.' + binding.operation + ' requires a list');
  if (items.length > binding.limit) throw new ResourceLimitError('Collection exceeds declared limit ' + binding.limit);
  if (binding.operation === 'append') {
    const suffix = evaluate(binding.suffix, ctx, scope);
    if (!Array.isArray(suffix)) throw new EvalError('bounded.append requires two lists');
    if (items.length + suffix.length > binding.limit) throw new ResourceLimitError('Append exceeds declared limit ' + binding.limit);
    return [...items, ...suffix];
  }
  if (binding.operation === 'fold') {
    let result = evaluate(binding.initial, ctx, scope);
    for (const item of items) {
      const local: Scope = Object.assign(Object.create(null), scope, { [binding.accumulator]: result, [binding.item]: item });
      for (const declaration of binding.lets) evaluateLet(declaration, ctx, local);
      result = evaluate(binding.body, ctx, local);
    }
    return result;
  }
  let total = 0;
  for (const item of items) {
    const matches = evaluate(binding.body, ctx, { ...scope, [binding.item]: item });
    if (typeof matches !== 'boolean') throw new EvalError('Count predicate must return a boolean');
    if (matches) total++;
  }
  return total;
}

function evaluateLet(binding: BlockLet | Binding, ctx: ReturnType<typeof context>, scope: Scope) {
  if ('value' in binding) scope[binding.name] = evaluateBinding(binding.value, ctx, scope);
  else {
    try { scope[binding.variable] = evaluateCollection(binding, ctx, scope); }
    catch (error) {
      if (!isErrorValue(error)) throw error;
      scope[binding.variable] = error;
    }
  }
}

// Each mapped snapshot must actually contain an integer in this safe arithmetic range.
// Only implement equality of a bound integer to another bound integer plus a literal.
export type SnapshotBindings = Readonly<Record<string, 'data' | 'newData'>>;
function emitIncrement(expr: Expression, bindings: SnapshotBindings): string | undefined {
  const terms: Expression[] = [];
  function split(node: Expression) {
    if (node.type === 'binaryOp' && node.op === '&&') {
      split(node.left);
      split(node.right);
    } else terms.push(node);
  }
  split(expr);
  const relation = terms.pop();
  if (relation?.type !== 'binaryOp' || relation.op !== '==' || relation.right.type !== 'binaryOp' || relation.right.op !== '+') return;
  const { left, right } = relation.right;
  if (right.type !== 'literal' || right.raw !== '1') return;
  // Database numbers are doubles. Only emit the increment when both fields
  // have the exact same finite integer domain in the source policy.
  const guards = new Set<string>();
  for (const term of terms) {
    if (term.type === 'isExpr' && term.typeName === 'int') guards.add(field(term.value) + ':int');
    else if (term.type === 'binaryOp' && term.right.type === 'literal' &&
      ((term.op === '>=' && term.right.raw === '0') ||
       (term.op === '<=' && term.right.raw === '9007199254740991'))) {
      guards.add(field(term.left) + ':' + term.op);
    } else return;
  }
  if (guards.size !== 6 || ![left, relation.left].every(e =>
    ['int', '>=', '<='].every(test => guards.has(field(e) + ':' + test)))) return;
  const lookup = (e: Expression) => {
    const key = field(e);
    return key && Object.hasOwn(bindings, key) ? bindings[key] : undefined;
  };
  const next = lookup(relation.left);
  const previous = lookup(left);
  if (!next || !previous || next === previous) return;
  if (![next, previous].every(value => value === 'newData' || value === 'data')) return;
  const integer = (s: string) => s + '.isNumber() && ' + s + '.val() >= 0 && ' + s + '.val() <= 9007199254740991 && ' + s + '.val() % 1 == 0';
  return '(' + integer(previous) + ' && ' + integer(next) + ' && ' + next + '.val() == ' + previous + '.val() + 1)';
}

function checkExpressionLimit(expressionLimit: number): void {
  if (!Number.isSafeInteger(expressionLimit) || expressionLimit < 1 || expressionLimit > 32768) {
    throw new Error('Policy expression limit must be an integer from 1 to 32768');
  }
}
export function compilePolicy(source: string, { expressionLimit = 8192 } = {}) {
  checkExpressionLimit(expressionLimit);
  const program: Program = parse(source, 'PolicyFile');
  if (program.imports.some(name => name !== 'bounded' && name !== 'derive')) throw new Error('Unknown extension');
  const { derivation } = program;
  function checkCollection(c: Binding | Append, names: Set<string>, read?: (path: string) => void, location = '') {
    if (!program.imports.includes('bounded')) throw new Error(location + 'bounded.' + c.operation + ' requires use extension bounded;');
    if (!Number.isInteger(c.limit) || c.limit < 1 || c.limit > 400) throw new Error('Collection limit must be 1..400');
    check(c.list, names, read);
    if (c.operation === 'append') {
      check(c.suffix, names, read);
      declare(names, c.variable);
      return;
    }
    const nested = new Set(names);
    if (c.operation === 'fold') {
      check(c.initial, names, read);
      declare(nested, c.accumulator);
    }
    declare(nested, c.item);
    if (c.operation === 'fold') {
      for (const binding of c.lets) checkLet(binding, nested, read);
    }
    check(c.body, nested, read);
    declare(names, c.variable);
  }
  function checkLet(binding: BlockLet | Binding, names: Set<string>, read?: (path: string) => void) {
    if ('operation' in binding) checkCollection(binding, names, read);
    else {
      check(binding.value, names, read);
      declare(names, binding.name);
    }
  }
  if (derivation) {
    if (!program.imports.includes('derive')) throw new Error('derive requires use extension derive;');
    const names = new Set(['before', 'input']);
    for (const binding of derivation.lets) checkLet(binding, names);
    if (derivation.expr.type !== 'mapLiteral') throw new Error('derive must return a map literal');
    for (const { key, value } of derivation.expr.entries) { check(key, names); check(value, names); }
  }
  function deriveFrom({ before, input }: Pick<Transition, 'before' | 'input'>, ctx: ReturnType<typeof context>, evaluateResult: typeof evaluateBinding) {
    if (!derivation) throw new Error('This policy has no derive block');
    const scope: Scope = Object.assign(Object.create(null), { before, input });
    for (const binding of derivation.lets) evaluateLet(binding, ctx, scope);
    return evaluateResult(derivation.expr, ctx, scope);
  }
  const seen = new Set<string>();
  const reads = new Map<string, Set<string>>();
  const usesDerived = new Set<string>();
  for (const rule of program.requirements) {
    declare(seen, rule.name);
    const inputs = new Set<string>();
    reads.set(rule.name, inputs);
    const names = new Set(['before', 'after', 'input']);
    if (derivation) names.add('derived');
    const roots = new Set(names);
    const recordRead = (path: string) => {
      const root = path.split('.')[0];
      if (roots.has(root)) inputs.add(path);
      if (derivation && root === 'derived') usesDerived.add(rule.name);
    };
    try {
      if (rule.binding) checkCollection(rule.binding, names, recordRead, rule.location + ': ');
      check(rule.condition, names, recordRead);
    } catch (error) {
      throw new Error(rule.name + ' at ' + rule.location + ': ' + (error instanceof Error ? error.message : error));
    }
  }
  const projected = new Map<string, ReturnType<typeof projectDerivedField>>();
  const locals = derivation && bindDerivedLocals(derivation);
  const collectionFeatures = new Map<string, string[]>();
  if (derivation && locals) {
    for (const rule of program.requirements) {
      if (!usesDerived.has(rule.name)) continue;
      const dependencies = derivedCollectionReads(derivation.expr, reads.get(rule.name)!, locals);
      if (dependencies.length) {
        const features = [...new Set(dependencies.map(name => locals.operations.get(name)!))];
        collectionFeatures.set(rule.name, features);
        projected.set(rule.name, 'Requires ' + features.join(', ') + ': ' + dependencies.join(', '));
      } else if (!rule.binding) {
        projected.set(rule.name, projectDerivedField(rule.condition, derivation.expr, locals.locals));
      }
    }
  }
  const api = {
    derive(start: Pick<Transition, 'before' | 'input'>): Record<string, unknown> {
      return deriveFrom(start, context(expressionLimit), evaluate) as Record<string, unknown>;
    },
    judge(transition: Transition): Verdict {
      const ctx = context(expressionLimit);
      let derived: unknown;
      for (const rule of program.requirements) {
        const scope: Scope = { before: transition.before, after: transition.after, input: transition.input };
        try {
          if (usesDerived.has(rule.name)) {
            derived ??= deriveFrom(transition, ctx, evaluateBinding);
            scope.derived = derived;
          }
          if (rule.binding) scope[rule.binding.variable] = evaluateCollection(rule.binding, ctx, scope);
          const trace = new TraceRecorder();
          if (evaluate(rule.condition, { ...ctx, trace }, scope) === true) continue;
          // Report scalar evidence from the actual evaluation, without re-running policy code.
          const entries = trace.entries;
          // A false comparison inside an absorbed or negated branch may be
          // irrelevant. Only descend through falsifying conjunction operands.
          let index = 0;
          while (entries[index]?.operator === '&&' && entries[index]?.value === false) {
            index = entries.findIndex(entry => entry.parent === index && entry.value === false);
          }
          if (entries[index]?.operator === '==' && entries[index]?.value === false) {
            const operands = entries.filter(entry => entry.parent === index);
            const [actual, expected] = operands;
            if (typeof actual?.value === 'number' && typeof expected?.value === 'number') {
              throw new EvalError(actual.source + ' was ' + actual.value + ', expected ' + expected.value);
            }
          }
          throw new EvalError('Requirement failed: ' + rule.source);
        } catch (error) {
          if (!(error instanceof EvalError)) throw error;
          return { ok: false, requirement: rule.name, location: rule.location, reason: error.message };
        }
      }
      return { ok: true };
    },
    firestore(bindings: FirestoreBindings, mode: 'complete' | 'mixed' = 'complete') {
      const projections = compileProjections(bindings);
      const covered = new Set<string>();
      const rows = program.requirements.map(rule => {
        const extensions = [...new Set([...(rule.binding ? ['bounded.' + rule.binding.operation] : []),
          ...(usesDerived.has(rule.name) ? ['derive'] : []),
          ...(collectionFeatures.get(rule.name) ?? [])])];
        const selection = projected.get(rule.name);
        const expanded = typeof selection === 'object' ? selection.expanded : undefined;
        let result: ReturnType<typeof lowerFirestore>;
        if (expanded || !extensions.length) {
          result = lowerFirestore(expanded ?? rule.condition, projections, Boolean(expanded));
          if (result.predicate && typeof selection === 'object') covered.add(selection.key);
        } else {
          const problems = typeof selection === 'string' ? [selection] : selection
            ? ['Derived expression exceeds projection budget'] : extensions.map(name => 'Requires ' + name);
          result = { inputs: [...reads.get(rule.name)!], features: [], origins: {}, predicate: undefined, problems };
        }
        const reason = result.problems.join('; ') || 'All reads bound at this placement';
        return { requirement: rule.name, location: rule.location, source: rule.source,
          features: ['Rules expressions', ...extensions, ...result.features],
          inputs: result.inputs, origins: result.origins, bindings: Object.fromEntries(result.inputs.filter(key => projections.has(key)).map(key => [key, bindings[key]])),
          target: 'Firestore', enforcement: result.predicate ? 'standalone and database' : 'standalone only',
          reason, predicate: result.predicate };
      });
      // A standalone read of derived materializes the entire returned map. A
      // mixed target can check an individual field, but complete composition
      // must also cover siblings whose evaluation could fail.
      const siblings: string[] = [];
      if (covered.size && derivation?.expr.type === 'mapLiteral') {
        for (const { key, value } of derivation.expr.entries) {
          if (key.type === 'literal' && typeof key.value === 'string' && !covered.has(key.value) && value.type !== 'literal')
            siblings.push(key.value);
        }
      }
      const completeReason = locals?.operations.size
        ? 'Materializing derive requires ' + [...new Set(locals.operations.values())].join(', ') + ': ' + [...locals.operations.keys()].join(', ')
        : siblings.length ? 'Unverified derive outputs: ' + siblings.join(', ') : undefined;
      const report = rows.map(row => ({
        ...row, ...(completeReason && row.predicate && projected.has(row.requirement) ? { completeReason } : {}),
      }));
      const residual = report.filter(row => !row.predicate || row.completeReason);
      if (mode === 'complete' && residual.length) throw new Error(residual.map(row => row.requirement + ' at ' + row.location + ': ' + (row.completeReason ?? row.reason)).join('; '));
      return report;
    },
    rtdb(bindings: SnapshotBindings, mode: 'mixed' | 'complete' = 'mixed') {
      const report = program.requirements.map(rule => {
        const inputs = [...reads.get(rule.name)!];
        const bound = Object.fromEntries(inputs.filter(key => Object.hasOwn(bindings, key)).map(key => [key, bindings[key]]));
        const timing = Object.entries(bound).filter(([key, value]) => {
          const root = key.split('.')[0];
          return (root === 'before' && value !== 'data') || (root === 'after' && value !== 'newData');
        }).map(([key, value]) => key + ' bound to ' + value);
        const missing = inputs.filter(key => !Object.hasOwn(bound, key));
        const predicate = !usesDerived.has(rule.name) && !rule.binding && !timing.length ? emitIncrement(rule.condition, bindings) : undefined;
        const problems: string[] = [];
        if (usesDerived.has(rule.name)) problems.push('Requires derive');
        if (rule.binding) problems.push('Requires decoded collection and bounded.' + rule.binding.operation);
        if (timing.length) problems.push('Wrong snapshot: ' + timing.join(', '));
        if (missing.length) problems.push('Missing binding: ' + missing.join(', '));
        const reason = predicate ? 'Mapped integer snapshots with exact increment'
          : problems.join('; ') || 'No equivalent predicate for this expression and snapshot binding';
        return { requirement: rule.name, inputs, bindings: bound, source: rule.source, countInput: rule.binding?.operation === 'count' ? field(rule.binding.list) : undefined,
          foldInput: rule.binding?.operation === 'fold' ? field(rule.binding.list) : undefined,
          features: ['Rules expressions', ...(rule.binding ? ['bounded.' + rule.binding.operation] : []),
            ...(usesDerived.has(rule.name) ? ['derive'] : [])],
          target: 'RTDB', enforcement: predicate ? 'gateway and database' : 'gateway only',
          reason, predicate };
      });
      const residual = report.filter(row => !row.predicate);
      if (mode === 'complete' && residual.length) throw new Error('Gateway required: ' + residual.map(row => row.requirement).join(', '));
      return report;
    },
  };
  return {
    ...api,
    /** Emit all requirements as one zero-argument 2+modules export named after the transition. */
    firestoreModule: (bindings: FirestoreBindings) => emitFirestoreModule(program.name, api.firestore(bindings, 'complete')),
    bind: {
      firestore: (target: FirestoreTemplate) => composeFirestore(target, [...seen], bindings => api.firestore(bindings, 'mixed')),
      rtdb: (target: RealtimePlacement) => bindRealtime(target, api.rtdb(target.bindings)),
    },
  };
}

export { compileBoundedModule } from './bounded-module.js';

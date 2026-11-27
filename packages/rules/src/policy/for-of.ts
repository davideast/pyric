// Opt-in control flow for pure policy functions. Expression evaluation and its
// CEL error semantics stay with the existing Rules evaluator.
import type { Expression, FunctionDef } from '../grammar/FirestoreAST.js';
import { expressionChildren } from '../grammar/call-depth-limits.js';
import { isNegatedLiteral } from '../grammar/compile-limits.js';
import { hostNumber, invalidNumberLiteralMessage, outOfRangeLiteral } from '../simulator/rules-int.js';
import { reviveCaseLiterals } from '../simulator/firestore-values.js';
import { substituteLets, walkExpr } from '../grammar/function-scopes.js';
import { EXPRESSION_LIMIT } from '../linter/expression-cost.js';
import { EvalError, ResourceLimitError } from '../simulator/eval-error.js';
import type { ExpressionBudget } from '../simulator/expression-budget.js';
import { evaluate, requireBoolean } from '../simulator/evaluator.js';
import { emitPureFunctionModule } from './firestore.js';

export interface GuardReturn {
  condition: Expression;
  result: Expression;
}
export type LoopBody =
  | { kind: 'guards'; guards: GuardReturn[] }
  | { kind: 'update'; target: string; value: Expression };
export interface FunctionLoop {
  item: string;
  collection: Expression;
  step: LoopBody;
}
export interface LoopFunction extends FunctionDef {
  loop?: FunctionLoop;
}
interface CheckedLoop extends FunctionLoop {
  limit: number;
  input: Expression;
  readValue: (expr: Expression, value: unknown) => unknown;
}

// Firestore's SDK sends -0 as a double, even inside maps and lists. Tag
// scalar reads when visited. Only comparisons, set/list operations or an
// explicit return consume a container's nested numeric types. Looking up a
// key or checking a bound must not copy the rest of the input.
function loopValueReader(fn: FunctionDef, input: Expression, step: LoopBody): CheckedLoop['readValue'] {
  const containers = new Set<Expression>([fn.body]);
  const lists = new Set<Expression>();
  const roots = [fn.body, input, ...fn.lets.map(binding => binding.value)];
  if (step.kind === 'guards') {
    for (const {condition, result} of step.guards) {
      roots.push(condition, result);
      containers.add(result);
    }
  } else {
    roots.push(step.value);
  }
  for (const root of roots) walkExpr(root, node => {
    if (node.type === 'binaryOp' && (node.op === '==' || node.op === '!=')) {
      containers.add(node.left);
      containers.add(node.right);
    } else if (node.type === 'inExpr') {
      containers.add(node.element);
      lists.add(node.collection); // Map membership reads keys alone.
    } else if (node.type === 'methodCall' && (node.method === 'toSet' || node.method === 'removeAll')) {
      lists.add(node.object);
      for (const arg of node.args) lists.add(arg);
    }
  });
  return (expr, value) => {
    if (typeof value === 'number') return hostNumber(value);
    if (containers.has(expr) || (lists.has(expr) && Array.isArray(value))) return reviveCaseLiterals(value);
    return value;
  };
}

// A literal that disappears when an empty loop or unused iterator is lowered
// must still satisfy the Rules int64 contract in the original source.
function checkIntegerLiterals(expr: Expression): void {
  const negative = isNegatedLiteral(expr, true);
  const node = negative ? expr.operand : expr;
  if (node.type === 'literal') {
    const invalid = outOfRangeLiteral(node.value, node.raw, negative);
    if (invalid) throw new Error(invalidNumberLiteralMessage(invalid));
    return;
  }
  for (const child of expressionChildren(expr)) checkIntegerLiterals(child);
}

export function checkLoop(fn: FunctionDef, loop: FunctionLoop, names: Set<string>,
  check: (expr: Expression, scope: Set<string>) => void): CheckedLoop {
  let input: Expression, limit: number;
  const collection = loop.collection;
  if (collection.type === 'listLiteral') {
    input = collection;
    limit = collection.elements.length;
    if (limit > 400) throw new Error(fn.name + ': for...of literal exceeds 400 elements');
  } else if (collection.type === 'functionCall' && collection.name === 'bounded' && collection.args.length === 2) {
    const bound = collection.args[1];
    if (bound.type !== 'literal' || typeof bound.value !== 'number' || !/^\d+$/.test(bound.raw) ||
      bound.value < 1 || bound.value > 400) throw new Error(fn.name + ': for...of bound must be a literal integer in 1..400');
    input = collection.args[0];
    limit = bound.value;
  } else {
    throw new Error(fn.name + ': cannot prove for...of bound; use a list literal or bounded(input, limit)');
  }
  for (const local of fn.lets) checkIntegerLiterals(local.value);
  checkIntegerLiterals(fn.body);
  checkIntegerLiterals(input);
  check(input, names);
  if (names.has(loop.item)) throw new Error('Duplicate binding: ' + loop.item);
  const inside = new Set(names).add(loop.item);
  if (loop.step.kind === 'guards') {
    for (const {condition, result} of loop.step.guards) {
      checkIntegerLiterals(condition);
      checkIntegerLiterals(result);
      check(condition, inside);
      check(result, inside);
    }
  } else {
    const { target, value } = loop.step;
    if (!fn.lets.some(local => local.name === target)) {
      throw new Error(fn.name + ': for...of may assign only a declared local accumulator');
    }
    checkIntegerLiterals(value);
    check(value, inside);
  }
  return { ...loop, input, limit, readValue: loopValueReader(fn, input, loop.step) };
}

export function evaluateLoop(fn: FunctionDef, loop: CheckedLoop, ctx: { expressionBudget: ExpressionBudget }, scope: Record<string, unknown>): unknown {
  const items = evaluate(loop.input, ctx, scope);
  if (!Array.isArray(items)) throw new EvalError(fn.name + ': for...of requires a list');
  const length = items.length;
  if (length > loop.limit) throw new ResourceLimitError(fn.name + ': for...of input length ' + length + ' exceeds declared bound ' + loop.limit);
  for (let i = 0; i < length; i++) {
    ctx.expressionBudget.node();
    scope[loop.item] = items[i];
    if (loop.step.kind === 'guards') {
      for (const {condition, result} of loop.step.guards) {
        if (requireBoolean(evaluate(condition, ctx, scope), condition)) return evaluate(result, ctx, scope);
      }
    } else {
      scope[loop.step.target] = evaluate(loop.step.value, ctx, scope);
    }
  }
  return evaluate(fn.body, ctx, scope);
}

// A conservative size/work ceiling before unrolling. This pure subset has no
// lookups or nested calls to user functions. Linked callers have their own cost.
function maxUnits(expr: Expression): number {
  let units = 0;
  walkExpr(expr, node => {
    if (node.type === 'ternary') units += 4;
    else if (node.type === 'isExpr' || (node.type === 'binaryOp' && (node.op === '&&' || node.op === '||'))) units += 2;
    else units++;
  });
  return units;
}

export function emitLoopModule(fn: FunctionDef, loop: CheckedLoop, expressionLimit: number): string {
  if (loop.step.kind === 'update') {
    throw new Error(fn.name + ': standalone only: ordered accumulator over up to ' + loop.limit +
      ' items requires carrying each prior value; no Firestore accumulator lowering');
  }
  if (loop.collection.type !== 'listLiteral') {
    throw new Error(fn.name + ': standalone only: checked input requires type and length enforcement before early return');
  }
  const elements = loop.collection.elements;
  if (!elements.every(item => item.type === 'literal')) {
    throw new Error(fn.name + ': standalone only: computed list elements must all evaluate before iteration');
  }
  const { guards } = loop.step;
  const localUnits = fn.lets.reduce((total, binding) => total + maxUnits(binding.value), 0);
  const fallbackUnits = maxUnits(fn.body);
  let guardUnits = 0, branchUnits = 0, largestReturn = fallbackUnits;
  for (const { condition, result } of guards) {
    const predicate = maxUnits(condition), returned = maxUnits(result);
    guardUnits += predicate;
    branchUnits += 4 + predicate + returned;
    largestReturn = Math.max(largestReturn, returned);
  }
  // A source call materializes its entire collection before visiting a single
  // item. At most one return expression runs, even for the last visited item.
  const returnUnits = elements.length ? largestReturn : fallbackUnits;
  const sourceUnits = localUnits + maxUnits(loop.input) + elements.length * (1 + guardUnits) + returnUnits;
  if (sourceUnits > expressionLimit) {
    throw new Error(fn.name + ': standalone only: cannot prove source expression budget ' + expressionLimit + ' (upper bound ' + sourceUnits + ')');
  }
  // A call of the emitted helper pays for its arguments, let bindings, and
  // nested ternaries. Retain the existing conservative allowance for each
  // guard's result. The containing Firestore request also pays its caller.
  const targetUnits = 1 + fn.parameters.length + fn.lets.length + localUnits +
    branchUnits * elements.length + fallbackUnits;
  if (targetUnits > EXPRESSION_LIMIT) {
    throw new Error(fn.name + ': standalone only: unrolled helper cannot prove its ' + EXPRESSION_LIMIT + '-expression budget (upper bound ' + targetUnits + ')');
  }
  let body = fn.body;
  for (let i = elements.length - 1; i >= 0; i--) {
    const binding = new Map([[loop.item, elements[i]]]);
    // A ternary preserves ordered statement errors. A conjunction or
    // disjunction could absorb an earlier error using a later guard or item.
    for (let j = guards.length - 1; j >= 0; j--) {
      const { condition, result } = guards[j];
      body = { type: 'ternary', condition: substituteLets(condition, binding, true),
        consequent: substituteLets(result, binding, true), alternate: body };
    }
  }
  return emitPureFunctionModule({ ...fn, body });
}

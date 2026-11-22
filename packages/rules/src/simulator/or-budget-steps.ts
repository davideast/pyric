import { assembleExpression } from '../grammar/FirestoreAssembler.js';
import type { AllowRule, Expression, FunctionDef, MatchBlock } from '../grammar/FirestoreAST.js';
import { getValidFunctionLexicalScope } from './match-resolution.js';

export type OrBudgetStep =
  | {
      readonly kind?: 'linear';
      readonly operator: Expression;
      readonly side: 'before' | 'after';
      readonly branch: Expression;
    }
  | {
      readonly kind: 'bind';
      readonly operator: Expression;
      readonly name: string;
      readonly branch: Expression;
      readonly isLet?: boolean;
    }
  | {
      readonly kind: 'fork';
      readonly operator: Expression;
      readonly condition?: Expression;
      readonly branches: readonly Expression[];
    }
  | {
      readonly kind: 'variants';
      readonly branches: readonly Expression[];
    };

export type ListBlockStep =
  | { readonly kind: 'budget'; readonly rule: AllowRule; readonly index: number }
  | { readonly kind: 'grant'; readonly rule: AllowRule; readonly index: number };

const orBudgetStepsMap = new WeakMap<Expression, readonly OrBudgetStep[]>();
const listBlockStepsMap = new WeakMap<MatchBlock, readonly ListBlockStep[]>();
const LOCAL_TOKEN_PATTERN = /__pyric_local_\d+__/g;
const MAX_INLINE_CANONICAL_KEY_LEN = 256;
const MAX_CANONICAL_CACHE_ENTRIES = 50_000;
const localCanonicalKeyMap = new Map<string, string>();
let nextBudgetLocalId = 0;

export function allocateBudgetLocalName(): string {
  nextBudgetLocalId += 1;
  return `__pyric_local_${nextBudgetLocalId}__`;
}

function fnv1aHex(input: string, seed: bigint): string {
  let h = seed;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = BigInt.asUintN(64, h * 0x100000001b3n);
  }
  return h.toString(16).padStart(16, '0');
}

function compactCanonicalKey(raw: string): string {
  if (raw.length <= MAX_INLINE_CANONICAL_KEY_LEN) return raw;
  const h1 = fnv1aHex(raw, 0xcbf29ce484222325n);
  const h2 = fnv1aHex(raw, 0x84222325cbf29ce4n);
  return `#digest:${raw.length}:${h1}${h2}#`;
}

function canonicalKeyForExpr(expr: Expression): string {
  if (expr.type === 'identifier') {
    const mapped = localCanonicalKeyMap.get(expr.name);
    if (mapped !== undefined) return mapped;
  }
  const raw = assembleExpression(expr);
  const expanded = raw.replace(LOCAL_TOKEN_PATTERN, (match) => {
    const mapped = localCanonicalKeyMap.get(match);
    return mapped !== undefined ? `(${mapped})` : match;
  });
  return compactCanonicalKey(expanded);
}

export function recordLocalCanonicalKey(localName: string, boundExpr: Expression): void {
  if (localCanonicalKeyMap.size >= MAX_CANONICAL_CACHE_ENTRIES) {
    localCanonicalKeyMap.clear();
  }
  localCanonicalKeyMap.set(localName, canonicalKeyForExpr(boundExpr));
}

export function budgetTokenForExpr(expr: Expression): string {
  return `__pyric_budget_${encodeURIComponent(canonicalKeyForExpr(expr))}__`;
}

export function attachOrBudgetStep(target: Expression, step: OrBudgetStep): Expression {
  const existing = orBudgetStepsMap.get(target) ?? [];
  const cloned: Expression = { ...target };
  orBudgetStepsMap.set(cloned, [step, ...existing]);
  return cloned;
}

export function getOrBudgetSteps(expr: Expression): readonly OrBudgetStep[] | undefined {
  return orBudgetStepsMap.get(expr);
}

export function getOrBudgetStepExpressions(step: OrBudgetStep): readonly Expression[] {
  if (step.kind === 'fork') {
    return step.condition ? [step.condition, ...step.branches] : step.branches;
  }
  if (step.kind === 'variants') {
    return step.branches;
  }
  return [step.branch];
}

export function mapOrBudgetStepExpressions(
  step: OrBudgetStep,
  mapExpr: (expr: Expression) => Expression,
): OrBudgetStep {
  if (step.kind === 'fork') {
    return {
      ...step,
      ...(step.condition ? { condition: mapExpr(step.condition) } : {}),
      branches: step.branches.map(mapExpr),
    };
  }
  if (step.kind === 'variants') {
    return {
      ...step,
      branches: step.branches.map(mapExpr),
    };
  }
  return {
    ...step,
    branch: mapExpr(step.branch),
  };
}

export function setListBlockSteps(block: MatchBlock, steps: readonly ListBlockStep[]): void {
  listBlockStepsMap.set(block, steps);
}

export function getListBlockSteps(block: MatchBlock): readonly ListBlockStep[] | undefined {
  return listBlockStepsMap.get(block);
}

/** Visit direct child expressions of `expr` (excluding string path segments). */
function forEachChildExpression(
  expr: Expression,
  visit: (child: Expression) => void,
): void {
  switch (expr.type) {
    case 'literal':
    case 'identifier':
      return;
    case 'memberAccess':
      visit(expr.object);
      return;
    case 'bracketAccess':
      visit(expr.object);
      visit(expr.index);
      return;
    case 'sliceAccess':
      visit(expr.object);
      visit(expr.start);
      visit(expr.end);
      return;
    case 'binaryOp':
      visit(expr.left);
      visit(expr.right);
      return;
    case 'unaryOp':
      visit(expr.operand);
      return;
    case 'ternary':
      visit(expr.condition);
      visit(expr.consequent);
      visit(expr.alternate);
      return;
    case 'inExpr':
      visit(expr.element);
      visit(expr.collection);
      return;
    case 'isExpr':
      visit(expr.value);
      return;
    case 'listLiteral':
      for (const el of expr.elements) visit(el);
      return;
    case 'mapLiteral':
      for (const entry of expr.entries) {
        visit(entry.key);
        visit(entry.value);
      }
      return;
    case 'pathLiteral':
      for (const seg of expr.segments) {
        if (typeof seg !== 'string') visit(seg);
      }
      return;
    case 'methodCall':
      visit(expr.object);
      for (const arg of expr.args) visit(arg);
      return;
    case 'functionCall':
      for (const arg of expr.args) visit(arg);
      return;
  }
}

/** True when `expr` is a single literal or identifier with no side effects or budget steps. */
export function isTrivialPureExpr(expr: Expression): boolean {
  if (getOrBudgetSteps(expr)?.length) return false;
  return expr.type === 'literal' || expr.type === 'identifier';
}

/**
 * True when evaluating `expr` is guaranteed to evaluate identifier `name` at
 * least once regardless of runtime operand values (not behind the right arm of
 * `&&`/`||` or the branches of `ternary`).
 */
export function isUnconditionallyEvaluatedInExpr(name: string, expr: Expression): boolean {
  if (expr.type === 'identifier') return expr.name === name;
  if (expr.type === 'literal') return false;
  if (expr.type === 'binaryOp' && (expr.op === '&&' || expr.op === '||')) {
    return isUnconditionallyEvaluatedInExpr(name, expr.left);
  }
  if (expr.type === 'ternary') {
    return isUnconditionallyEvaluatedInExpr(name, expr.condition);
  }
  let found = false;
  forEachChildExpression(expr, (child) => {
    if (!found && isUnconditionallyEvaluatedInExpr(name, child)) {
      found = true;
    }
  });
  return found;
}

export function hasAttachedBudgetSteps(expr: Expression): boolean {
  const seen = new Set<Expression>();
  const walk = (node: Expression): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    if (getOrBudgetSteps(node)?.length) return true;
    let found = false;
    forEachChildExpression(node, (child) => {
      if (!found && walk(child)) found = true;
    });
    return found;
  };
  return walk(expr);
}

export function collectReachableFunctionDefs(
  expr: Expression,
  currentFunctions: ReadonlyMap<string, FunctionDef>,
  out: Set<FunctionDef>,
  visiting: Set<FunctionDef> = new Set(),
): void {
  const steps = getOrBudgetSteps(expr);
  if (steps) {
    for (const step of steps) {
      for (const sub of getOrBudgetStepExpressions(step)) {
        collectReachableFunctionDefs(sub, currentFunctions, out, visiting);
      }
    }
  }
  forEachChildExpression(expr, (child) => {
    collectReachableFunctionDefs(child, currentFunctions, out, visiting);
  });
  if (expr.type === 'functionCall') {
    const fn = currentFunctions.get(expr.name);
    if (!fn) return;
    out.add(fn);
    if (visiting.has(fn)) return;
    visiting.add(fn);
    const nextFunctions = getValidFunctionLexicalScope(fn, currentFunctions) ?? currentFunctions;
    for (const b of fn.lets) {
      collectReachableFunctionDefs(b.value, nextFunctions, out, visiting);
    }
    collectReachableFunctionDefs(fn.body, nextFunctions, out, visiting);
    visiting.delete(fn);
  }
}

export function mentionsAnyIdentifier(expr: Expression, names: ReadonlySet<string>): boolean {
  if (names.size === 0) return false;
  let found = expr.type === 'identifier' && names.has(expr.name);
  if (found) return true;
  const steps = getOrBudgetSteps(expr);
  if (steps) {
    for (const step of steps) {
      for (const sub of getOrBudgetStepExpressions(step)) {
        if (mentionsAnyIdentifier(sub, names)) return true;
      }
    }
  }
  forEachChildExpression(expr, (child) => {
    if (!found && mentionsAnyIdentifier(child, names)) {
      found = true;
    }
  });
  return found;
}

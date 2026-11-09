import type { AllowRule, Expression, MatchBlock } from '../grammar/FirestoreAST.js';

export interface OrBudgetStep {
  readonly operator: Expression;
  readonly side: 'before' | 'after';
  readonly branch: Expression;
}

export type ListBlockStep =
  | { readonly kind: 'budget'; readonly rule: AllowRule; readonly index: number }
  | { readonly kind: 'grant'; readonly rule: AllowRule; readonly index: number };

const orBudgetStepsMap = new WeakMap<Expression, readonly OrBudgetStep[]>();
const listBlockStepsMap = new WeakMap<MatchBlock, readonly ListBlockStep[]>();

export function attachOrBudgetStep(target: Expression, step: OrBudgetStep): Expression {
  const existing = orBudgetStepsMap.get(target) ?? [];
  const cloned: Expression = { ...target };
  orBudgetStepsMap.set(cloned, [step, ...existing]);
  return cloned;
}

export function getOrBudgetSteps(expr: Expression): readonly OrBudgetStep[] | undefined {
  return orBudgetStepsMap.get(expr);
}

export function setListBlockSteps(block: MatchBlock, steps: readonly ListBlockStep[]): void {
  listBlockStepsMap.set(block, steps);
}

export function getListBlockSteps(block: MatchBlock): readonly ListBlockStep[] | undefined {
  return listBlockStepsMap.get(block);
}

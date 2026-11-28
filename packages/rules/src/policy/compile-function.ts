// Standalone pure-function & bounded for...of policy compiler on the unified Policy IR.
import type { Expression, FunctionDef } from '../grammar/FirestoreAST.js';
import { EXPRESSION_LIMIT } from '../linter/expression-cost.js';
import { evaluate, evaluateBinding } from '../simulator/evaluator.js';
import { emitStandaloneModule, type StandaloneModuleResult } from './bounded-module.js';
import { checkPolicyIR, type CheckedPolicyIR } from './check.js';
import {
  classifyPlacementProblems,
  estimateIRExprUnits,
  type BoundedOpCostDetail,
  type ExpressionCostBreakdown,
  type PlacementProblemDetail,
} from './diagnostics.js';
import { createPolicyContext, evalIRExpr, evalIRLet, type Scope } from './eval-ir.js';
import { emitPureFunctionModule } from './firestore.js';
import { emitLoopModule, evaluateLoop } from './for-of.js';
import { isPureRulesExpr, parsePolicyIR, type IRProgram } from './ir.js';
import { emitRtdbNumericPredicate, type NumericSnapshot } from './rtdb-predicate.js';
import { emitRtdbFunctionPredicate, type RtdbBindings } from './rtdb.js';

export interface FunctionPlacementReport {
  name: string;
  target: 'Firestore' | 'standalone';
  firestoreLowerable: boolean;
  reason: string;
  diagnostics: PlacementProblemDetail[];
  cost: ExpressionCostBreakdown;
}

export function compileFunction(source: string, { expressionLimit = 8192 } = {}) {
  const ir: IRProgram = parsePolicyIR(source, 'function');
  const checked: CheckedPolicyIR = checkPolicyIR(ir, { expressionLimit });
  const checkedFn = checked.functions.values().next().value!;
  const { fn, loop } = checkedFn;
  const pureFn: FunctionDef | undefined =
    isPureRulesExpr(fn.body) && fn.lets.every((l) => isPureRulesExpr(l.value))
      ? {
          name: fn.name,
          parameters: fn.parameters,
          exported: fn.exported,
          lets: fn.lets.map((l) => ({ name: l.name, value: l.value as Expression, loc: l.loc })),
          body: fn.body,
          loc: fn.loc,
          returnLoc: fn.returnLoc,
        }
      : undefined;

  const invoke = (...args: unknown[]) => {
    if (args.length !== fn.parameters.length) throw new Error(fn.name + ' argument count mismatch');
    const scope: Scope = Object.create(null);
    const ctx = { ...createPolicyContext(expressionLimit), readValue: loop?.readValue };
    fn.parameters.forEach((name, i) => { scope[name] = args[i]; });
    for (const binding of fn.lets) {
      if (isPureRulesExpr(binding.value)) {
        scope[binding.name] = evaluateBinding(binding.value, ctx, scope);
      } else {
        evalIRLet(binding, ctx, scope);
      }
    }
    if (loop && pureFn) return evaluateLoop(pureFn, loop, ctx, scope);
    if (pureFn) return evaluate(pureFn.body, ctx, scope);
    return evalIRExpr(fn.body, ctx, scope);
  };

  const firestoreModule = () => {
    if (!pureFn) throw new Error(fn.name + ': bounded expressions have no Firestore module lowering');
    return loop ? emitLoopModule(pureFn, loop, expressionLimit) : emitPureFunctionModule(pureFn);
  };

  const placement = (): FunctionPlacementReport => {
    const boundedOps: BoundedOpCostDetail[] = [];
    const letUnits = fn.lets.reduce((s, l) => s + 1 + estimateIRExprUnits(l.value, boundedOps), 0);
    const bodyUnits = estimateIRExprUnits(fn.body, boundedOps);
    const sourceUnits = letUnits + bodyUnits;
    let firestoreLowerable = false;
    let reason = 'Lowerable to Firestore 2+modules function';
    const problems: string[] = [];
    try {
      firestoreModule();
      firestoreLowerable = true;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
      problems.push(reason);
    }
    return {
      name: fn.name,
      target: firestoreLowerable ? 'Firestore' : 'standalone',
      firestoreLowerable,
      reason,
      diagnostics: classifyPlacementProblems(problems, firestoreLowerable, reason),
      cost: {
        sourceUnits,
        sourceLimit: expressionLimit,
        targetUnits: firestoreLowerable ? sourceUnits : null,
        targetLimit: EXPRESSION_LIMIT,
        withinSourceBudget: sourceUnits <= expressionLimit,
        withinTargetBudget: firestoreLowerable ? sourceUnits <= EXPRESSION_LIMIT : null,
        letUnits,
        conditionUnits: bodyUnits,
        boundedOps,
      },
    };
  };

  return Object.assign(invoke, {
    ir: checked,
    standaloneModule: (): StandaloneModuleResult => emitStandaloneModule(checked),
    placement,
    firestoreModule,
    rtdbNumericPredicate(bindings: Record<string, NumericSnapshot>) {
      if (loop) throw new Error('Loops have no RTDB numeric lowering');
      if (!pureFn) throw new Error('Bounded expressions have no RTDB numeric lowering');
      return emitRtdbNumericPredicate(pureFn, bindings);
    },
    rtdbPredicate(bindings: RtdbBindings) {
      if (loop) throw new Error('Loops have no RTDB lowering');
      if (!pureFn) throw new Error('Bounded expressions have no RTDB lowering');
      return emitRtdbFunctionPredicate(pureFn, bindings, 'any');
    },
  });
}

// Experimental opt-in entry. Standard rules loaders never import this grammar.
// Unified on Policy IR (ir.ts) + static checker (check.ts) across compilePolicy,
// compileFunction, compileBoundedModule, provePolicy, and createPolicyGuard.
import { EXPRESSION_LIMIT } from '../linter/expression-cost.js';
import { EvalError, ResourceLimitError } from '../simulator/eval-error.js';
import { TraceRecorder } from '../simulator/trace-recorder.js';
import { emitStandaloneModule, type StandaloneModuleResult } from './bounded-module.js';
import { checkPolicyIR, type CheckedPolicyIR } from './check.js';
import {
  buildFailureTrace,
  buildRequirementCost,
  classifyPlacementProblems,
  makePolicySpan,
  toDiagnosticJsonValue,
  type EvaluatedBindingTrace,
  type PolicyFailureTrace,
  type RequirementCostExtras,
} from './diagnostics.js';
import { createPolicyContext, evalIRExpr, evalIRLet, revivePolicyValue, type Scope } from './eval-ir.js';
import {
  analyzeHelpers,
  buildDeriveExpansionPlan,
  computeDeriveCompleteReason,
  expandRequirementForTarget,
  type RequirementExpansionResult,
} from './expand-ir.js';
import {
  compileProjections,
  emitFirestoreModule,
  lowerFirestore,
  type FirestoreBindings,
} from './firestore.js';
import {
  collectBoundedOps,
  irFieldPath,
  parsePolicyIR,
  type IRBoundedOp,
  type IRProgram,
  type IRRequirement,
} from './ir.js';
import { bindRealtime, composeFirestore, type FirestoreTemplate, type RealtimePlacement } from './placement.js';
import { lowerRtdbExpression, type LowerRtdbResult, type RtdbBindings } from './rtdb.js';
import {
  compileStorageProjections,
  composeStorage,
  emitStorageModule,
  lowerStorage,
  type StorageBindings,
  type StorageLoweringResult,
  type StorageTemplate,
} from './storage.js';
export { compileFunction, type FunctionPlacementReport } from './compile-function.js';

export type Transition = { before: unknown; after: unknown; input: unknown };
export type Verdict =
  | { ok: true }
  | { ok: false; requirement: string; location: string; reason: string; fatal?: true; trace?: PolicyFailureTrace };
export type SnapshotBindings = RtdbBindings;
export type CompiledPolicy = ReturnType<typeof compilePolicy>;

const RTDB_CHAR_LIMIT = 16384;

function requirementBoundedOps(rule: { lets: readonly { value: unknown }[]; condition: unknown }): IRBoundedOp[] {
  const found: IRBoundedOp[] = [];
  for (const l of rule.lets) {
    if ((l.value as { type?: string }).type === 'boundedOp') found.push(l.value as IRBoundedOp);
  }
  return found;
}

function recordBindingTrace(
  out: EvaluatedBindingTrace[],
  name: string,
  scopeKind: 'derive' | 'require',
  val: unknown,
  loc?: { line: number; col: number },
): void {
  const span = loc ? makePolicySpan(loc) : undefined;
  if (val instanceof EvalError) {
    out.push({
      name,
      scope: scopeKind,
      error: val.message,
      ...(val instanceof ResourceLimitError ? { fatal: true as const } : {}),
      ...(span ? { span } : {}),
    });
  } else {
    out.push({
      name,
      scope: scopeKind,
      value: toDiagnosticJsonValue(val),
      ...(span ? { span } : {}),
    });
  }
}

function boundRtdbEntry(bindings: RtdbBindings, key: string): { found: boolean; value: unknown } {
  if (Object.hasOwn(bindings, key)) return { found: true, value: bindings[key] };
  const parts = key.split('.');
  for (let i = parts.length - 1; i >= 1; i--) {
    const prefix = parts.slice(0, i).join('.');
    if (Object.hasOwn(bindings, prefix)) return { found: true, value: bindings[prefix] };
  }
  return { found: false, value: undefined };
}

function boundStorageMap(bindings: StorageBindings, inputs: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of inputs) {
    if (Object.hasOwn(bindings, key)) {
      out[key] = bindings[key]!;
      continue;
    }
    const parts = key.split('.');
    for (let i = parts.length - 1; i >= 1; i--) {
      const prefix = parts.slice(0, i).join('.');
      if (Object.hasOwn(bindings, prefix)) {
        out[key] = bindings[prefix]!;
        break;
      }
    }
  }
  return out;
}

function collectRuleExtensions(
  rule: IRRequirement,
  usesDerived: boolean,
  exp: RequirementExpansionResult,
): string[] {
  const boundedNames = [
    ...rule.lets.flatMap((l) => collectBoundedOps(l.value)),
    ...collectBoundedOps(rule.condition),
  ].map((op) => 'bounded.' + op);
  const helperOpNames = exp.helperBoundedOps.map((o) => o.op);
  return [
    ...new Set([
      ...boundedNames,
      ...helperOpNames,
      ...(usesDerived ? ['derive'] : []),
      ...(exp.inlinedHelpers.length ? ['helpers'] : []),
      ...(exp.inlinedLets > 0 ? ['lets'] : []),
    ]),
  ];
}

function makeCostExtras(
  exp: RequirementExpansionResult,
  predicate: string | undefined,
  enforcement: string,
  problems: readonly string[],
  targetCharLimit?: number,
): RequirementCostExtras {
  const overChar = Boolean(problems.some((p) => p.includes('emission limit')));
  return {
    expandedUnits: exp.budgetExceeded ? exp.expandedUnits : null,
    helperUnits: exp.helperUnits,
    deriveUnits: exp.deriveUnits,
    inlinedHelpers: exp.inlinedHelpers,
    inlinedLets: exp.inlinedLets,
    projectedDerivePaths: exp.projectedDerivePaths,
    expandedNodes: exp.expandedNodes,
    expansionNodeLimit: exp.expansionNodeLimit,
    extraBoundedOps: exp.helperBoundedOps,
    budgetExceeded: exp.budgetExceeded || overChar,
    enforcement,
    problems,
    ...(predicate ? { targetChars: predicate.length } : {}),
    ...(targetCharLimit !== undefined ? { targetCharLimit } : {}),
  };
}

function attachCompleteReason<T extends { requirement: string; predicate?: string; diagnostics: ReturnType<typeof classifyPlacementProblems> }>(
  rows: readonly T[],
  projectedReqs: ReadonlySet<string>,
  completeReason: string | undefined,
): Array<T & { completeReason?: string }> {
  return rows.map((row) => {
    if (completeReason && row.predicate && projectedReqs.has(row.requirement)) {
      return {
        ...row,
        completeReason,
        diagnostics: [...row.diagnostics, ...classifyPlacementProblems([completeReason], false, completeReason)],
      };
    }
    return row;
  });
}

/** Interpret a checked transition policy, optionally filtered to a subset of requirements (e.g. residual). */
export function evaluateCheckedTransition(
  checked: CheckedPolicyIR,
  transition: Transition,
  includeRequirements?: ReadonlySet<string>,
): Verdict {
  const program = checked.program.transition!;
  const { derivation, requirements } = program;
  const { expressionLimit, usesDerived } = checked;
  const ctx = createPolicyContext(expressionLimit, checked.functions);
  const inputState = { nodes: 0 };
  const before = revivePolicyValue(transition.before, inputState);
  const after = revivePolicyValue(transition.after, inputState);
  const input = transition.input === undefined ? Object.create(null) : revivePolicyValue(transition.input, inputState);
  let derived: unknown;
  let hasDerived = false;
  const deriveBindings: EvaluatedBindingTrace[] = [];

  const runDerive = (): unknown => {
    const scope: Scope = Object.assign(Object.create(null), { before, input });
    for (const binding of derivation!.lets) {
      evalIRLet(binding, ctx, scope);
      recordBindingTrace(deriveBindings, binding.name, 'derive', scope[binding.name], binding.loc);
    }
    try {
      return evalIRExpr(derivation!.expr, ctx, scope);
    } catch (error) {
      if (error instanceof EvalError && !(error instanceof ResourceLimitError)) return error;
      throw error;
    }
  };

  for (const rule of requirements) {
    if (includeRequirements && !includeRequirements.has(rule.name)) continue;
    const scope: Scope = { before, after, input };
    const reqBindings: EvaluatedBindingTrace[] = [];
    const trace = new TraceRecorder();
    let outcome: 'false' | 'eval-error' | 'resource-limit' = 'eval-error';
    try {
      if (usesDerived.has(rule.name)) {
        if (!hasDerived) {
          derived = runDerive();
          hasDerived = true;
        }
        scope.derived = derived;
      }
      for (const binding of rule.lets) {
        evalIRLet(binding, ctx, scope);
        recordBindingTrace(reqBindings, binding.name, 'require', scope[binding.name], binding.loc);
      }
      const ok = evalIRExpr(rule.condition, { ...ctx, trace }, scope);
      if (ok === true) continue;
      outcome = 'false';
      const entries = trace.entries;
      let index = 0;
      while (entries[index]?.operator === '&&' && entries[index]?.value === false) {
        index = entries.findIndex((entry) => entry.parent === index && entry.value === false);
      }
      if (entries[index]?.operator === '==' && entries[index]?.value === false) {
        const [actual, expected] = entries.filter((entry) => entry.parent === index);
        const isScalarNum = (v: unknown) => typeof v === 'number' || typeof v === 'bigint';
        if (isScalarNum(actual?.value) && isScalarNum(expected?.value)) {
          throw new EvalError(actual!.source + ' was ' + actual!.value + ', expected ' + expected!.value);
        }
      }
      throw new EvalError('Requirement failed: ' + rule.source);
    } catch (error) {
      if (!(error instanceof EvalError)) throw error;
      const isFatal = error instanceof ResourceLimitError;
      if (isFatal) outcome = 'resource-limit';
      const bindings = usesDerived.has(rule.name) ? [...deriveBindings, ...reqBindings] : reqBindings;
      const failureTrace = buildFailureTrace({
        rule,
        outcome,
        bindings,
        entries: trace.entries,
        derived,
        hasDerived: usesDerived.has(rule.name) && hasDerived,
        expressionUnitsUsed: ctx.expressionBudget.evaluated,
        expressionLimit,
        errorMessage: outcome === 'false' ? undefined : error.message,
      });
      return {
        ok: false,
        requirement: rule.name,
        location: rule.location,
        reason: error.message,
        ...(isFatal ? { fatal: true as const } : {}),
        trace: failureTrace,
      };
    }
  }
  return { ok: true };
}

export function compilePolicy(source: string, { expressionLimit = 8192 } = {}) {
  const ir: IRProgram = parsePolicyIR(source, 'transition');
  const checked: CheckedPolicyIR = checkPolicyIR(ir, { expressionLimit });
  const program = checked.program.transition!;
  const { derivation, requirements } = program;
  const { reads, usesDerived } = checked;

  const helperAnalyses = analyzeHelpers(checked.functions, checked.topoOrder);
  const derivePlan = derivation ? buildDeriveExpansionPlan(derivation, checked.functions, helperAnalyses) : undefined;

  const api = {
    ir: checked,
    standaloneModule: (): StandaloneModuleResult => emitStandaloneModule(checked),
    derive(start: Pick<Transition, 'before' | 'input'>): Record<string, unknown> {
      if (!derivation) throw new Error('This policy has no derive block');
      const ctx = createPolicyContext(expressionLimit, checked.functions);
      const state = { nodes: 0 };
      const scope: Scope = Object.assign(Object.create(null), {
        before: revivePolicyValue(start.before, state),
        input: start.input === undefined ? Object.create(null) : revivePolicyValue(start.input, state),
      });
      for (const binding of derivation.lets) evalIRLet(binding, ctx, scope);
      return evalIRExpr(derivation.expr, ctx, scope) as Record<string, unknown>;
    },
    judge(transition: Transition): Verdict {
      return evaluateCheckedTransition(checked, transition);
    },
    firestore(bindings: FirestoreBindings, mode: 'complete' | 'mixed' = 'complete') {
      const projections = compileProjections(bindings);
      const strictlyCovered = new Set<string>();
      const allProjected = new Set<string>();
      const projectedReqs = new Set<string>();
      const rows = requirements.map((rule) => {
        const usesDer = usesDerived.has(rule.name);
        const exp = expandRequirementForTarget(rule, checked, helperAnalyses, derivePlan, {
          targetUnitLimit: EXPRESSION_LIMIT,
        });
        const extensions = collectRuleExtensions(rule, usesDer, exp);
        let result: ReturnType<typeof lowerFirestore>;
        if (exp.ok && exp.expr) {
          result = lowerFirestore(exp.expr, projections, exp.usesDerivedProjection, exp.expanded);
          if (result.predicate && exp.usesDerivedProjection) {
            projectedReqs.add(rule.name);
            for (const p of exp.projectedDerivePaths) allProjected.add(p);
            for (const p of exp.strictlyCoveredPaths) strictlyCovered.add(p);
          }
        } else {
          result = { inputs: [...reads.get(rule.name)!], features: [], origins: {}, predicate: undefined, problems: [...exp.problems] };
        }
        const enforcement = result.predicate ? 'standalone and database' : 'standalone only';
        const reason = result.problems.join('; ') || 'All reads bound at this placement';
        const cost = buildRequirementCost(
          rule,
          expressionLimit,
          result.predicate ? exp.expr : undefined,
          EXPRESSION_LIMIT,
          makeCostExtras(exp, result.predicate, enforcement, result.problems),
        );
        return {
          requirement: rule.name,
          location: rule.location,
          span: makePolicySpan(rule.loc, rule.location),
          source: rule.source,
          features: ['Rules expressions', ...extensions, ...result.features],
          inputs: result.inputs,
          origins: result.origins,
          bindings: Object.fromEntries(result.inputs.filter((k) => projections.has(k)).map((k) => [k, bindings[k]])),
          target: 'Firestore',
          enforcement,
          reason,
          diagnostics: classifyPlacementProblems(result.problems, Boolean(result.predicate), reason),
          cost,
          predicate: result.predicate,
        };
      });
      const completeReason = computeDeriveCompleteReason(derivePlan, strictlyCovered, allProjected);
      const report = attachCompleteReason(rows, projectedReqs, completeReason);
      const residual = report.filter((row) => !row.predicate || row.completeReason);
      if (mode === 'complete' && residual.length) {
        throw new Error(
          residual.map((row) => row.requirement + ' at ' + row.location + ': ' + (row.completeReason ?? row.reason)).join('; '),
        );
      }
      return report;
    },
    storage(bindings: StorageBindings, mode: 'complete' | 'mixed' = 'complete') {
      const projections = compileStorageProjections(bindings);
      const strictlyCovered = new Set<string>();
      const allProjected = new Set<string>();
      const projectedReqs = new Set<string>();
      const rows = requirements.map((rule) => {
        const usesDer = usesDerived.has(rule.name);
        const exp = expandRequirementForTarget(rule, checked, helperAnalyses, derivePlan, {
          targetUnitLimit: EXPRESSION_LIMIT,
        });
        const extensions = collectRuleExtensions(rule, usesDer, exp);
        let result: StorageLoweringResult;
        if (exp.ok && exp.expr) {
          result = lowerStorage(exp.expr, projections, exp.usesDerivedProjection);
          if (result.predicate && exp.usesDerivedProjection) {
            projectedReqs.add(rule.name);
            for (const p of exp.projectedDerivePaths) allProjected.add(p);
            for (const p of exp.strictlyCoveredPaths) strictlyCovered.add(p);
          }
        } else {
          result = { inputs: [...reads.get(rule.name)!], features: [], origins: {}, predicate: undefined, problems: [...exp.problems] };
        }
        const enforcement = result.predicate ? 'standalone and storage' : 'standalone only';
        const reason = result.problems.join('; ') || 'All reads bound at this Storage placement';
        const cost = buildRequirementCost(
          rule,
          expressionLimit,
          result.predicate ? exp.expr : undefined,
          EXPRESSION_LIMIT,
          makeCostExtras(exp, result.predicate, enforcement, result.problems),
        );
        return {
          requirement: rule.name,
          location: rule.location,
          span: makePolicySpan(rule.loc, rule.location),
          source: rule.source,
          features: ['Rules expressions', ...extensions, ...result.features],
          inputs: result.inputs,
          origins: result.origins,
          bindings: boundStorageMap(bindings, result.inputs),
          target: 'Storage',
          enforcement,
          reason,
          diagnostics: classifyPlacementProblems(result.problems, Boolean(result.predicate), reason),
          cost,
          predicate: result.predicate,
        };
      });
      const completeReason = computeDeriveCompleteReason(derivePlan, strictlyCovered, allProjected);
      const report = attachCompleteReason(rows, projectedReqs, completeReason);
      const residual = report.filter((row) => !row.predicate || row.completeReason);
      if (mode === 'complete' && residual.length) {
        throw new Error(
          residual.map((row) => row.requirement + ' at ' + row.location + ': ' + (row.completeReason ?? row.reason)).join('; '),
        );
      }
      return report;
    },
    rtdb(bindings: RtdbBindings, mode: 'mixed' | 'complete' = 'mixed') {
      const strictlyCovered = new Set<string>();
      const allProjected = new Set<string>();
      const projectedReqs = new Set<string>();
      const rows = requirements.map((rule) => {
        const inputs = [...reads.get(rule.name)!];
        const bOps = requirementBoundedOps(rule);
        const firstOp = bOps[0];
        const usesDer = usesDerived.has(rule.name);
        const exp = expandRequirementForTarget(rule, checked, helperAnalyses, derivePlan, {
          targetUnitLimit: null,
        });
        let lowered: LowerRtdbResult;
        if (exp.ok && exp.expr) {
          const rtdbOpts = {
            defaultLeafType: 'any' as const,
            checkTiming: true,
            trustedInput: exp.usesDerivedProjection,
            maxLength: RTDB_CHAR_LIMIT,
          };
          const rtdbLets = exp.rtdbLets ?? [];
          lowered = lowerRtdbExpression(exp.rtdbCondition ?? exp.expr, bindings, rtdbOpts, rtdbLets);
          // Retry with fully substituted expr when un-inlined lets fail (e.g. root alias `let b = before; b.x` or unused pure let).
          if (!lowered.predicate && rtdbLets.length > 0 && !lowered.problems.some((p) => p.includes('emission limit'))) {
            const flat = lowerRtdbExpression(exp.expr, bindings, rtdbOpts, []);
            if (flat.predicate) lowered = flat;
          }
          if (lowered.predicate && exp.usesDerivedProjection) {
            projectedReqs.add(rule.name);
            for (const p of exp.projectedDerivePaths) allProjected.add(p);
            for (const p of exp.strictlyCoveredPaths) strictlyCovered.add(p);
          }
        } else {
          const problems = firstOp
            ? ['Requires decoded collection and bounded.' + firstOp.op, ...exp.problems.filter((p) => p !== 'Requires bounded.' + firstOp.op)]
            : [...exp.problems];
          lowered = { inputs, features: [], problems, predicate: undefined };
        }
        const bound = Object.fromEntries(
          (lowered.predicate ? lowered.inputs : inputs).flatMap((key) => {
            const hit = boundRtdbEntry(bindings, key);
            return hit.found ? [[key, hit.value]] : [];
          }),
        );
        const enforcement = lowered.predicate ? 'gateway and database' : 'gateway only';
        const reason = lowered.predicate
          ? 'Mapped RTDB snapshot expression'
          : lowered.problems.join('; ') || 'No equivalent predicate for this expression and snapshot binding';
        const effectiveProblems = lowered.predicate ? [] : lowered.problems.length ? lowered.problems : [reason];
        const cost = buildRequirementCost(
          rule,
          expressionLimit,
          lowered.predicate ? exp.expr : undefined,
          null,
          makeCostExtras(exp, lowered.predicate, enforcement, effectiveProblems, RTDB_CHAR_LIMIT),
        );
        const extensions = collectRuleExtensions(rule, usesDer, exp);
        return {
          requirement: rule.name,
          span: makePolicySpan(rule.loc, rule.location),
          inputs: lowered.inputs.length ? lowered.inputs : inputs,
          bindings: bound,
          source: rule.source,
          countInput: firstOp?.op === 'count' ? irFieldPath(firstOp.list) : undefined,
          foldInput: firstOp?.op === 'fold' ? irFieldPath(firstOp.list) : undefined,
          features: ['Rules expressions', ...extensions, ...lowered.features],
          target: 'RTDB',
          enforcement,
          reason,
          diagnostics: classifyPlacementProblems(effectiveProblems, Boolean(lowered.predicate), reason),
          cost,
          predicate: lowered.predicate,
        };
      });
      const completeReason = computeDeriveCompleteReason(derivePlan, strictlyCovered, allProjected);
      const report = attachCompleteReason(rows, projectedReqs, completeReason);
      const residual = report.filter((row) => !row.predicate || row.completeReason);
      if (mode === 'complete' && residual.length) {
        throw new Error('Gateway required: ' + residual.map((row) => row.requirement).join(', '));
      }
      return report;
    },
  };

  return {
    ...api,
    /** Emit all requirements as one zero-argument 2+modules export named after the transition. */
    firestoreModule: (bindings: FirestoreBindings) => emitFirestoreModule(program.name, api.firestore(bindings, 'complete')),
    /** Emit all requirements as one zero-argument Storage 2+modules export named after the transition. */
    storageModule: (bindings: StorageBindings) => emitStorageModule(program.name, api.storage(bindings, 'complete')),
    bind: {
      firestore: (target: FirestoreTemplate) => composeFirestore(target, [...checked.requirementNames], (bindings) => api.firestore(bindings, 'mixed')),
      storage: (target: StorageTemplate) => composeStorage(target, [...checked.requirementNames], (bindings) => api.storage(bindings, 'mixed')),
      rtdb: (target: RealtimePlacement) => bindRealtime(target, api.rtdb(target.bindings)),
    },
  };
}

export {
  lowerRtdbExpression, emitRtdbFunctionPredicate, hasRequiredConjunct,
  type RtdbBinding, type RtdbBindings, type RtdbSnapshotBinding, type LowerRtdbOptions, type LowerRtdbResult,
} from './rtdb.js';
export {
  compileStorageProjections, lowerStorage, emitStorageModule, composeStorage,
  type StorageBindings, type StoragePlacement, type StorageTemplate, type StorageLoweringResult,
} from './storage.js';
export { compileBoundedModule, emitStandaloneModule, type StandaloneModuleResult } from './bounded-module.js';
export { checkPolicyIR, checkExpressionLimit, type CheckedPolicyIR, type CheckedFunction, type CheckOptions } from './check.js';
export {
  toDiagnosticJsonValue,
  type BoundedOpCostDetail, type EvaluatedBindingTrace, type ExpressionCostBreakdown,
  type PlacementProblemDetail, type PlacementReasonCode, type PolicyFailureTrace,
  type PolicySpan, type RequirementCostExtras, type SubExpressionOperandTrace, type SubExpressionTrace,
} from './diagnostics.js';
export { interpretModule } from './eval-ir.js';
export {
  createPolicyGuard, jsonBodyExtractor, PolicyDeniedError, PolicyPayloadTooLargeError,
  type DeniedVerdict, type HttpLikeRequest, type HttpLikeResponse, type PolicyGuard,
  type PolicyGuardOptions, type PolicyGuardPlacement, type PolicyGuardTargetPlacement,
  type RequestTransitionExtractor, type VerifiedTransition,
} from './guard.js';
export {
  parsePolicyIR, irChildren, walkIR, isPureRulesExpr, asPureRulesExpr, irFieldPath, collectBoundedOps,
  type PolicyExtension, type PolicyProgramKind, type BoundedOpKind, type BoundedUnaryOpKind,
  type IRBoundedOp, type IRBoundedUnaryOp, type IRBoundedFoldOp, type IRBoundedAppendOp,
  type IRExpr, type IRLetBinding, type IRGuardReturn, type IRLoopBody, type IRLoop,
  type IRFunction, type IRDerivation, type IRRequirement, type IRTransition, type IRProgram,
} from './ir.js';
export {
  detectPolicyKind, instantiateStandaloneModule, provePolicy, verifySplitEnforcement,
  type PolicyPlacementRow, type PolicyProofReport, type ProveDivergence, type ProvePolicyFuzzOptions,
  type ProvePolicyOptions, type ProvePolicyScenario, type ProveScenarioResult,
  type VerifySplitOptions, type VerifySplitReport,
} from './prove.js';
export {
  type PolicyTargetName, type SplitCaseOutcome, type SplitDivergence, type SplitEnforcementMode,
  type SplitNormalizedVerdict, type SplitPathCounts, type SplitTargetPlan, type SplitTargetProofSummary,
} from './split-proof.js';
export { type StorageSimMethod } from './target-evaluators.js';

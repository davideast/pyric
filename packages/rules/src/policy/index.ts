// Experimental opt-in entry. Standard rules loaders never import this grammar.
// Unified on Policy IR (ir.ts) + static checker (check.ts) across compilePolicy,
// compileFunction, and compileBoundedModule.
import type { Expression, FunctionDef } from '../grammar/FirestoreAST.js';
import { EvalError, ResourceLimitError } from '../simulator/eval-error.js';
import { evaluate, evaluateBinding } from '../simulator/evaluator.js';
import { TraceRecorder } from '../simulator/trace-recorder.js';
import { compileBoundedModule, emitStandaloneModule, type StandaloneModuleResult } from './bounded-module.js';
import { checkPolicyIR, type CheckedPolicyIR } from './check.js';
import { bindDerivedLocals, derivedCollectionReads, projectDerivedField } from './derived-field.js';
import { createPolicyContext, evalIRExpr, evalIRLet, interpretModule, revivePolicyValue, type Scope } from './eval-ir.js';
import {
  compileProjections,
  emitFirestoreModule,
  emitPureFunctionModule,
  lowerFirestore,
  type FirestoreBindings,
} from './firestore.js';
import { emitLoopModule, evaluateLoop } from './for-of.js';
import {
  asPureRulesExpr,
  collectBoundedOps,
  irFieldPath,
  isPureRulesExpr,
  parsePolicyIR,
  type IRBoundedOp,
  type IRProgram,
} from './ir.js';
import { bindRealtime, composeFirestore, type FirestoreTemplate, type RealtimePlacement } from './placement.js';
import { emitRtdbNumericPredicate, type NumericSnapshot } from './rtdb-predicate.js';
import {
  emitRtdbFunctionPredicate,
  hasRequiredConjunct,
  lowerRtdbExpression,
  type LowerRtdbOptions,
  type LowerRtdbResult,
  type RtdbBinding,
  type RtdbBindings,
  type RtdbSnapshotBinding,
} from './rtdb.js';
import {
  compileStorageProjections,
  composeStorage,
  emitStorageModule,
  lowerStorage,
  type StorageBindings,
  type StorageLoweringResult,
  type StoragePlacement,
  type StorageTemplate,
} from './storage.js';

export type Transition = { before: unknown; after: unknown; input: unknown };
export type Verdict =
  | { ok: true }
  | { ok: false; requirement: string; location: string; reason: string; fatal?: true };
export type SnapshotBindings = RtdbBindings;

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

  return Object.assign(invoke, {
    ir: checked,
    standaloneModule: (): StandaloneModuleResult => emitStandaloneModule(checked),
    firestoreModule: () => {
      if (!pureFn) throw new Error(fn.name + ': bounded expressions have no Firestore module lowering');
      return loop ? emitLoopModule(pureFn, loop, expressionLimit) : emitPureFunctionModule(pureFn);
    },
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

function requirementBoundedOps(rule: { lets: readonly { value: unknown }[]; condition: unknown }): IRBoundedOp[] {
  const found: IRBoundedOp[] = [];
  for (const l of rule.lets) {
    if ((l.value as { type?: string }).type === 'boundedOp') found.push(l.value as IRBoundedOp);
  }
  return found;
}

export function compilePolicy(source: string, { expressionLimit = 8192 } = {}) {
  const ir: IRProgram = parsePolicyIR(source, 'transition');
  const checked: CheckedPolicyIR = checkPolicyIR(ir, { expressionLimit });
  const program = checked.program.transition!;
  const { derivation, requirements } = program;
  const { reads, usesDerived } = checked;

  const hasFunctions = checked.functions.size > 0;
  function deriveFrom(
    { before, input }: Pick<Transition, 'before' | 'input'>,
    ctx: ReturnType<typeof createPolicyContext>,
    captureErrors: boolean,
    preSanitized = false,
  ): unknown {
    if (!derivation) throw new Error('This policy has no derive block');
    const state = { nodes: 0 };
    const scope: Scope = Object.assign(Object.create(null), {
      before: preSanitized ? before : revivePolicyValue(before, state),
      input: preSanitized ? input : input === undefined ? Object.create(null) : revivePolicyValue(input, state),
    });
    for (const binding of derivation.lets) evalIRLet(binding, ctx, scope);
    try {
      return evalIRExpr(derivation.expr, ctx, scope);
    } catch (error) {
      if (captureErrors && error instanceof EvalError && !(error instanceof ResourceLimitError)) return error;
      throw error;
    }
  }

  const projected = new Map<string, ReturnType<typeof projectDerivedField>>();
  const locals = derivation && bindDerivedLocals(derivation);
  const collectionFeatures = new Map<string, string[]>();
  const pureDerivationExpr = derivation && isPureRulesExpr(derivation.expr) ? derivation.expr : undefined;
  if (derivation && locals && pureDerivationExpr) {
    for (const rule of requirements) {
      if (!usesDerived.has(rule.name)) continue;
      const dependencies = derivedCollectionReads(pureDerivationExpr, reads.get(rule.name)!, locals);
      if (dependencies.length) {
        const features = [...new Set(dependencies.map((name) => locals.operations.get(name)!))];
        collectionFeatures.set(rule.name, features);
        projected.set(rule.name, 'Requires ' + features.join(', ') + ': ' + dependencies.join(', '));
      } else if (!rule.lets.length && isPureRulesExpr(rule.condition)) {
        projected.set(rule.name, projectDerivedField(rule.condition, pureDerivationExpr, locals.locals));
      }
    }
  }

  const api = {
    ir: checked,
    standaloneModule: (): StandaloneModuleResult => emitStandaloneModule(checked),
    derive(start: Pick<Transition, 'before' | 'input'>): Record<string, unknown> {
      return deriveFrom(start, createPolicyContext(expressionLimit, checked.functions), false) as Record<string, unknown>;
    },
    judge(transition: Transition): Verdict {
      const ctx = createPolicyContext(expressionLimit, checked.functions);
      const inputState = { nodes: 0 };
      const before = revivePolicyValue(transition.before, inputState);
      const after = revivePolicyValue(transition.after, inputState);
      const input = transition.input === undefined ? Object.create(null) : revivePolicyValue(transition.input, inputState);
      let derived: unknown;
      for (const rule of requirements) {
        const scope: Scope = { before, after, input };
        try {
          if (usesDerived.has(rule.name)) {
            derived ??= deriveFrom({ before, input }, ctx, true, true);
            scope.derived = derived;
          }
          for (const binding of rule.lets) evalIRLet(binding, ctx, scope);
          const trace = new TraceRecorder();
          const evalCtx = { ...ctx, trace };
          const ok = evalIRExpr(rule.condition, evalCtx, scope);
          if (ok === true) continue;
          // Report scalar evidence from the actual evaluation, without re-running policy code.
          const entries = trace.entries;
          let index = 0;
          while (entries[index]?.operator === '&&' && entries[index]?.value === false) {
            index = entries.findIndex((entry) => entry.parent === index && entry.value === false);
          }
          if (entries[index]?.operator === '==' && entries[index]?.value === false) {
            const operands = entries.filter((entry) => entry.parent === index);
            const [actual, expected] = operands;
            const isScalarNum = (v: unknown) => typeof v === 'number' || typeof v === 'bigint';
            if (isScalarNum(actual?.value) && isScalarNum(expected?.value)) {
              throw new EvalError(actual!.source + ' was ' + actual!.value + ', expected ' + expected!.value);
            }
          }
          throw new EvalError('Requirement failed: ' + rule.source);
        } catch (error) {
          if (!(error instanceof EvalError)) throw error;
          return {
            ok: false,
            requirement: rule.name,
            location: rule.location,
            reason: error.message,
            ...(error instanceof ResourceLimitError ? { fatal: true as const } : {}),
          };
        }
      }
      return { ok: true };
    },
    firestore(bindings: FirestoreBindings, mode: 'complete' | 'mixed' = 'complete') {
      const projections = compileProjections(bindings);
      const covered = new Set<string>();
      const rows = requirements.map((rule) => {
        const boundedNames = [
          ...rule.lets.flatMap((l) => collectBoundedOps(l.value)),
          ...collectBoundedOps(rule.condition),
        ].map((op) => 'bounded.' + op);
        const extensions = [
          ...new Set([
            ...boundedNames,
            ...(usesDerived.has(rule.name) ? ['derive'] : []),
            ...(collectionFeatures.get(rule.name) ?? []),
          ]),
        ];
        const selection = projected.get(rule.name);
        const expanded = typeof selection === 'object' ? selection.expanded : undefined;
        let result: ReturnType<typeof lowerFirestore>;
        if (!hasFunctions && !rule.lets.length && isPureRulesExpr(rule.condition) && (expanded || !extensions.length)) {
          result = lowerFirestore(expanded ?? asPureRulesExpr(rule.condition), projections, Boolean(expanded));
          if (result.predicate && typeof selection === 'object') covered.add(selection.key);
        } else {
          const problems =
            typeof selection === 'string'
              ? [selection]
              : selection
                ? ['Derived expression exceeds projection budget']
                : hasFunctions
                  ? ['Requires helper functions']
                  : rule.lets.length && !extensions.length
                    ? ['Requires local bindings']
                    : extensions.map((name) => 'Requires ' + name);
          result = { inputs: [...reads.get(rule.name)!], features: [], origins: {}, predicate: undefined, problems };
        }
        const reason = result.problems.join('; ') || 'All reads bound at this placement';
        return {
          requirement: rule.name,
          location: rule.location,
          source: rule.source,
          features: ['Rules expressions', ...extensions, ...result.features],
          inputs: result.inputs,
          origins: result.origins,
          bindings: Object.fromEntries(result.inputs.filter((key) => projections.has(key)).map((key) => [key, bindings[key]])),
          target: 'Firestore',
          enforcement: result.predicate ? 'standalone and database' : 'standalone only',
          reason,
          predicate: result.predicate,
        };
      });
      const siblings: string[] = [];
      if (covered.size && pureDerivationExpr?.type === 'mapLiteral') {
        for (const { key, value } of pureDerivationExpr.entries) {
          if (key.type === 'literal' && typeof key.value === 'string' && !covered.has(key.value) && value.type !== 'literal') {
            siblings.push(key.value);
          }
        }
      }
      const completeReason = locals?.operations.size
        ? 'Materializing derive requires ' +
          [...new Set(locals.operations.values())].join(', ') +
          ': ' +
          [...locals.operations.keys()].join(', ')
        : siblings.length
          ? 'Unverified derive outputs: ' + siblings.join(', ')
          : undefined;
      const report = rows.map((row) => ({
        ...row,
        ...(completeReason && row.predicate && projected.has(row.requirement) ? { completeReason } : {}),
      }));
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
      const covered = new Set<string>();
      const rows = requirements.map((rule) => {
        const boundedNames = [
          ...rule.lets.flatMap((l) => collectBoundedOps(l.value)),
          ...collectBoundedOps(rule.condition),
        ].map((op) => 'bounded.' + op);
        const extensions = [
          ...new Set([
            ...boundedNames,
            ...(usesDerived.has(rule.name) ? ['derive'] : []),
            ...(collectionFeatures.get(rule.name) ?? []),
          ]),
        ];
        const selection = projected.get(rule.name);
        const expanded = typeof selection === 'object' ? selection.expanded : undefined;
        let result: StorageLoweringResult;
        if (!hasFunctions && !rule.lets.length && isPureRulesExpr(rule.condition) && (expanded || !extensions.length)) {
          result = lowerStorage(expanded ?? asPureRulesExpr(rule.condition), projections, Boolean(expanded));
          if (result.predicate && typeof selection === 'object') covered.add(selection.key);
        } else {
          const problems =
            typeof selection === 'string'
              ? [selection]
              : selection
                ? ['Derived expression exceeds projection budget']
                : hasFunctions
                  ? ['Requires helper functions']
                  : rule.lets.length && !extensions.length
                    ? ['Requires local bindings']
                    : extensions.map((name) => 'Requires ' + name);
          result = { inputs: [...reads.get(rule.name)!], features: [], origins: {}, predicate: undefined, problems };
        }
        const reason = result.problems.join('; ') || 'All reads bound at this Storage placement';
        return {
          requirement: rule.name,
          location: rule.location,
          source: rule.source,
          features: ['Rules expressions', ...extensions, ...result.features],
          inputs: result.inputs,
          origins: result.origins,
          bindings: Object.fromEntries(result.inputs.filter((key) => projections.has(key)).map((key) => [key, bindings[key]])),
          target: 'Storage',
          enforcement: result.predicate ? 'standalone and storage' : 'standalone only',
          reason,
          predicate: result.predicate,
        };
      });
      const siblings: string[] = [];
      if (covered.size && pureDerivationExpr?.type === 'mapLiteral') {
        for (const { key, value } of pureDerivationExpr.entries) {
          if (key.type === 'literal' && typeof key.value === 'string' && !covered.has(key.value) && value.type !== 'literal') {
            siblings.push(key.value);
          }
        }
      }
      const completeReason = locals?.operations.size
        ? 'Materializing derive requires ' + [...new Set(locals.operations.values())].join(', ') + ': ' + [...locals.operations.keys()].join(', ')
        : siblings.length
          ? 'Unverified derive outputs: ' + siblings.join(', ')
          : undefined;
      const report = rows.map((row) => ({
        ...row,
        ...(completeReason && row.predicate && projected.has(row.requirement) ? { completeReason } : {}),
      }));
      const residual = report.filter((row) => !row.predicate || row.completeReason);
      if (mode === 'complete' && residual.length) {
        throw new Error(
          residual.map((row) => row.requirement + ' at ' + row.location + ': ' + (row.completeReason ?? row.reason)).join('; '),
        );
      }
      return report;
    },
    rtdb(bindings: RtdbBindings, mode: 'mixed' | 'complete' = 'mixed') {
      const report = requirements.map((rule) => {
        const inputs = [...reads.get(rule.name)!];
        const bOps = requirementBoundedOps(rule);
        const firstOp = bOps[0];
        const pureLets = rule.lets.every((l) => isPureRulesExpr(l.value))
          ? rule.lets.map((l) => ({ name: l.name, value: asPureRulesExpr(l.value) }))
          : undefined;
        const selection = projected.get(rule.name);
        const expanded = typeof selection === 'object' ? selection.expanded : undefined;
        let lowered: LowerRtdbResult;
        if (
          !hasFunctions &&
          !bOps.length &&
          pureLets &&
          isPureRulesExpr(rule.condition) &&
          (!usesDerived.has(rule.name) || Boolean(expanded))
        ) {
          lowered = lowerRtdbExpression(
            expanded ?? asPureRulesExpr(rule.condition),
            bindings,
            { defaultLeafType: 'any', checkTiming: true },
            expanded ? [] : pureLets,
          );
        } else {
          const problems: string[] = [];
          if (hasFunctions) problems.push('Requires helper functions');
          if (usesDerived.has(rule.name)) problems.push(typeof selection === 'string' ? selection : 'Requires derive');
          if (firstOp) problems.push('Requires decoded collection and bounded.' + firstOp.op);
          lowered = { inputs, features: [], problems, predicate: undefined };
        }
        const bound = Object.fromEntries(
          inputs
            .filter((key) => {
              if (Object.hasOwn(bindings, key)) return true;
              const parts = key.split('.');
              for (let i = parts.length - 1; i >= 1; i--) {
                if (Object.hasOwn(bindings, parts.slice(0, i).join('.'))) return true;
              }
              return false;
            })
            .map((key) => {
              if (Object.hasOwn(bindings, key)) return [key, bindings[key]];
              const parts = key.split('.');
              for (let i = parts.length - 1; i >= 1; i--) {
                const prefix = parts.slice(0, i).join('.');
                if (Object.hasOwn(bindings, prefix)) return [key, bindings[prefix]];
              }
              return [key, undefined];
            }),
        );
        const reason = lowered.predicate
          ? 'Mapped RTDB snapshot expression'
          : lowered.problems.join('; ') || 'No equivalent predicate for this expression and snapshot binding';
        return {
          requirement: rule.name,
          inputs,
          bindings: bound,
          source: rule.source,
          countInput: firstOp?.op === 'count' ? irFieldPath(firstOp.list) : undefined,
          foldInput: firstOp?.op === 'fold' ? irFieldPath(firstOp.list) : undefined,
          features: [
            'Rules expressions',
            ...bOps.map((o) => 'bounded.' + o.op),
            ...(usesDerived.has(rule.name) ? ['derive'] : []),
            ...lowered.features,
          ],
          target: 'RTDB',
          enforcement: lowered.predicate ? 'gateway and database' : 'gateway only',
          reason,
          predicate: lowered.predicate,
        };
      });
      const residual = report.filter((row) => !row.predicate);
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
  lowerRtdbExpression,
  emitRtdbFunctionPredicate,
  hasRequiredConjunct,
  type RtdbBinding,
  type RtdbBindings,
  type RtdbSnapshotBinding,
  type LowerRtdbOptions,
  type LowerRtdbResult,
} from './rtdb.js';
export {
  compileStorageProjections,
  lowerStorage,
  emitStorageModule,
  composeStorage,
  type StorageBindings,
  type StoragePlacement,
  type StorageTemplate,
  type StorageLoweringResult,
} from './storage.js';

export { compileBoundedModule, emitStandaloneModule, type StandaloneModuleResult } from './bounded-module.js';
export { checkPolicyIR, checkExpressionLimit, type CheckedPolicyIR, type CheckedFunction, type CheckOptions } from './check.js';
export { interpretModule } from './eval-ir.js';
export {
  parsePolicyIR,
  irChildren,
  walkIR,
  isPureRulesExpr,
  asPureRulesExpr,
  irFieldPath,
  collectBoundedOps,
  type PolicyExtension,
  type PolicyProgramKind,
  type BoundedOpKind,
  type BoundedUnaryOpKind,
  type IRBoundedOp,
  type IRBoundedUnaryOp,
  type IRBoundedFoldOp,
  type IRBoundedAppendOp,
  type IRExpr,
  type IRLetBinding,
  type IRGuardReturn,
  type IRLoopBody,
  type IRLoop,
  type IRFunction,
  type IRDerivation,
  type IRRequirement,
  type IRTransition,
  type IRProgram,
} from './ir.js';

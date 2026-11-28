// Explicit split-enforcement composition verification:
// proves `databasePredicate && gatewayResidual === fullStandalone` across
// Firestore, RTDB, and Storage on allow, deny, recoverable error, and fatal budget paths.
// Strictly isomorphic (zero Node-only imports) and 100% JSON-serializable outputs.
import { emitStandaloneModule, type StandaloneModuleResult } from './bounded-module.js';
import type { CheckedPolicyIR } from './check.js';
import { toDiagnosticJsonValue } from './diagnostics.js';
import type { FirestoreBindings } from './firestore.js';
import type { Transition, Verdict } from './index.js';
import type { RtdbBindings } from './rtdb.js';
import type { StorageBindings } from './storage.js';
import {
  createFirestorePredicateEvaluator,
  createRtdbEvaluator,
  createStorageEvaluator,
  inferStorageMethod,
  type StorageSimMethod,
  type TargetDecision,
} from './target-evaluators.js';

export type PolicyTargetName = 'firestore' | 'rtdb' | 'storage';
export type SplitEnforcementMode = 'complete' | 'split' | 'gateway-only';

export interface SplitRequirementRow {
  readonly requirement: string;
  readonly predicate?: string;
  readonly completeReason?: string;
}

export interface SplitTargetPlan {
  readonly target: PolicyTargetName;
  readonly mode: SplitEnforcementMode;
  readonly databaseRequirements: string[];
  readonly residualRequirements: string[];
  readonly databasePredicate?: string;
  readonly residualExports: string[];
  readonly residualModuleBytes: number;
  readonly storageMethod?: StorageSimMethod;
}

export interface SplitNormalizedVerdict {
  readonly kind: 'verdict' | 'eval-error' | 'resource-limit' | 'explicit-fail';
  readonly ok?: boolean;
  readonly requirement?: string;
  readonly outcome?: 'allow' | 'false' | 'eval-error' | 'resource-limit';
  readonly fatal: boolean;
  readonly message?: string;
}

export interface SplitCaseOutcome {
  readonly target: PolicyTargetName;
  readonly parityOk: boolean;
  readonly dbDecision: 'ALLOW' | 'DENY' | 'SKIPPED' | 'UNSUPPORTED';
  readonly residual: SplitNormalizedVerdict;
  readonly composed: {
    readonly decision: 'ALLOW' | 'DENY' | 'UNSUPPORTED';
    readonly fatal: boolean;
  };
  readonly fullStandalone: SplitNormalizedVerdict;
  readonly dbDeniedBeforeResidualFatal?: boolean;
  readonly mismatch?: string;
}

export interface SplitDivergence {
  readonly source: 'scenario' | 'fuzz';
  readonly nameOrIndex: string | number;
  readonly input: unknown;
  readonly outcome: SplitCaseOutcome;
}

export interface SplitPathCounts {
  allow: number;
  deny: number;
  recoverableError: number;
  fatalBudget: number;
}

export interface SplitTargetProofSummary {
  readonly target: PolicyTargetName;
  readonly ok: boolean;
  readonly plan: SplitTargetPlan;
  readonly checked: number;
  readonly passed: number;
  readonly skippedUnsupported: number;
  readonly pathCounts: SplitPathCounts;
  readonly fatalOrderDifferences: number;
  readonly divergences: SplitDivergence[];
}

export type StandaloneInvoker = (moduleSource: string) => Record<string, (...args: unknown[]) => unknown>;

export interface SplitTargetHarness {
  readonly target: PolicyTargetName;
  readonly plan: SplitTargetPlan;
  readonly residualModule: StandaloneModuleResult;
  readonly residualRequirementSet: ReadonlySet<string>;
  evaluate(transition: Transition, fullStandalone: SplitNormalizedVerdict): SplitCaseOutcome;
  evaluateDb(transition: Transition): TargetDecision | undefined;
  judgeResidual(transition: Transition): Verdict;
}

/** Build a filtered CheckedPolicyIR keeping only the residual requirements for gateway enforcement. */
export function buildResidualCheckedIR(
  checked: CheckedPolicyIR,
  residualNames: ReadonlySet<string>,
): CheckedPolicyIR {
  const transition = checked.program.transition;
  if (!transition) throw new Error('Split enforcement requires a transition policy');
  const residualRules = transition.requirements.filter((r) => residualNames.has(r.name));
  return {
    ...checked,
    program: {
      ...checked.program,
      transition: {
        ...transition,
        requirements: residualRules,
      },
    },
    requirementNames: residualRules.map((r) => r.name),
  };
}

/** Normalize a raw verdict or thrown boundary error into a strict JSON-serializable summary. */
export function classifyVerdictOrThrow(run: () => Verdict): SplitNormalizedVerdict {
  try {
    const v = run();
    if (v.ok) {
      return { kind: 'verdict', ok: true, outcome: 'allow', fatal: false };
    }
    const fatal = Boolean(v.fatal);
    const outcome = v.trace?.outcome ?? (fatal ? 'resource-limit' : 'false');
    return {
      kind: 'verdict',
      ok: false,
      requirement: v.requirement,
      outcome,
      fatal,
    };
  } catch (err) {
    const ctor = err instanceof Error ? err.constructor.name : '';
    const message = err instanceof Error ? err.message : String(err);
    if (ctor === 'ResourceLimitError' || ctor === 'ExpressionLimitError') {
      return { kind: 'resource-limit', outcome: 'resource-limit', fatal: true, message };
    }
    if (ctor === 'EvalError' || ctor === 'RuleError') {
      return { kind: 'eval-error', outcome: 'eval-error', fatal: false, message };
    }
    return { kind: 'explicit-fail', fatal: false, message };
  }
}

/** Partition transition requirements into database-enforced and gateway-residual sets. */
export function partitionRequirements(rows: readonly SplitRequirementRow[]): {
  databaseRequirements: string[];
  databasePredicates: string[];
  residualRequirements: string[];
  mode: SplitEnforcementMode;
} {
  const databaseRequirements: string[] = [];
  const databasePredicates: string[] = [];
  const residualRequirements: string[] = [];
  for (const row of rows) {
    if (row.predicate && !row.completeReason) {
      databaseRequirements.push(row.requirement);
      databasePredicates.push(row.predicate);
    } else {
      residualRequirements.push(row.requirement);
    }
  }
  const mode: SplitEnforcementMode =
    databaseRequirements.length === 0
      ? 'gateway-only'
      : residualRequirements.length === 0
        ? 'complete'
        : 'split';
  return { databaseRequirements, databasePredicates, residualRequirements, mode };
}

/** Build a compiled target harness evaluating databasePredicate and gatewayResidual independently. */
export function createSplitTargetHarness(params: {
  target: PolicyTargetName;
  checked: CheckedPolicyIR;
  rows: readonly SplitRequirementRow[];
  bindings: FirestoreBindings | RtdbBindings | StorageBindings;
  storageMethod?: StorageSimMethod;
  instantiate: StandaloneInvoker;
}): SplitTargetHarness {
  const { target, checked, rows, bindings, instantiate } = params;
  const { databaseRequirements, databasePredicates, residualRequirements, mode } = partitionRequirements(rows);
  const dbReqSet = new Set(databaseRequirements);
  const residualSet = new Set(residualRequirements);
  const reqOrder = new Map<string, number>();
  checked.requirementNames.forEach((name, idx) => reqOrder.set(name, idx));

  const residualChecked = buildResidualCheckedIR(checked, residualSet);
  const residualModule = emitStandaloneModule(residualChecked);
  const residualMod = instantiate(residualModule.moduleSource);
  const resolvedStorageMethod =
    target === 'storage' ? (params.storageMethod ?? inferStorageMethod(bindings as StorageBindings)) : undefined;

  const databasePredicate =
    databasePredicates.length === 0
      ? undefined
      : databasePredicates.length === 1
        ? databasePredicates[0]!
        : databasePredicates.map((p) => `(${p})`).join(' && ');

  let dbEval: ((t: Transition) => TargetDecision | undefined) | undefined;
  if (databasePredicates.length > 0) {
    if (target === 'firestore') {
      dbEval = createFirestorePredicateEvaluator(databasePredicates, bindings as FirestoreBindings);
    } else if (target === 'rtdb') {
      dbEval = createRtdbEvaluator(databasePredicates, bindings as RtdbBindings);
    } else {
      dbEval = createStorageEvaluator(databasePredicates, bindings as StorageBindings, resolvedStorageMethod);
    }
  }

  const plan: SplitTargetPlan = {
    target,
    mode,
    databaseRequirements,
    residualRequirements,
    ...(databasePredicate !== undefined ? { databasePredicate } : {}),
    residualExports: residualModule.exports,
    residualModuleBytes: new TextEncoder().encode(residualModule.moduleSource).length,
    ...(resolvedStorageMethod ? { storageMethod: resolvedStorageMethod } : {}),
  };

  const judgeResidual = (transition: Transition): Verdict => residualMod.judge!(transition) as Verdict;
  const evaluateDb = (transition: Transition): TargetDecision | undefined => (dbEval ? dbEval(transition) : undefined);

  const evaluate = (transition: Transition, full: SplitNormalizedVerdict): SplitCaseOutcome => {
    const residual = classifyVerdictOrThrow(() => judgeResidual(transition));

    // Boundary errors (hostile getters, non-plain prototypes, cyclic/oversized payloads).
    if (full.kind !== 'verdict' || residual.kind !== 'verdict') {
      const sameKind = full.kind === residual.kind && full.fatal === residual.fatal;
      const sameExplicit = full.kind !== 'explicit-fail' || full.message === residual.message;
      const parityOk = sameKind && sameExplicit;
      return {
        target,
        parityOk,
        dbDecision: 'SKIPPED',
        residual,
        composed: { decision: 'DENY', fatal: residual.fatal },
        fullStandalone: full,
        ...(parityOk ? {} : { mismatch: `Boundary outcome diverged: full=${full.kind}, residual=${residual.kind}` }),
      };
    }

    let dbDecision: 'ALLOW' | 'DENY' | 'SKIPPED' | 'UNSUPPORTED';
    if (databaseRequirements.length === 0) {
      dbDecision = 'SKIPPED';
    } else if (!dbEval) {
      dbDecision = 'UNSUPPORTED';
    } else {
      dbDecision = dbEval(transition) ?? 'UNSUPPORTED';
    }

    if (dbDecision === 'UNSUPPORTED') {
      return {
        target,
        parityOk: true,
        dbDecision: 'UNSUPPORTED',
        residual,
        composed: { decision: 'UNSUPPORTED', fatal: residual.fatal },
        fullStandalone: full,
      };
    }

    const dbAllows = dbDecision === 'ALLOW' || dbDecision === 'SKIPPED';
    const composedDecision: 'ALLOW' | 'DENY' = dbAllows && residual.ok === true ? 'ALLOW' : 'DENY';
    // Non-absorbable fatal limit semantics: dbDecision === 'DENY' must never mask a fatal residual limit.
    const composedFatal = residual.fatal;
    const composed = { decision: composedDecision, fatal: composedFatal };

    if (full.ok === true) {
      const parityOk = composedDecision === 'ALLOW' && !composedFatal;
      return {
        target,
        parityOk,
        dbDecision,
        residual,
        composed,
        fullStandalone: full,
        ...(parityOk ? {} : { mismatch: `Expected ALLOW, got db=${dbDecision} residual=${residual.outcome ?? residual.kind}` }),
      };
    }

    if (full.fatal) {
      const reqMatches = !full.requirement || residual.requirement === full.requirement;
      const parityOk = composedDecision === 'DENY' && composedFatal === true && reqMatches;
      let mismatch: string | undefined;
      if (!parityOk) {
        if (full.requirement && dbReqSet.has(full.requirement)) {
          mismatch = `Fatal budget limit on lowered requirement ${full.requirement} not preserved by split enforcement`;
        } else {
          mismatch = `Expected fatal limit at ${full.requirement ?? 'unknown'}, got db=${dbDecision} residual=${residual.outcome ?? residual.kind} (fatal=${residual.fatal})`;
        }
      }
      return {
        target,
        parityOk,
        dbDecision,
        residual,
        composed,
        fullStandalone: full,
        ...(mismatch ? { mismatch } : {}),
      };
    }

    // Non-fatal full denial (`false` or recoverable `eval-error`).
    if (composedDecision !== 'DENY') {
      return {
        target,
        parityOk: false,
        dbDecision,
        residual,
        composed,
        fullStandalone: full,
        mismatch: `Fail-open divergence: full denied (${full.outcome ?? 'false'} at ${full.requirement}) while split allowed`,
      };
    }

    if (composedFatal) {
      const fullIdx = full.requirement !== undefined ? reqOrder.get(full.requirement) : undefined;
      const resIdx = residual.requirement !== undefined ? reqOrder.get(residual.requirement) : undefined;
      const earlierDbDenied =
        dbDecision === 'DENY' &&
        full.requirement !== undefined &&
        dbReqSet.has(full.requirement) &&
        fullIdx !== undefined &&
        resIdx !== undefined &&
        fullIdx < resIdx;
      if (earlierDbDenied) {
        return {
          target,
          parityOk: true,
          dbDecision,
          residual,
          composed,
          fullStandalone: full,
          dbDeniedBeforeResidualFatal: true,
        };
      }
      return {
        target,
        parityOk: false,
        dbDecision,
        residual,
        composed,
        fullStandalone: full,
        mismatch: `Unexpected fatal limit in residual at ${residual.requirement} (full was non-fatal at ${full.requirement})`,
      };
    }

    if (dbAllows && full.requirement && residualSet.has(full.requirement)) {
      const sameReq = residual.requirement === full.requirement;
      const sameOutcome = residual.outcome === full.outcome;
      if (!sameReq || !sameOutcome) {
        return {
          target,
          parityOk: false,
          dbDecision,
          residual,
          composed,
          fullStandalone: full,
          mismatch: `Residual denial differed: expected ${full.requirement}/${full.outcome}, got ${residual.requirement}/${residual.outcome}`,
        };
      }
    }

    return {
      target,
      parityOk: true,
      dbDecision,
      residual,
      composed,
      fullStandalone: full,
    };
  };

  return {
    target,
    plan,
    residualModule,
    residualRequirementSet: residualSet,
    evaluate,
    evaluateDb,
    judgeResidual,
  };
}

/** Mutable accumulator tracking split-enforcement proof statistics across scenarios and fuzz runs. */
export class SplitProofAccumulator {
  private checked = 0;
  private passed = 0;
  private skippedUnsupported = 0;
  private fatalOrderDifferences = 0;
  private readonly pathCounts: SplitPathCounts = { allow: 0, deny: 0, recoverableError: 0, fatalBudget: 0 };
  private readonly divergences: SplitDivergence[] = [];

  constructor(readonly harness: SplitTargetHarness) {}

  record(
    source: 'scenario' | 'fuzz',
    nameOrIndex: string | number,
    transition: Transition,
    outcome: SplitCaseOutcome,
  ): void {
    if (outcome.dbDecision === 'UNSUPPORTED') {
      this.skippedUnsupported++;
      return;
    }
    this.checked++;
    if (outcome.dbDeniedBeforeResidualFatal) this.fatalOrderDifferences++;
    const full = outcome.fullStandalone;
    if (full.kind === 'verdict' && full.ok) this.pathCounts.allow++;
    else if (full.fatal || full.outcome === 'resource-limit') this.pathCounts.fatalBudget++;
    else if (full.outcome === 'eval-error' || full.kind === 'eval-error') this.pathCounts.recoverableError++;
    else this.pathCounts.deny++;

    if (outcome.parityOk) {
      this.passed++;
    } else if (this.divergences.length < 16) {
      this.divergences.push({
        source,
        nameOrIndex,
        input: toDiagnosticJsonValue(transition),
        outcome,
      });
    }
  }

  summary(): SplitTargetProofSummary {
    return {
      target: this.harness.target,
      ok: this.divergences.length === 0 && this.passed === this.checked && !(this.checked === 0 && this.skippedUnsupported > 0),
      plan: this.harness.plan,
      checked: this.checked,
      passed: this.passed,
      skippedUnsupported: this.skippedUnsupported,
      pathCounts: { ...this.pathCounts },
      fatalOrderDifferences: this.fatalOrderDifferences,
      divergences: [...this.divergences],
    };
  }
}

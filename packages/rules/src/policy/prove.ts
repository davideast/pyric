// Isomorphic policy proving API (`provePolicy` & `verifySplitEnforcement`).
// Combines static IR verification, placement & budget classification across Firestore,
// unified RTDB, and Storage v2, explicit split-enforcement composition checks,
// scenario replay, and deterministic seeded differential fuzzing.
// Zero Node-only imports; 100% JSON-serializable report.
import { emitStandaloneModule } from './bounded-module.js';
import { checkPolicyIR, type CheckedPolicyIR } from './check.js';
import {
  estimateIRExprUnits,
  toDiagnosticJsonValue,
  type BoundedOpCostDetail,
  type ExpressionCostBreakdown,
  type PlacementProblemDetail,
} from './diagnostics.js';
import { interpretModule } from './eval-ir.js';
import type { FirestoreBindings } from './firestore.js';
import { parsePolicyIR, type PolicyProgramKind } from './ir.js';
import { compileFunction, compilePolicy, type SnapshotBindings, type Transition, type Verdict } from './index.js';
import {
  createFirestoreEvaluator,
  createRtdbEvaluator,
  createStorageEvaluator,
  detectPolicyKind,
  generateStorageTransitionCase,
  generateTransitionCase,
  instantiateStandaloneModule,
  mulberry32,
  normalizeError,
  normalizeVerdict,
  outcomesEqual,
  randomScalar,
  type NormalizedOutcome,
  type StorageSimMethod,
} from './prove-helpers.js';
import {
  classifyVerdictOrThrow,
  createSplitTargetHarness,
  SplitProofAccumulator,
  type PolicyTargetName,
  type SplitCaseOutcome,
  type SplitTargetProofSummary,
} from './split-proof.js';
import { isSupportedFirestoreBindings } from './target-evaluators.js';
import type { StorageBindings } from './storage.js';

export { detectPolicyKind, instantiateStandaloneModule } from './prove-helpers.js';

export interface PolicyPlacementRow {
  requirement: string;
  enforcement: string;
  reason: string;
  diagnostics: PlacementProblemDetail[];
  cost: ExpressionCostBreakdown;
  completeReason?: string;
}

export interface ProvePolicyScenario {
  name: string;
  transition?: Transition;
  functionName?: string;
  args?: unknown[];
  expectOk?: boolean;
  expectRequirement?: string;
  expectValue?: unknown;
  expectError?: boolean;
}

export interface ProvePolicyFuzzOptions {
  enabled?: boolean;
  seed?: number;
  cases?: number;
  includeAdversarial?: boolean;
  maxDurationMs?: number;
}

export interface ProvePolicyOptions {
  kind?: PolicyProgramKind;
  expressionLimit?: number;
  firestore?: FirestoreBindings;
  rtdb?: SnapshotBindings;
  storage?: StorageBindings;
  storageMethod?: StorageSimMethod;
  verifySplit?: boolean;
  scenarios?: readonly ProvePolicyScenario[];
  fuzz?: ProvePolicyFuzzOptions;
}

export interface ProveScenarioResult {
  name: string;
  ok: boolean;
  parityOk: boolean;
  interpreter: unknown;
  standalone: unknown;
  firestore?: string;
  rtdb?: string;
  storage?: string;
  split?: Partial<Record<PolicyTargetName, SplitCaseOutcome>>;
  mismatch?: string;
}

export interface ProveDivergence {
  caseIndex: number;
  input: unknown;
  interpreter: unknown;
  standalone: unknown;
  firestore?: string;
  rtdb?: string;
  storage?: string;
  split?: Partial<Record<PolicyTargetName, SplitCaseOutcome>>;
}

export interface PolicyProofReport {
  ok: boolean;
  kind: PolicyProgramKind;
  staticCheck: {
    ok: boolean;
    error?: string;
    extensions: string[];
    functions: string[];
    topoOrder: string[];
    exports: string[];
    requirements: string[];
    hasDerive: boolean;
    acyclic: boolean;
    expressionLimit: number;
  };
  standalone: {
    ok: boolean;
    exports: string[];
    moduleBytes: number;
    error?: string;
  };
  placement: {
    firestore?: PolicyPlacementRow[];
    rtdb?: PolicyPlacementRow[];
    storage?: PolicyPlacementRow[];
    functions?: Array<{
      name: string;
      exported: boolean;
      estimatedUnits: number;
      boundedOps: BoundedOpCostDetail[];
      firestoreLowerable?: boolean;
      firestoreReason?: string;
    }>;
  };
  split?: Partial<Record<PolicyTargetName, SplitTargetProofSummary>>;
  targetErrors?: Partial<Record<PolicyTargetName, string>>;
  scenarios: {
    total: number;
    passed: number;
    failed: number;
    results: ProveScenarioResult[];
  };
  fuzz: {
    enabled: boolean;
    seed: number;
    casesRun: number;
    passed: number;
    divergences: ProveDivergence[];
  };
}

export interface VerifySplitOptions {
  expressionLimit?: number;
  firestore?: FirestoreBindings;
  rtdb?: SnapshotBindings;
  storage?: StorageBindings;
  storageMethod?: StorageSimMethod;
  scenarios?: readonly ProvePolicyScenario[];
  fuzz?: ProvePolicyFuzzOptions;
}

export interface VerifySplitReport {
  ok: boolean;
  targets: Partial<Record<PolicyTargetName, SplitTargetProofSummary>>;
  scenarios: PolicyProofReport['scenarios'];
  fuzz: PolicyProofReport['fuzz'];
}

function summarizeRow(r: {
  requirement: string;
  enforcement: string;
  reason: string;
  diagnostics: PlacementProblemDetail[];
  cost: ExpressionCostBreakdown;
  completeReason?: string;
}): PolicyPlacementRow {
  return {
    requirement: r.requirement,
    enforcement: r.enforcement,
    reason: r.reason,
    diagnostics: r.diagnostics,
    cost: r.cost,
    ...(r.completeReason ? { completeReason: r.completeReason } : {}),
  };
}

/**
 * Prove a policy via static IR checks, placement/budget classification across
 * Firestore, unified RTDB, and Storage v2, split-enforcement composition verification,
 * scenario replay, and deterministic seeded differential fuzzing.
 */
export function provePolicy(source: string, options: ProvePolicyOptions = {}): PolicyProofReport {
  const kind = options.kind ?? detectPolicyKind(source);
  const expressionLimit = options.expressionLimit ?? 8192;
  const fuzzEnabled = options.fuzz?.enabled ?? true;
  const fuzzSeed = options.fuzz?.seed ?? 1337;
  const fuzzCases = Math.min(Math.max(0, options.fuzz?.cases ?? 64), 2000);
  const includeAdversarial = options.fuzz?.includeAdversarial ?? true;
  const maxDurationMs = Math.min(Math.max(100, options.fuzz?.maxDurationMs ?? 10000), 60000);
  const fuzzDeadline = Date.now() + maxDurationMs;
  const verifySplit = options.verifySplit ?? true;

  let checked: CheckedPolicyIR;
  try {
    checked = checkPolicyIR(parsePolicyIR(source, kind), { expressionLimit });
  } catch (error) {
    return {
      ok: false,
      kind,
      staticCheck: {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        extensions: [],
        functions: [],
        topoOrder: [],
        exports: [],
        requirements: [],
        hasDerive: false,
        acyclic: false,
        expressionLimit,
      },
      standalone: { ok: false, exports: [], moduleBytes: 0, error: 'Skipped due to static check failure' },
      placement: {},
      scenarios: { total: 0, passed: 0, failed: 0, results: [] },
      fuzz: { enabled: fuzzEnabled, seed: fuzzSeed, casesRun: 0, passed: 0, divergences: [] },
    };
  }

  let standaloneMod: Record<string, (...args: unknown[]) => unknown> | undefined;
  let standaloneInfo: PolicyProofReport['standalone'];
  try {
    const emitted = emitStandaloneModule(checked);
    standaloneMod = instantiateStandaloneModule(emitted.moduleSource);
    standaloneInfo = {
      ok: true,
      exports: emitted.exports,
      moduleBytes: new TextEncoder().encode(emitted.moduleSource).length,
    };
  } catch (error) {
    standaloneInfo = {
      ok: false,
      exports: [],
      moduleBytes: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const placement: PolicyProofReport['placement'] = {};
  const targetErrors: Partial<Record<PolicyTargetName, string>> = {};
  const scenarioResults: ProveScenarioResult[] = [];
  const divergences: ProveDivergence[] = [];
  const splitAccumulators: SplitProofAccumulator[] = [];
  let fuzzRun = 0;
  let fuzzPassed = 0;
  const nextRand = mulberry32(fuzzSeed);

  if (kind === 'transition') {
    const policy = compilePolicy(source, { expressionLimit });
    const addSplit = (
      target: PolicyTargetName,
      rows: readonly { requirement: string; predicate?: string; completeReason?: string }[],
      bindings: FirestoreBindings | SnapshotBindings | StorageBindings,
    ) => {
      if (!verifySplit || !standaloneMod?.judge) return;
      splitAccumulators.push(
        new SplitProofAccumulator(
          createSplitTargetHarness({
            target, checked, rows, bindings, storageMethod: options.storageMethod,
            instantiate: instantiateStandaloneModule,
          }),
        ),
      );
    };
    const fsRows = policy.firestore(options.firestore ?? {}, 'mixed');
    placement.firestore = fsRows.map(summarizeRow);
    let fsEval: ((t: Transition) => string | undefined) | undefined;
    if (options.firestore && fsRows.every((r) => r.predicate && !r.completeReason) && isSupportedFirestoreBindings(options.firestore)) {
      try {
        fsEval = createFirestoreEvaluator(policy.firestoreModule(options.firestore), checked.program.transition!.name, options.firestore);
      } catch (err) {
        fsEval = undefined;
        targetErrors.firestore = err instanceof Error ? err.message : String(err);
      }
    }
    if (options.firestore) addSplit('firestore', fsRows, options.firestore);

    let rtdbEval: ((t: Transition) => string | undefined) | undefined;
    if (options.rtdb) {
      const rtdbRows = policy.rtdb(options.rtdb, 'mixed');
      placement.rtdb = rtdbRows.map(summarizeRow);
      if (rtdbRows.every((r) => r.predicate && !r.completeReason)) {
        rtdbEval = createRtdbEvaluator(rtdbRows.map((r) => r.predicate!), options.rtdb);
      }
      addSplit('rtdb', rtdbRows, options.rtdb);
    }

    let storageEval: ((t: Transition) => string | undefined) | undefined;
    if (options.storage) {
      const stRows = policy.storage(options.storage, 'mixed');
      placement.storage = stRows.map(summarizeRow);
      if (stRows.every((r) => r.predicate && !r.completeReason)) {
        storageEval = createStorageEvaluator(stRows.map((r) => r.predicate!), options.storage, options.storageMethod);
      }
      addSplit('storage', stRows, options.storage);
    }

    const runTransition = (t: Transition, sourceKind: 'scenario' | 'fuzz', id: string | number) => {
      let rawInterp: Verdict | undefined;
      let interp: NormalizedOutcome;
      try {
        rawInterp = policy.judge(t);
        interp = normalizeVerdict(rawInterp);
      } catch (e) {
        interp = normalizeError(e);
      }
      let rawStand: Verdict | undefined;
      let stand: NormalizedOutcome;
      let fullSplitVerdict = standaloneMod?.judge
        ? classifyVerdictOrThrow(() => {
            rawStand = standaloneMod!.judge!(t) as Verdict;
            return rawStand;
          })
        : ({ kind: 'eval-error', fatal: false } as const);
      if (rawStand !== undefined) {
        stand = normalizeVerdict(rawStand);
      } else if (fullSplitVerdict.kind === 'resource-limit') {
        stand = { kind: 'resource-limit' };
      } else if (fullSplitVerdict.kind === 'eval-error') {
        stand = { kind: 'eval-error' };
      } else {
        stand = { kind: 'explicit-fail', message: fullSplitVerdict.message ?? '' };
      }

      const fsDecision = fsEval && interp.kind === 'verdict' ? fsEval(t) : undefined;
      const rtdbDecision = rtdbEval && interp.kind === 'verdict' ? rtdbEval(t) : undefined;
      const storageDecision = storageEval && interp.kind === 'verdict' ? storageEval(t) : undefined;

      const isFatal = Boolean(rawInterp && !rawInterp.ok && rawInterp.fatal);
      let parityOk = outcomesEqual(interp, stand);
      if (parityOk && fsDecision && interp.kind === 'verdict') parityOk = !isFatal && (fsDecision === 'ALLOW') === interp.ok;
      if (parityOk && rtdbDecision && interp.kind === 'verdict') parityOk = !isFatal && (rtdbDecision === 'ALLOW') === interp.ok;
      if (parityOk && storageDecision && interp.kind === 'verdict') parityOk = !isFatal && (storageDecision === 'ALLOW') === interp.ok;

      let splitMap: Partial<Record<PolicyTargetName, SplitCaseOutcome>> | undefined;
      if (splitAccumulators.length) {
        splitMap = {};
        for (const acc of splitAccumulators) {
          const outcome = acc.harness.evaluate(t, fullSplitVerdict);
          acc.record(sourceKind, id, t, outcome);
          splitMap[acc.harness.target] = outcome;
          if (!outcome.parityOk) parityOk = false;
        }
      }
      return { rawInterp, interp, stand, fsDecision, rtdbDecision, storageDecision, splitMap, parityOk };
    };

    for (const sc of options.scenarios ?? []) {
      const t = sc.transition ?? { before: {}, after: {}, input: {} };
      const run = runTransition(t, 'scenario', sc.name);
      const rawVerdict = run.rawInterp;
      let ok = run.parityOk;
      let mismatch: string | undefined;
      if (!run.parityOk) {
        const splitMismatch = run.splitMap
          ? Object.values(run.splitMap).find((s) => s && !s.parityOk)?.mismatch
          : undefined;
        mismatch = splitMismatch ?? 'Cross-engine parity divergence';
      }
      if (ok && sc.expectError && rawVerdict !== undefined) {
        ok = false;
        mismatch = `Expected boundary error, got verdict ok=${rawVerdict.ok}`;
      }
      if (ok && sc.expectOk !== undefined) {
        const actualOk = rawVerdict ? rawVerdict.ok : false;
        if (actualOk !== sc.expectOk) {
          ok = false;
          mismatch = `Expected ok=${sc.expectOk}, got ${rawVerdict ? `ok=${rawVerdict.ok}` : run.interp.kind}`;
        }
      }
      if (ok && sc.expectRequirement !== undefined) {
        if (!rawVerdict || rawVerdict.ok || rawVerdict.requirement !== sc.expectRequirement) {
          ok = false;
          mismatch = `Expected requirement=${sc.expectRequirement}`;
        }
      }
      scenarioResults.push({
        name: sc.name,
        ok,
        parityOk: run.parityOk,
        interpreter: toDiagnosticJsonValue(rawVerdict ?? run.interp),
        standalone: run.stand,
        ...(run.fsDecision ? { firestore: run.fsDecision } : {}),
        ...(run.rtdbDecision ? { rtdb: run.rtdbDecision } : {}),
        ...(run.storageDecision ? { storage: run.storageDecision } : {}),
        ...(run.splitMap ? { split: run.splitMap } : {}),
        ...(mismatch ? { mismatch } : {}),
      });
    }

    if (fuzzEnabled && standaloneMod?.judge) {
      for (let i = 0; i < fuzzCases; i++) {
        if (i > 0 && Date.now() > fuzzDeadline) break;
        const useStorageGen = Boolean(options.storage) && (!includeAdversarial || i % 4 !== 3);
        const t = useStorageGen
          ? generateStorageTransitionCase(checked, options.storage!, nextRand, (rng) =>
              randomScalar(rng, includeAdversarial),
            )
          : generateTransitionCase(checked, nextRand, includeAdversarial);
        const run = runTransition(t, 'fuzz', i);
        fuzzRun++;
        if (run.parityOk) fuzzPassed++;
        else if (divergences.length < 16) {
          divergences.push({
            caseIndex: i,
            input: toDiagnosticJsonValue(t),
            interpreter: run.interp,
            standalone: run.stand,
            ...(run.fsDecision ? { firestore: run.fsDecision } : {}),
            ...(run.rtdbDecision ? { rtdb: run.rtdbDecision } : {}),
            ...(run.storageDecision ? { storage: run.storageDecision } : {}),
            ...(run.splitMap ? { split: run.splitMap } : {}),
          });
        }
      }
    }
  } else {
    const fnList = [...checked.functions.values()];
    const compiledFn = kind === 'function' ? compileFunction(source, { expressionLimit }) : undefined;
    const interpretedMod = kind === 'module' ? interpretModule(source, { expressionLimit }) : undefined;
    placement.functions = fnList.map(({ fn }) => {
      const boundedOps: BoundedOpCostDetail[] = [];
      const units =
        fn.lets.reduce((s, l) => s + 1 + estimateIRExprUnits(l.value, boundedOps), 0) +
        estimateIRExprUnits(fn.body, boundedOps);
      let fsLowerable: boolean | undefined;
      let fsReason: string | undefined;
      if (compiledFn) {
        const diag = compiledFn.placement();
        fsLowerable = diag.firestoreLowerable;
        fsReason = diag.reason;
      }
      return {
        name: fn.name,
        exported: kind === 'function' ? true : fn.exported,
        estimatedUnits: units,
        boundedOps,
        ...(fsLowerable !== undefined ? { firestoreLowerable: fsLowerable } : {}),
        ...(fsReason !== undefined ? { firestoreReason: fsReason } : {}),
      };
    });

    const invokePair = (fnName: string, args: unknown[]) => {
      let interp: NormalizedOutcome;
      let stand: NormalizedOutcome;
      try {
        interp = { kind: 'ok', value: compiledFn ? compiledFn(...args) : interpretedMod![fnName]!(...args) };
      } catch (e) {
        interp = normalizeError(e);
      }
      try {
        stand = { kind: 'ok', value: standaloneMod![fnName]!(...args) };
      } catch (e) {
        stand = normalizeError(e);
      }
      return { interp, stand, parityOk: outcomesEqual(interp, stand) };
    };

    const defaultFnName = kind === 'function' ? fnList[0]!.fn.name : checked.exports[0]!;
    for (const sc of options.scenarios ?? []) {
      const targetName = sc.functionName ?? defaultFnName;
      const run = invokePair(targetName, sc.args ?? []);
      let ok = run.parityOk;
      let mismatch: string | undefined = run.parityOk ? undefined : 'Cross-engine parity divergence';
      if (ok && sc.expectError && run.interp.kind === 'ok') {
        ok = false;
        mismatch = 'Expected error, got value';
      }
      if (ok && sc.expectValue !== undefined) {
        const expectedNorm = JSON.stringify(toDiagnosticJsonValue(sc.expectValue));
        const actualNorm = run.interp.kind === 'ok' ? JSON.stringify(toDiagnosticJsonValue(run.interp.value)) : undefined;
        if (actualNorm !== expectedNorm) {
          ok = false;
          mismatch = `Expected ${expectedNorm}, got ${actualNorm ?? run.interp.kind}`;
        }
      }
      scenarioResults.push({
        name: sc.name,
        ok,
        parityOk: run.parityOk,
        interpreter: toDiagnosticJsonValue(run.interp),
        standalone: toDiagnosticJsonValue(run.stand),
        ...(mismatch ? { mismatch } : {}),
      });
    }

    if (fuzzEnabled && standaloneMod && defaultFnName) {
      const targetFn = checked.functions.get(defaultFnName)!.fn;
      // Avoid -0 on plain non-loop compileFunction (pinned legacy int semantics in for-of.test.ts:208).
      const skipNegZero = kind === 'function' && !checked.extensions.has('loops');
      for (let i = 0; i < fuzzCases; i++) {
        if (i > 0 && Date.now() > fuzzDeadline) break;
        const args = targetFn.parameters.map(() => {
          let v = randomScalar(nextRand, includeAdversarial);
          if (skipNegZero && typeof v === 'number' && Object.is(v, -0)) v = 0;
          return v;
        });
        const run = invokePair(defaultFnName, args);
        fuzzRun++;
        if (run.parityOk) fuzzPassed++;
        else if (divergences.length < 16) {
          divergences.push({
            caseIndex: i,
            input: toDiagnosticJsonValue(args),
            interpreter: toDiagnosticJsonValue(run.interp),
            standalone: toDiagnosticJsonValue(run.stand),
          });
        }
      }
    }
  }

  let splitReport: Partial<Record<PolicyTargetName, SplitTargetProofSummary>> | undefined;
  let splitAllOk = true;
  if (splitAccumulators.length) {
    splitReport = {};
    for (const acc of splitAccumulators) {
      const summary = acc.summary();
      splitReport[summary.target] = summary;
      if (!summary.ok) splitAllOk = false;
    }
  }

  const hasTargetErrors = Object.keys(targetErrors).length > 0;
  const scenariosPassed = scenarioResults.filter((r) => r.ok).length;
  const scenariosFailed = scenarioResults.length - scenariosPassed;
  const allOk = standaloneInfo.ok && splitAllOk && !hasTargetErrors && scenariosFailed === 0 && divergences.length === 0;

  return {
    ok: allOk,
    kind,
    staticCheck: {
      ok: true,
      extensions: [...checked.extensions],
      functions: [...checked.functions.keys()],
      topoOrder: [...checked.topoOrder],
      exports: [...checked.exports],
      requirements: [...checked.requirementNames],
      hasDerive: Boolean(checked.program.transition?.derivation),
      acyclic: true,
      expressionLimit,
    },
    standalone: standaloneInfo,
    placement,
    ...(splitReport ? { split: splitReport } : {}),
    ...(hasTargetErrors ? { targetErrors } : {}),
    scenarios: { total: scenarioResults.length, passed: scenariosPassed, failed: scenariosFailed, results: scenarioResults },
    fuzz: { enabled: fuzzEnabled, seed: fuzzSeed, casesRun: fuzzRun, passed: fuzzPassed, divergences },
  };
}

/** Focused entry verifying `databasePredicate && gatewayResidual === fullStandalone` across configured targets. */
export function verifySplitEnforcement(source: string, options: VerifySplitOptions): VerifySplitReport {
  if (!options.firestore && !options.rtdb && !options.storage) {
    throw new Error('verifySplitEnforcement requires at least one of firestore, rtdb, or storage bindings');
  }
  const report = provePolicy(source, { ...options, kind: 'transition', verifySplit: true });
  return {
    ok: report.ok,
    targets: report.split ?? {},
    scenarios: report.scenarios,
    fuzz: report.fuzz,
  };
}

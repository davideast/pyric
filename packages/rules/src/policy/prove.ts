// Isomorphic policy proving API (`provePolicy`).
// Combines static IR verification, placement & budget classification, scenario replay,
// and deterministic seeded differential fuzzing into one JSON-serializable report.
// Uses standard ECMAScript only (zero Node-only imports, zero dynamic module loading).
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
  detectPolicyKind,
  generateTransitionCase,
  instantiateStandaloneModule,
  mulberry32,
  normalizeError,
  normalizeVerdict,
  outcomesEqual,
  randomScalar,
  type NormalizedOutcome,
} from './prove-helpers.js';

export { detectPolicyKind, instantiateStandaloneModule } from './prove-helpers.js';

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
  mismatch?: string;
}

export interface ProveDivergence {
  caseIndex: number;
  input: unknown;
  interpreter: unknown;
  standalone: unknown;
  firestore?: string;
  rtdb?: string;
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
    firestore?: Array<{
      requirement: string;
      enforcement: string;
      reason: string;
      diagnostics: PlacementProblemDetail[];
      cost: ExpressionCostBreakdown;
    }>;
    rtdb?: Array<{
      requirement: string;
      enforcement: string;
      reason: string;
      diagnostics: PlacementProblemDetail[];
      cost: ExpressionCostBreakdown;
    }>;
    functions?: Array<{
      name: string;
      exported: boolean;
      estimatedUnits: number;
      boundedOps: BoundedOpCostDetail[];
      firestoreLowerable?: boolean;
      firestoreReason?: string;
    }>;
  };
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

/**
 * Prove a policy by running static IR checks, placement/budget classification, scenario replay,
 * and bounded seeded differential fuzzing across interpreter, standalone ES module, and targets.
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
  const scenarioResults: ProveScenarioResult[] = [];
  const divergences: ProveDivergence[] = [];
  let fuzzRun = 0;
  let fuzzPassed = 0;
  const nextRand = mulberry32(fuzzSeed);

  if (kind === 'transition') {
    const policy = compilePolicy(source, { expressionLimit });
    const fsBindings = options.firestore ?? {};
    const fsRows = policy.firestore(fsBindings, 'mixed');
    placement.firestore = fsRows.map((r) => ({
      requirement: r.requirement,
      enforcement: r.enforcement,
      reason: r.reason,
      diagnostics: r.diagnostics,
      cost: r.cost,
    }));
    let fsEval: ((t: Transition) => string | undefined) | undefined;
    if (options.firestore && fsRows.every((r) => r.predicate && !r.completeReason)) {
      try {
        const fsModule = policy.firestoreModule(options.firestore);
        fsEval = createFirestoreEvaluator(fsModule, checked.program.transition!.name, options.firestore);
      } catch {
        fsEval = undefined;
      }
    }
    let rtdbEval: ((t: Transition) => string | undefined) | undefined;
    if (options.rtdb) {
      const rtdbRows = policy.rtdb(options.rtdb, 'mixed');
      placement.rtdb = rtdbRows.map((r) => ({
        requirement: r.requirement,
        enforcement: r.enforcement,
        reason: r.reason,
        diagnostics: r.diagnostics,
        cost: r.cost,
      }));
      if (rtdbRows.every((r) => r.predicate)) {
        rtdbEval = createRtdbEvaluator(rtdbRows.map((r) => r.predicate!), options.rtdb);
      }
    }

    const runTransition = (t: Transition) => {
      const interp = normalizeVerdict(policy.judge(t));
      const stand = standaloneMod?.judge
        ? normalizeVerdict(standaloneMod.judge(t) as Verdict)
        : ({ kind: 'eval-error' } as NormalizedOutcome);
      const fsDecision = fsEval ? fsEval(t) : undefined;
      const rtdbDecision = rtdbEval ? rtdbEval(t) : undefined;
      let parityOk = outcomesEqual(interp, stand);
      if (parityOk && fsDecision && interp.kind === 'verdict') {
        parityOk = (fsDecision === 'ALLOW') === interp.ok;
      }
      if (parityOk && rtdbDecision && interp.kind === 'verdict') {
        parityOk = (rtdbDecision === 'ALLOW') === interp.ok;
      }
      return { interp, stand, fsDecision, rtdbDecision, parityOk };
    };

    for (const sc of options.scenarios ?? []) {
      const t = sc.transition ?? { before: {}, after: {}, input: {} };
      const rawVerdict = policy.judge(t);
      const run = runTransition(t);
      let ok = run.parityOk;
      let mismatch: string | undefined = run.parityOk ? undefined : 'Cross-engine parity divergence';
      if (ok && sc.expectOk !== undefined && rawVerdict.ok !== sc.expectOk) {
        ok = false;
        mismatch = `Expected ok=${sc.expectOk}, got ok=${rawVerdict.ok}`;
      }
      if (ok && sc.expectRequirement !== undefined && (rawVerdict.ok || rawVerdict.requirement !== sc.expectRequirement)) {
        ok = false;
        mismatch = `Expected requirement=${sc.expectRequirement}`;
      }
      scenarioResults.push({
        name: sc.name,
        ok,
        parityOk: run.parityOk,
        interpreter: toDiagnosticJsonValue(rawVerdict),
        standalone: run.stand,
        ...(run.fsDecision ? { firestore: run.fsDecision } : {}),
        ...(run.rtdbDecision ? { rtdb: run.rtdbDecision } : {}),
        ...(mismatch ? { mismatch } : {}),
      });
    }

    if (fuzzEnabled && standaloneMod?.judge) {
      for (let i = 0; i < fuzzCases; i++) {
        if (i > 0 && Date.now() > fuzzDeadline) break;
        const t = generateTransitionCase(checked, nextRand, includeAdversarial);
        const run = runTransition(t);
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
        const val = compiledFn ? compiledFn(...args) : interpretedMod![fnName]!(...args);
        interp = { kind: 'ok', value: val };
      } catch (e) {
        interp = normalizeError(e);
      }
      try {
        const val = standaloneMod![fnName]!(...args);
        stand = { kind: 'ok', value: val };
      } catch (e) {
        stand = normalizeError(e);
      }
      return { interp, stand, parityOk: outcomesEqual(interp, stand) };
    };

    const defaultFnName = kind === 'function' ? fnList[0]!.fn.name : checked.exports[0]!;
    for (const sc of options.scenarios ?? []) {
      const targetName = sc.functionName ?? defaultFnName;
      const args = sc.args ?? [];
      const run = invokePair(targetName, args);
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

  const scenariosPassed = scenarioResults.filter((r) => r.ok).length;
  const scenariosFailed = scenarioResults.length - scenariosPassed;
  const allOk = standaloneInfo.ok && scenariosFailed === 0 && divergences.length === 0;

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
    scenarios: {
      total: scenarioResults.length,
      passed: scenariosPassed,
      failed: scenariosFailed,
      results: scenarioResults,
    },
    fuzz: {
      enabled: fuzzEnabled,
      seed: fuzzSeed,
      casesRun: fuzzRun,
      passed: fuzzPassed,
      divergences,
    },
  };
}

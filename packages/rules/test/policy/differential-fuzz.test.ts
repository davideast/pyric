// Deterministic >=10,000-case (12,600+ executed) multi-engine differential fuzzer
// for @pyric/rules/experimental/policy. Proves agreement across:
//   1. In-process unified Policy IR interpreter (interpretModule / compileFunction / compilePolicy)
//   2. Compiled zero-dependency standalone ES module (compileBoundedModule / .standaloneModule())
//   3. Lowered Firestore Rules v2 simulator (firestoreRules)
//   4. Lowered RTDB simulator (rtdbRules: .validate and .write delete/null paths)
//   5. Lowered Firebase Storage Rules v2 simulator (storageRules)
// Plus explicit split-enforcement composition (dbPredicate && gatewayResidual === fullStandalone).
import { afterAll, describe, expect, test } from 'bun:test';
import {
  compileBoundedModule,
  compilePolicy,
  interpretModule,
  type Transition,
  type Verdict,
} from '../../src/policy/index.js';
import { createRng, type SeededRng } from './fuzz-prng.js';
import {
  generateStandaloneFunction,
  printFunction,
  shrinkFunctionProgram,
  type FuzzFunctionProgram,
} from './fuzz-grammar.js';
import {
  EDGE_NUMBERS,
  INT64_BOUNDARY_BIGINTS,
  SAFE_MAP_KEYS,
  generateValue,
  shrinkCounterexample,
  shrinkValue,
} from './fuzz-values.js';
import {
  generateExtendedFirestoreTransition,
  generateExtendedRtdbTransition,
  generateExtendedStorageTransition,
} from './fuzz-generators-ext.js';
import {
  captureCall,
  createModuleLoader,
  decisionOf,
  normalizeVerdict,
  normalizeVerdictDetailed,
  detailedVerdictsMatch,
  outcomesMatch,
  prepareFirestoreSim,
  prepareRtdbSim,
  prepareStorageSim,
  verdictsMatch,
} from './fuzz-oracle.js';
import {
  genFirestoreExtRecord,
  genRtdbExtRecord,
  genStorageExtInput,
  runDagAndDeriveSuite,
  runHostileAndBudgetSuite,
  runRe2ParitySuite,
  runSplitEnforcementSuite,
  safeJson,
} from './fuzz-suites-ext.js';

const loader = createModuleLoader('pyric-diff-fuzz-');
afterAll(() => loader.cleanup());

export const FUZZ_SUITE_TOTALS = {
  suite1AStandalone: 2400,
  suite1BErrorFatal: 600,
  suite1CDagDeriveLoop: 1200,
  suite1DHostileBudgetMin: 400,
  suite1ERe2Unicode: 2000,
  suite2Firestore: 1600,
  suite3ARtdbExact: 1400,
  suite3BRtdbSafeInt: 400,
  suite4Storage: 1600,
  suite5SplitEnforcement: 1200,
} as const;

function genHostArg(rng: SeededRng, opts: { allowBigInt?: boolean; allowNonFinite?: boolean } = {}): unknown {
  if (opts.allowBigInt && rng.bool(0.15)) return rng.pick(INT64_BOUNDARY_BIGINTS);
  if (opts.allowNonFinite && rng.bool(0.15)) return rng.pick(EDGE_NUMBERS);
  return generateValue(rng, {
    maxDepth: 2,
    maxListLength: 4,
    maxMapKeys: 4,
    allowNonFinite: opts.allowNonFinite ?? true,
    allowFloats: true,
    allowNull: true,
    keys: SAFE_MAP_KEYS,
  });
}

async function shrinkStandaloneFailure(prog: FuzzFunctionProgram, a: unknown, b: unknown): Promise<string> {
  const baseSrc = (p: FuzzFunctionProgram) => 'use extension bounded;\nexport ' + printFunction(p);
  const fails = async (p: FuzzFunctionProgram, x: unknown, y: unknown) => {
    try {
      const src = baseSrc(p);
      const compiled = compileBoundedModule(src);
      const mod = await loader.load(compiled.moduleSource, 'shrink');
      const interp = interpretModule(src);
      const o1 = captureCall(() => interp[p.name]!(x, y));
      const o2 = captureCall(() => mod[p.name]!(x, y));
      return !outcomesMatch(o1, o2);
    } catch {
      return false;
    }
  };
  let curP = prog;
  for (const cand of shrinkFunctionProgram(curP)) {
    if (await fails(cand, a, b)) {
      curP = cand;
      break;
    }
  }
  const src = baseSrc(curP);
  const compiled = compileBoundedModule(src);
  const mod = await loader.load(compiled.moduleSource, 'shrink_arg');
  const interp = interpretModule(src);
  const mismatchArgs = (x: unknown, y: unknown) => {
    const o1 = captureCall(() => interp[curP.name]!(x, y));
    const o2 = captureCall(() => mod[curP.name]!(x, y));
    return !outcomesMatch(o1, o2);
  };
  const shrunkA = shrinkCounterexample(a, shrinkValue, (x) => mismatchArgs(x, b), 40);
  const shrunkB = shrinkCounterexample(b, shrinkValue, (y) => mismatchArgs(shrunkA.value, y), 40);
  return `Shrunk program:\n${src}\nargs: [${safeJson(shrunkA.value)}, ${safeJson(shrunkB.value)}]`;
}

describe('Multi-engine differential compiler fuzzer (>=10,000 cases)', () => {
  test('Suite budget sum exceeds 10,000 deterministic cases', () => {
    const plannedTotal = Object.values(FUZZ_SUITE_TOTALS).reduce((a, b) => a + b, 0);
    expect(plannedTotal).toBe(12800);
    expect(plannedTotal).toBeGreaterThanOrEqual(10000);
  });

  test('Suite 1A: 2,400 seeded standalone function evaluations match across interpreter and ES module', async () => {
    const rng = createRng(0x5eed1001);
    const BATCHES = 20;
    const FNS_PER_BATCH = 30;
    const INPUTS_PER_FN = 4;
    let executed = 0;

    for (let batch = 0; batch < BATCHES; batch++) {
      const programs: FuzzFunctionProgram[] = [];
      const fnSources: string[] = [];
      for (let i = 0; i < FNS_PER_BATCH; i++) {
        const prog = { ...generateStandaloneFunction(rng), name: `f_${batch}_${i}` };
        programs.push(prog);
        fnSources.push('export ' + printFunction(prog));
      }
      const moduleSrc = 'use extension bounded;\n' + fnSources.join('\n');
      const compiled = compileBoundedModule(moduleSrc);
      const mod = await loader.load(compiled.moduleSource, `s1a_${batch}`);
      const interp = interpretModule(moduleSrc);

      for (const prog of programs) {
        for (let k = 0; k < INPUTS_PER_FN; k++) {
          const a = genHostArg(rng, { allowBigInt: true, allowNonFinite: true });
          const b = genHostArg(rng, { allowBigInt: true, allowNonFinite: true });
          const expected = captureCall(() => interp[prog.name]!(a, b));
          const actual = captureCall(() => mod[prog.name]!(a, b));
          if (!outcomesMatch(expected, actual)) {
            const detail = await shrinkStandaloneFailure(prog, a, b);
            throw new Error(
              `Suite 1A mismatch on ${prog.name} (case #${executed}):\n` +
              `interp=${safeJson(expected)}\nmodule=${safeJson(actual)}\n${detail}`,
            );
          }
          executed++;
        }
      }
    }
    expect(executed).toBe(FUZZ_SUITE_TOTALS.suite1AStandalone);
  }, 45000);

  test('Suite 1B: 600 error-absorption and fatal ResourceLimitError cases match across interpreter and ES module', async () => {
    const rng = createRng(0x5eed1002);
    const TOTAL = FUZZ_SUITE_TOTALS.suite1BErrorFatal;
    const moduleSrc = `
      use extension bounded;
      export function errAndFalse(x) { return (1 / x == 0) && false; }
      export function falseAndErr(x) { return false && (1 / x == 0); }
      export function errOrTrue(x) { return (1 / x == 0) || true; }
      export function trueOrErr(x) { return true || (1 / x == 0); }
      export function unusedErrLet(m) { let bad = m.missing + 1; return true; }
      export function absorbedLet(m) { let bad = m.missing; return (bad == 1) || true; }
      export function fatalCountOrTrue(xs) { return (bounded.count(xs, x => x > 0, 3) >= 0) || true; }
      export function fatalAnyAndFalse(xs) { return bounded.any(xs, x => x > 0, 3) && false; }
      export function fatalAllOrTrue(xs) { return bounded.all(xs, x => x > 0, 3) || true; }
      export function fatalFoldOrTrue(xs) { return (bounded.fold(xs, 0, (acc, x) => acc + x, 3) >= 0) || true; }
      export function fatalMapOrTrue(xs) { return (bounded.map(xs, x => x + 1, 3).size() >= 0) || true; }
      export function fatalFlatMapOrTrue(xs) { return (bounded.flatMap(xs, x => [x], 3).size() >= 0) || true; }
      export function fatalSelectOrTrue(xs) { return (bounded.select(xs, x => x > 0, 3).size() >= 0) || true; }
      export function fatalAppendOrTrue(xs, ys) { return (bounded.append(xs, ys, 3).size() >= 0) || true; }
      export function anyAbsorbsItemErr(xs) { return bounded.any(xs, x => (1 / x == 1), 5); }
      export function allAbsorbsItemErr(xs) { return bounded.all(xs, x => (1 / x == 1), 5); }
      export function nestedAnyFatal(xs, ys) { return bounded.any(xs, x => x == 0 ? (1 / x == 1) : (bounded.count(ys, y => y > 0, 2) >= 0), 4); }
      export function appendArgOrder(x, ys) { return bounded.append(1 / x, bounded.map(ys, y => y, 2), 2); }
      export function appendLimitVsErr(xs, x) { return bounded.append(xs, 1 / x, 2); }
      export function foldArgOrder(x, ys) { return bounded.fold(1 / x, bounded.map(ys, y => y, 2), (acc, v) => acc, 2); }
      export function foldLimitVsErr(xs, x) { return bounded.fold(xs, 1 / x, (acc, v) => acc, 2); }
    `;
    const compiled = compileBoundedModule(moduleSrc);
    const mod = await loader.load(compiled.moduleSource, 's1b');
    const interp = interpretModule(moduleSrc);
    const fnNames = Object.keys(interp);

    let executed = 0;
    let fatalVerified = 0;
    for (let i = 0; i < TOTAL; i++) {
      const name = fnNames[i % fnNames.length]!;
      let args: unknown[];
      if (name === 'fatalAppendOrTrue') {
        args = [
          Array.from({ length: rng.int(0, 4) }, () => rng.int(-2, 3)),
          Array.from({ length: rng.int(0, 4) }, () => rng.int(-2, 3)),
        ];
      } else if (name === 'nestedAnyFatal') {
        args = [
          Array.from({ length: rng.int(0, 4) }, () => rng.pick([0, 1, 2])),
          Array.from({ length: rng.int(0, 4) }, () => rng.pick([0, 1])),
        ];
      } else if (name === 'appendArgOrder' || name === 'foldArgOrder') {
        args = [
          rng.pick([0, 1, 'bad']),
          Array.from({ length: rng.int(0, 4) }, () => rng.int(0, 2)),
        ];
      } else if (name === 'appendLimitVsErr' || name === 'foldLimitVsErr') {
        args = [
          Array.from({ length: rng.int(0, 4) }, () => rng.int(0, 2)),
          rng.pick([0, 1, 'bad']),
        ];
      } else if (name.startsWith('fatal') || name.endsWith('ItemErr')) {
        const list = rng.bool(0.15)
          ? 'not-a-list'
          : Array.from({ length: rng.int(0, 6) }, () => rng.pick([0, 1, 2, -1, 'bad', null]));
        args = [list];
      } else if (name.includes('Let')) {
        args = [rng.pick([{}, { missing: 1 }, { missing: 'x' }, null, 42])];
      } else {
        args = [rng.pick([0, 1, -1, 0.0, -0.0, Number.NaN, 'str', null])];
      }

      const o1 = captureCall(() => interp[name]!(...args));
      const o2 = captureCall(() => mod[name]!(...args));
      expect(outcomesMatch(o1, o2), `Suite 1B ${name}(${safeJson(args)}): interp=${safeJson(o1)} mod=${safeJson(o2)}`).toBe(true);
      if (
        name.startsWith('fatal') &&
        Array.isArray(args[0]) &&
        (args[0].length > 3 || (name === 'fatalAppendOrTrue' && args[0].length + (args[1] as unknown[]).length > 3))
      ) {
        expect(o1.kind, `Fatal limit absorbed in interp for ${name}`).toBe('resource-limit');
        expect(o2.kind, `Fatal limit absorbed in module for ${name}`).toBe('resource-limit');
        fatalVerified++;
      }
      executed++;
    }
    expect(executed).toBe(TOTAL);
    expect(fatalVerified).toBeGreaterThanOrEqual(80);
  }, 25000);

  test('Suite 1C: 1,200 nested derive, bounded.*, helper DAG, for...of, and builtin parity cases', async () => {
    const rng = createRng(0x5eed1003);
    const executed = await runDagAndDeriveSuite(loader, rng, {
      dagModules: 25,
      dagInputs: 16,
      derivePolicies: 25,
      deriveInputs: 16,
      loopCases: 120,
      builtinCases: 280,
    });
    expect(executed).toBe(FUZZ_SUITE_TOTALS.suite1CDagDeriveLoop);
  }, 45000);

  test('Suite 1D: >=400 hostile payload, prototype/getter, Proxy, JSON extractor, and tight-budget isolation checks', async () => {
    const rng = createRng(0x5eed1004);
    const checks = await runHostileAndBudgetSuite(loader, rng);
    expect(checks).toBeGreaterThanOrEqual(FUZZ_SUITE_TOTALS.suite1DHostileBudgetMin);
  }, 30000);

  test('Suite 1E: 2,000 RE2 Unicode, case-fold, surrogate, escape, and backtracking parity cases', async () => {
    const rng = createRng(0x5eed1005);
    const executed = await runRe2ParitySuite(loader, rng, FUZZ_SUITE_TOTALS.suite1ERe2Unicode);
    expect(executed).toBe(FUZZ_SUITE_TOTALS.suite1ERe2Unicode);
  }, 45000);

  test('Suite 2: 1,600 seeded Firestore policy evaluations agree across interpreter, ES module, and simulator', async () => {
    const rng = createRng(0x5eed2001);
    const POLICIES = 80;
    const INPUTS_PER_POLICY = FUZZ_SUITE_TOTALS.suite2Firestore / POLICIES;
    let executed = 0;
    let loweredExecuted = 0;
    let loweredPolicies = 0;

    for (let p = 0; p < POLICIES; p++) {
      const { source } = generateExtendedFirestoreTransition(rng);
      const policy = compilePolicy(source);
      const mod = await loader.load(policy.standaloneModule().moduleSource, `fs_${p}`);
      const modJudge = mod.judge as (t: Transition) => Verdict;
      const sim = prepareFirestoreSim(source);
      if (sim.lowered) loweredPolicies++;

      for (let j = 0; j < INPUTS_PER_POLICY; j++) {
        const transition: Transition = {
          before: genFirestoreExtRecord(rng),
          after: genFirestoreExtRecord(rng),
          input: genFirestoreExtRecord(rng),
        };
        const raw1 = policy.judge(transition);
        const raw2 = modJudge(transition);
        const vInterp = normalizeVerdict(raw1);
        const vMod = normalizeVerdict(raw2);
        expect(verdictsMatch(vInterp, vMod), `Firestore #${p}.${j} interp vs mod:\n${source}\nt=${safeJson(transition)}\ninterp=${safeJson(vInterp)} mod=${safeJson(vMod)}`).toBe(true);
        expect(detailedVerdictsMatch(normalizeVerdictDetailed(raw1), normalizeVerdictDetailed(raw2)), `Firestore #${p}.${j} 4-way mismatch`).toBe(true);
        if (sim.lowered) {
          const decision = sim.simulate(transition);
          expect(decision, `Firestore #${p}.${j} interp vs sim:\n${source}\npred=${sim.predicate}\nt=${safeJson(transition)}`).toBe(decisionOf(vInterp));
          loweredExecuted++;
        }
        executed++;
      }
    }
    expect(executed).toBe(FUZZ_SUITE_TOTALS.suite2Firestore);
    expect(loweredPolicies).toBeGreaterThanOrEqual(64);
    expect(loweredExecuted).toBeGreaterThanOrEqual(1280);
  }, 60000);

  test('Suite 3A: 1,400 seeded RTDB exact-parity evaluations (.validate and .write delete/null) agree across 3 engines', async () => {
    const rng = createRng(0x5eed3001);
    const POLICIES = 70;
    const INPUTS_PER_POLICY = FUZZ_SUITE_TOTALS.suite3ARtdbExact / POLICIES;
    let executed = 0;
    let loweredExecuted = 0;
    let writeDeleteExecuted = 0;
    let loweredPolicies = 0;

    for (let p = 0; p < POLICIES; p++) {
      const { source, ruleKind } = generateExtendedRtdbTransition(rng);
      const policy = compilePolicy(source);
      const mod = await loader.load(policy.standaloneModule().moduleSource, `rtdb_${p}`);
      const modJudge = mod.judge as (t: Transition) => Verdict;
      const sim = prepareRtdbSim(source, { ruleKind });
      if (sim.lowered) loweredPolicies++;

      for (let j = 0; j < INPUTS_PER_POLICY; j++) {
        const before = genRtdbExtRecord(rng, { allowNullRoot: ruleKind === 'write' });
        const after = genRtdbExtRecord(rng, { allowNullRoot: ruleKind === 'write' });
        const transition: Transition = { before, after, input: {} };
        const raw1 = policy.judge(transition);
        const raw2 = modJudge(transition);
        const vInterp = normalizeVerdict(raw1);
        const vMod = normalizeVerdict(raw2);
        expect(verdictsMatch(vInterp, vMod), `RTDB #${p}.${j} interp vs mod:\n${source}`).toBe(true);
        expect(detailedVerdictsMatch(normalizeVerdictDetailed(raw1), normalizeVerdictDetailed(raw2)), `RTDB #${p}.${j} 4-way mismatch`).toBe(true);
        if (sim.lowered) {
          const decision = sim.simulate(before, after);
          expect(decision, `RTDB (${ruleKind}) #${p}.${j} interp vs sim:\n${source}\npred=${sim.predicate}\nbefore=${safeJson(before)} after=${safeJson(after)}`).toBe(decisionOf(vInterp));
          loweredExecuted++;
          if (ruleKind === 'write') writeDeleteExecuted++;
        }
        executed++;
      }
    }
    expect(executed).toBe(FUZZ_SUITE_TOTALS.suite3ARtdbExact);
    expect(loweredPolicies).toBeGreaterThanOrEqual(55);
    expect(loweredExecuted).toBeGreaterThanOrEqual(1100);
    expect(writeDeleteExecuted).toBeGreaterThanOrEqual(160);
  }, 60000);

  test('Suite 3B: 400 RTDB safe-int/2^53 overflow boundary cases enforce exact interp/module parity and zero fail-open', async () => {
    const rng = createRng(0x5eed3002);
    const POLICIES = 20;
    const INPUTS_PER_POLICY = FUZZ_SUITE_TOTALS.suite3BRtdbSafeInt / POLICIES;
    let executed = 0;
    let loweredExecuted = 0;
    let failClosedCount = 0;

    for (let p = 0; p < POLICIES; p++) {
      const { source, ruleKind } = generateExtendedRtdbTransition(rng);
      const policy = compilePolicy(source);
      const mod = await loader.load(policy.standaloneModule().moduleSource, `rtdb_ov_${p}`);
      const modJudge = mod.judge as (t: Transition) => Verdict;
      const sim = prepareRtdbSim(source, { ruleKind });

      for (let j = 0; j < INPUTS_PER_POLICY; j++) {
        const before = genRtdbExtRecord(rng, { allowNullRoot: ruleKind === 'write', overflowMode: true });
        const after = genRtdbExtRecord(rng, { allowNullRoot: ruleKind === 'write', overflowMode: true });
        const transition: Transition = { before, after, input: {} };
        const raw1 = policy.judge(transition);
        const raw2 = modJudge(transition);
        expect(detailedVerdictsMatch(normalizeVerdictDetailed(raw1), normalizeVerdictDetailed(raw2)), `RTDB-3B #${p}.${j} 4-way mismatch`).toBe(true);
        if (sim.lowered) {
          const want = decisionOf(normalizeVerdict(raw1));
          const got = sim.simulate(before, after);
          if (got === 'ALLOW') {
            expect(want, `RTDB-3B FAIL-OPEN #${p}.${j}:\n${source}\npred=${sim.predicate}\nb=${safeJson(before)} a=${safeJson(after)}`).toBe('ALLOW');
          } else if (want === 'ALLOW') {
            failClosedCount++;
          }
          loweredExecuted++;
        }
        executed++;
      }
    }
    expect(executed).toBe(FUZZ_SUITE_TOTALS.suite3BRtdbSafeInt);
    expect(loweredExecuted).toBeGreaterThanOrEqual(300);
    expect(failClosedCount).toBeLessThan(loweredExecuted);
  }, 45000);

  test('Suite 4: 1,600 seeded Storage policy evaluations (paths, MIME, size, metadata, bare-root) agree across 3 engines', async () => {
    const rng = createRng(0x5eed4001);
    const POLICIES = 80;
    const INPUTS_PER_POLICY = FUZZ_SUITE_TOTALS.suite4Storage / POLICIES;
    let executed = 0;
    let loweredExecuted = 0;
    let loweredPolicies = 0;

    for (let p = 0; p < POLICIES; p++) {
      const method: 'create' | 'update' = p % 2 === 0 ? 'create' : 'update';
      const { source } = generateExtendedStorageTransition(rng, method);
      const policy = compilePolicy(source);
      const mod = await loader.load(policy.standaloneModule().moduleSource, `st_${p}`);
      const modJudge = mod.judge as (t: Transition) => Verdict;
      const sim = prepareStorageSim(source, method, { wildcard: true });
      if (sim.lowered) loweredPolicies++;

      for (let j = 0; j < INPUTS_PER_POLICY; j++) {
        const simInput = genStorageExtInput(rng, method);
        const transition: Transition = {
          before: simInput.before ?? null,
          after: simInput.after,
          input: { auth: simInput.auth },
        };
        const raw1 = policy.judge(transition);
        const raw2 = modJudge(transition);
        const vInterp = normalizeVerdict(raw1);
        const vMod = normalizeVerdict(raw2);
        expect(verdictsMatch(vInterp, vMod), `Storage #${p}.${j} interp vs mod:\n${source}\nt=${safeJson(transition)}\ninterp=${safeJson(vInterp)}\nmod=${safeJson(vMod)}`).toBe(true);
        expect(detailedVerdictsMatch(normalizeVerdictDetailed(raw1), normalizeVerdictDetailed(raw2)), `Storage #${p}.${j} 4-way mismatch`).toBe(true);
        if (sim.lowered) {
          const decision = sim.simulate(simInput);
          expect(decision, `Storage #${p}.${j} interp vs sim:\n${source}\npred=${sim.predicate}\ninput=${safeJson(simInput)}`).toBe(decisionOf(vInterp));
          loweredExecuted++;
        }
        executed++;
      }
    }
    expect(executed).toBe(FUZZ_SUITE_TOTALS.suite4Storage);
    expect(loweredPolicies).toBeGreaterThanOrEqual(55);
    expect(loweredExecuted).toBeGreaterThanOrEqual(1100);
  }, 60000);

  test('Suite 5: 1,200 split-enforcement composition parity cases (Firestore, RTDB, Storage)', async () => {
    const rng = createRng(0x5eed5001);
    const res = await runSplitEnforcementSuite(loader, rng, 400);
    expect(res.firestore).toBe(400);
    expect(res.rtdb).toBe(400);
    expect(res.storage).toBe(400);
    expect(res.executed).toBe(FUZZ_SUITE_TOTALS.suite5SplitEnforcement);
    expect(res.fatalChecked).toBeGreaterThanOrEqual(40);
  }, 60000);
});

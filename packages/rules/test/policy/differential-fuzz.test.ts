// Deterministic >=2,000-case multi-engine differential fuzzer for @pyric/rules/experimental/policy.
// Proves bit-for-bit agreement across:
//   1. In-process unified Policy IR interpreter (interpretModule / compileFunction / compilePolicy)
//   2. Compiled zero-dependency standalone ES module (compileBoundedModule / .standaloneModule())
//   3. Lowered Firestore Rules v2 simulator (firestoreRules)
//   4. Lowered RTDB simulator (rtdbRules)
//   5. Lowered Firebase Storage Rules v2 simulator (storageRules)
import { afterAll, describe, expect, test } from 'bun:test';
import {
  compileBoundedModule,
  compileFunction,
  compilePolicy,
  interpretModule,
  type Transition,
  type Verdict,
} from '../../src/policy/index.js';
import { createRng, type SeededRng } from './fuzz-prng.js';
import {
  generateFirestoreTransition,
  generateRtdbTransition,
  generateStandaloneFunction,
  generateStorageTransition,
  printFunction,
  printTransition,
  shrinkFunctionProgram,
  type FuzzFunctionProgram,
} from './fuzz-grammar.js';
import {
  EDGE_NUMBERS,
  INT64_BOUNDARY_BIGINTS,
  SAFE_MAP_KEYS,
  generateValue,
  hostilePayloads,
  shrinkCounterexample,
  shrinkValue,
} from './fuzz-values.js';
import {
  captureCall,
  createModuleLoader,
  decisionOf,
  normalizeVerdict,
  outcomesMatch,
  outcomesMatchWithSafeIntBridge,
  simulateFirestorePolicy,
  simulateRtdbPolicy,
  simulateStoragePolicy,
  verdictsMatch,
  type StorageSimInput,
} from './fuzz-oracle.js';

const loader = createModuleLoader('pyric-diff-fuzz-');
afterAll(() => loader.cleanup());

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

function genFirestoreRecord(rng: SeededRng): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const vals: readonly unknown[] = [
    0, -0.0, 1, -1, 2, 7, 1.5, -2.5,
    Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1,
    '', 'a', 'ab', 'ok', true, false, null, [1, 2], { k: 1 },
  ];
  for (const key of ['x', 'y', 's', 'flag', 'tag']) {
    if (rng.bool(0.75)) out[key] = rng.pick(vals);
  }
  return out;
}

function genRtdbRecord(rng: SeededRng): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const vals: readonly unknown[] = [
    0, 1, -1, 2, -2, 5, 7, 1.5, -0.5, 42,
    '', 'a', 'ab', 'ok', 'hi', true, false,
  ];
  for (const key of ['x', 'y', 's', 'flag']) {
    if (rng.bool(0.75)) out[key] = rng.pick(vals);
  }
  return out;
}

function genStorageInput(rng: SeededRng, method: 'create' | 'update'): StorageSimInput {
  const uids = ['alice', 'bob', 'carol', ''];
  const contentTypes = ['audio/wav', 'audio/ogg', 'image/png', 'image/jpeg', 'text/plain', 'application/octet-stream'];
  const sizes = [0, 32, 64, 512, 1024, 4096, 8192];
  const makeRes = () => {
    const metadata: Record<string, string> = {};
    if (rng.bool(0.75)) metadata.owner = rng.pick(uids);
    if (rng.bool(0.4)) metadata.tag = rng.pick(['clip', 'avatar', 'note']);
    return {
      size: rng.pick(sizes),
      contentType: rng.pick(contentTypes),
      name: 'items/obj1',
      metadata,
    };
  };
  const auth = rng.bool(0.75) ? { uid: rng.pick(uids) } : null;
  return {
    method,
    auth,
    ...(method === 'update' ? { before: makeRes() } : {}),
    after: makeRes(),
  };
}

function safeJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() + 'n' : val));
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
  const shrunkA = shrinkCounterexample(a, shrinkValue, (x) => {
    try {
      const interp = interpretModule(baseSrc(curP));
      captureCall(() => interp[curP.name]!(x, b));
      return false;
    } catch { return false; }
  }, 10);
  return `Shrunk program:\n${baseSrc(curP)}\nargs: [${JSON.stringify(shrunkA.value)}, ${JSON.stringify(b)}]`;
}

describe('Multi-engine differential compiler fuzzer (>=2,000 cases)', () => {
  test('Suite 1A: 800 seeded standalone functions match across interpreter and compiled ES module', async () => {
    const rng = createRng(0x5eed1001);
    const BATCH_SIZE = 40;
    const TOTAL_CASES = 800;
    let executed = 0;

    for (let batch = 0; batch < TOTAL_CASES / BATCH_SIZE; batch++) {
      const programs: FuzzFunctionProgram[] = [];
      const fnSources: string[] = [];
      for (let i = 0; i < BATCH_SIZE; i++) {
        const prog = { ...generateStandaloneFunction(rng), name: `f_${batch}_${i}` };
        programs.push(prog);
        fnSources.push('export ' + printFunction(prog));
      }
      const moduleSrc = 'use extension bounded;\n' + fnSources.join('\n');
      const compiled = compileBoundedModule(moduleSrc);
      const mod = await loader.load(compiled.moduleSource, `s1a_${batch}`);
      const interp = interpretModule(moduleSrc);

      for (const prog of programs) {
        const a = genHostArg(rng, { allowBigInt: true, allowNonFinite: true });
        const b = genHostArg(rng, { allowBigInt: true, allowNonFinite: true });
        const expected = captureCall(() => interp[prog.name]!(a, b));
        const actual = captureCall(() => mod[prog.name]!(a, b));
        if (!outcomesMatch(expected, actual)) {
          const detail = await shrinkStandaloneFailure(prog, a, b);
          throw new Error(
            `Suite 1A mismatch on ${prog.name} (case #${executed}):\n` +
            `interp=${JSON.stringify(expected)}\nmodule=${JSON.stringify(actual)}\n${detail}`,
          );
        }
        executed++;
      }
    }
    expect(executed).toBe(TOTAL_CASES);
  }, 30000);

  test('Suite 1B: 150 error-absorption and fatal ResourceLimitError cases match across interpreter and ES module', async () => {
    const rng = createRng(0x5eed1002);
    const TOTAL = 150;
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
      export function fatalSelectOrTrue(xs) { return (bounded.select(xs, x => x > 0, 3).size() >= 0) || true; }
      export function fatalAppendOrTrue(xs, ys) { return (bounded.append(xs, ys, 3).size() >= 0) || true; }
      export function anyAbsorbsItemErr(xs) { return bounded.any(xs, x => (1 / x == 1), 5); }
      export function allAbsorbsItemErr(xs) { return bounded.all(xs, x => (1 / x == 1), 5); }
    `;
    const compiled = compileBoundedModule(moduleSrc);
    const mod = await loader.load(compiled.moduleSource, 's1b');
    const interp = interpretModule(moduleSrc);

    const fnNames = Object.keys(interp);
    let executed = 0;
    for (let i = 0; i < TOTAL; i++) {
      const name = fnNames[i % fnNames.length]!;
      let args: unknown[];
      if (name === 'fatalAppendOrTrue') {
        const l1 = Array.from({ length: rng.int(0, 4) }, () => rng.int(-2, 3));
        const l2 = Array.from({ length: rng.int(0, 4) }, () => rng.int(-2, 3));
        args = [l1, l2];
      } else if (name.startsWith('fatal') || name.endsWith('ItemErr')) {
        const len = rng.int(0, 6);
        const list = rng.bool(0.15)
          ? 'not-a-list'
          : Array.from({ length: len }, () => rng.pick([0, 1, 2, -1, 'bad', null]));
        args = [list];
      } else if (name.includes('Let')) {
        args = [rng.pick([{}, { missing: 1 }, { missing: 'x' }, null, 42])];
      } else {
        args = [rng.pick([0, 1, -1, 0.0, -0.0, Number.NaN, 'str', null])];
      }

      const o1 = captureCall(() => interp[name]!(...args));
      const o2 = captureCall(() => mod[name]!(...args));
      expect(outcomesMatch(o1, o2), `Suite 1B ${name}(${JSON.stringify(args)}): interp=${JSON.stringify(o1)} mod=${JSON.stringify(o2)}`).toBe(true);
      // Verify over-limit lists are strictly fatal resource-limit errors and NEVER absorbed to true/false.
      if (name.startsWith('fatal') && Array.isArray(args[0]) && (args[0].length > 3 || (name === 'fatalAppendOrTrue' && args[0].length + (args[1] as unknown[]).length > 3))) {
        expect(o1.kind, `Fatal limit must not be absorbed for ${name}`).toBe('resource-limit');
        expect(o2.kind, `Fatal limit must not be absorbed in module for ${name}`).toBe('resource-limit');
      }
      executed++;
    }
    expect(executed).toBe(TOTAL);
  }, 20000);

  test('Suite 1C: 100 for...of loop and derive+require transition cases match across interpreter and ES module', async () => {
    const rng = createRng(0x5eed1003);
    const loopSrc = `
      use extension loops;
      export function foldScore(start, moves) {
        let total = start;
        for (const m of bounded(moves, 6)) {
          total = m == 'inc' ? total + 1 : (m == 'dec' ? total - 1 : total);
        }
        return total;
      }
    `;
    const loopFn = compileFunction(loopSrc);
    const loopMod = await loader.load(loopFn.standaloneModule().moduleSource, 's1c_loop');

    const policySrc = `
      use extension bounded;
      use extension derive;
      transition tally {
        derive {
          let total = bounded.fold(input.moves, before.score, (acc, m) => acc + m, 4);
          return { 'score': total, 'count': input.moves.size() };
        }
        require matchesScore {
          return after.score == derived.score && after.score >= 0;
        }
        require boundedMoves {
          let positives = bounded.count(input.moves, m => m > 0, 4);
          return positives >= 0 || false;
        }
      }
    `;
    const policy = compilePolicy(policySrc);
    const policyMod = await loader.load(policy.standaloneModule().moduleSource, 's1c_policy');
    const modJudge = policyMod.judge as (t: Transition) => Verdict;

    let executed = 0;
    for (let i = 0; i < 50; i++) {
      const start = rng.pick([0, 1, -5, 90, Number.MAX_SAFE_INTEGER]);
      const moves = Array.from({ length: rng.int(0, 6) }, () => rng.pick(['inc', 'dec', 'noop', 1]));
      const o1 = captureCall(() => loopFn(start, moves));
      const o2 = captureCall(() => loopMod.foldScore!(start, moves));
      expect(outcomesMatchWithSafeIntBridge(o1, o2), `loop case #${i}: interp=${safeJson(o1)} mod=${safeJson(o2)}`).toBe(true);
      executed++;
    }
    for (let i = 0; i < 50; i++) {
      const movesLen = rng.int(0, 6); // 5..6 triggers fatal ResourceLimitError (> 4)
      const moves = rng.bool(0.1)
        ? 'bad'
        : Array.from({ length: movesLen }, () => rng.pick([-2, 0, 1, 3, 'x']));
      const beforeScore = rng.pick([0, 1, 5, -1, -0.0]);
      const afterScore = rng.pick([0, 1, 2, 5, 6, 8, -1, 'bad']);
      const t: Transition = { before: { score: beforeScore }, after: { score: afterScore }, input: { moves } };
      const v1 = normalizeVerdict(policy.judge(t));
      const v2 = normalizeVerdict(modJudge(t));
      expect(verdictsMatch(v1, v2), `transition case #${i}: interp=${JSON.stringify(v1)} mod=${JSON.stringify(v2)}`).toBe(true);
      executed++;
    }
    expect(executed).toBe(100);
  }, 20000);

  test('Suite 1D: 56 hostile payload isolation checks reject without invoking getters across interpreter and ES module', async () => {
    const src = `
      use extension bounded;
      export function readField(x) { return x.a == 1; }
      export function passThrough(x) { return x == null; }
    `;
    const compiled = compileBoundedModule(src);
    const mod = await loader.load(compiled.moduleSource, 's1d');
    const interp = interpretModule(src);

    let checks = 0;
    for (const hostile of hostilePayloads()) {
      for (const fnName of ['readField', 'passThrough'] as const) {
        const h1 = hostile.build();
        const o1 = captureCall(() => interp[fnName]!(h1.payload));
        expect(h1.wasGetterInvoked(), `interpreter invoked getter on ${hostile.label}`).toBe(false);
        expect(o1.kind, `interpreter failed to reject ${hostile.label} in ${fnName}`).not.toBe('value');
        checks++;

        const h2 = hostile.build();
        const o2 = captureCall(() => mod[fnName]!(h2.payload));
        expect(h2.wasGetterInvoked(), `ES module invoked getter on ${hostile.label}`).toBe(false);
        expect(o2.kind, `ES module failed to reject ${hostile.label} in ${fnName}`).not.toBe('value');
        checks++;
      }
    }
    expect(checks).toBeGreaterThanOrEqual(56);
  }, 15000);

  test('Suite 2: 450 seeded Firestore policies agree across interpreter, ES module, and Firestore simulator', async () => {
    const rng = createRng(0x5eed2001);
    const TOTAL = 450;
    const POLICIES = 45;
    const INPUTS_PER_POLICY = TOTAL / POLICIES;
    let executed = 0;
    let loweredPolicies = 0;

    for (let p = 0; p < POLICIES; p++) {
      const prog = generateFirestoreTransition(rng);
      const src = printTransition(prog);
      const policy = compilePolicy(src);
      const mod = await loader.load(policy.standaloneModule().moduleSource, `fs_${p}`);
      const modJudge = mod.judge as (t: Transition) => Verdict;

      let policyLowered = false;
      for (let j = 0; j < INPUTS_PER_POLICY; j++) {
        const transition: Transition = {
          before: genFirestoreRecord(rng),
          after: genFirestoreRecord(rng),
          input: genFirestoreRecord(rng),
        };
        const vInterp = normalizeVerdict(policy.judge(transition));
        const vMod = normalizeVerdict(modJudge(transition));
        expect(verdictsMatch(vInterp, vMod), `Firestore policy #${p} case #${j} interp vs mod:\n${src}\nt=${JSON.stringify(transition)}\ninterp=${JSON.stringify(vInterp)} mod=${JSON.stringify(vMod)}`).toBe(true);

        const sim = simulateFirestorePolicy(src, transition);
        if (sim.lowered) {
          policyLowered = true;
          expect(sim.decision, `Firestore policy #${p} case #${j} interp vs sim:\n${src}\npred=${sim.predicate}\nt=${JSON.stringify(transition)}`).toBe(decisionOf(vInterp));
        }
        executed++;
      }
      if (policyLowered) loweredPolicies++;
    }
    expect(executed).toBe(TOTAL);
    expect(loweredPolicies).toBeGreaterThanOrEqual(35);
  }, 45000);

  test('Suite 3: 450 seeded RTDB policies agree across interpreter, ES module, and RTDB simulator', async () => {
    const rng = createRng(0x5eed3001);
    const TOTAL = 450;
    const POLICIES = 45;
    const INPUTS_PER_POLICY = TOTAL / POLICIES;
    let executed = 0;
    let loweredPolicies = 0;

    for (let p = 0; p < POLICIES; p++) {
      const prog = generateRtdbTransition(rng);
      const src = printTransition(prog);
      const policy = compilePolicy(src);
      const mod = await loader.load(policy.standaloneModule().moduleSource, `rtdb_${p}`);
      const modJudge = mod.judge as (t: Transition) => Verdict;

      let policyLowered = false;
      for (let j = 0; j < INPUTS_PER_POLICY; j++) {
        const before = genRtdbRecord(rng);
        const after = genRtdbRecord(rng);
        const transition: Transition = { before, after, input: {} };
        const vInterp = normalizeVerdict(policy.judge(transition));
        const vMod = normalizeVerdict(modJudge(transition));
        expect(verdictsMatch(vInterp, vMod), `RTDB policy #${p} case #${j} interp vs mod:\n${src}`).toBe(true);

        const sim = simulateRtdbPolicy(src, before, after);
        if (sim.lowered) {
          policyLowered = true;
          expect(sim.decision, `RTDB policy #${p} case #${j} interp vs sim:\n${src}\npred=${sim.predicate}\nbefore=${JSON.stringify(before)} after=${JSON.stringify(after)}`).toBe(decisionOf(vInterp));
        }
        executed++;
      }
      if (policyLowered) loweredPolicies++;
    }
    expect(executed).toBe(TOTAL);
    expect(loweredPolicies).toBeGreaterThanOrEqual(30);
  }, 45000);

  test('Suite 4: 450 seeded Storage policies agree across interpreter, ES module, and Storage simulator', async () => {
    const rng = createRng(0x5eed4001);
    const TOTAL = 450;
    const POLICIES = 45;
    const INPUTS_PER_POLICY = TOTAL / POLICIES;
    let executed = 0;
    let loweredPolicies = 0;

    for (let p = 0; p < POLICIES; p++) {
      const method: 'create' | 'update' = p % 2 === 0 ? 'create' : 'update';
      const prog = generateStorageTransition(rng, method);
      const src = printTransition(prog);
      const policy = compilePolicy(src);
      const mod = await loader.load(policy.standaloneModule().moduleSource, `st_${p}`);
      const modJudge = mod.judge as (t: Transition) => Verdict;

      let policyLowered = false;
      for (let j = 0; j < INPUTS_PER_POLICY; j++) {
        const simInput = genStorageInput(rng, method);
        const transition: Transition = {
          before: simInput.before ?? null,
          after: simInput.after,
          input: { auth: simInput.auth },
        };
        const vInterp = normalizeVerdict(policy.judge(transition));
        const vMod = normalizeVerdict(modJudge(transition));
        expect(verdictsMatch(vInterp, vMod), `Storage policy #${p} case #${j} interp vs mod:\n${src}\nt=${safeJson(transition)}\ninterp=${safeJson(vInterp)}\nmod=${safeJson(vMod)}`).toBe(true);

        const sim = simulateStoragePolicy(src, simInput);
        if (sim.lowered) {
          policyLowered = true;
          expect(sim.decision, `Storage policy #${p} case #${j} interp vs sim:\n${src}\npred=${sim.predicate}\ninput=${JSON.stringify(simInput)}`).toBe(decisionOf(vInterp));
        }
        executed++;
      }
      if (policyLowered) loweredPolicies++;
    }
    expect(executed).toBe(TOTAL);
    expect(loweredPolicies).toBeGreaterThanOrEqual(40);
  }, 45000);
});

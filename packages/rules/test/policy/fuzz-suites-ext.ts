// Focused suite runners and extended input generators backing differential-fuzz.test.ts.
// Keeps every test file well under 600 lines and strictly 7-bit ASCII.
import { expect } from 'bun:test';
import {
  compileBoundedModule,
  compileFunction,
  compilePolicy,
  createPolicyGuard,
  interpretModule,
  jsonBodyExtractor,
  type Transition,
  type Verdict,
} from '../../src/policy/index.js';
import type { SeededRng } from './fuzz-prng.js';
import {
  STORAGE_EDGE_MIMES,
  STORAGE_EDGE_PATHS,
  UNICODE_EDGE_STRINGS,
} from './fuzz-values.js';
import { extendedHostilePayloads } from './fuzz-hostile.js';
import {
  RE2_BACKTRACK_CASES,
  RE2_CURATED_PATTERNS,
  generateDeriveDagTransition,
  generateHelperDagModule,
  generateRe2Case,
  generateSplitPolicy,
  type SplitOrder,
  type SplitTarget,
} from './fuzz-generators-ext.js';
import {
  captureCall,
  detailedVerdictsMatch,
  normalizeVerdict,
  normalizeVerdictDetailed,
  outcomesMatch,
  outcomesMatchWithSafeIntBridge,
  prepareFirestoreSim,
  prepareRtdbSim,
  prepareStorageSim,
  verdictsMatch,
  type ModuleLoader,
  type StorageSimInput,
} from './fuzz-oracle.js';

export function safeJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() + 'n' : val));
}

export function genFirestoreExtRecord(rng: SeededRng): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const vals: readonly unknown[] = [
    0, -0.0, 1, -1, 2, 7, 1.5, -2.5,
    Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1,
    '', 'a', 'ab', 'ok', 'ABCd', 'text/\u000b', 'a1,b2', '  Hi  ',
    true, false, null, [1, 2], ['ok'], { owner: 'ok' },
  ];
  for (const key of ['x', 'y', 's', 'flag', 'tag']) {
    if (rng.bool(0.75)) out[key] = rng.pick(vals);
  }
  if (rng.bool(0.6)) out.items = rng.pick([[], ['ok'], [1, 2], ['ok', 3], 'bad']);
  if (rng.bool(0.6)) out.meta = rng.pick([{}, { owner: 'ok' }, { owner: 'go' }, null]);
  return out;
}

export function genRtdbExtRecord(
  rng: SeededRng,
  options: { allowNullRoot?: boolean; overflowMode?: boolean } = {},
): unknown {
  if (options.allowNullRoot && rng.bool(0.3)) return null;
  const out: Record<string, unknown> = {};
  const vals: readonly unknown[] = options.overflowMode
    ? [
        0, 1, -1, 2, -2, 1.5, -1.5,
        1000000000, -1000000000,
        Number.MAX_SAFE_INTEGER,
        Number.MIN_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER + 1,
        -(Number.MAX_SAFE_INTEGER + 1),
        'ok', true, false,
      ]
    : [
        0, 1, -1, 2, -2, 5, 7, 1.5, -1.5, -0.5, 42,
        '', 'a', 'ab', 'ok', 'hi', '\uD83D\uDE00',
        true, false,
      ];
  for (const key of ['x', 'y', 's', 'flag']) {
    if (rng.bool(0.72)) out[key] = rng.pick(vals);
  }
  return out;
}

export function genStorageExtInput(rng: SeededRng, method: 'create' | 'update'): StorageSimInput {
  const uids = ['alice', 'bob', 'carol', ''];
  const sizes = [0, 1, 32, 64, 512, 1024, 4096, 8192, 1048576, Number.MAX_SAFE_INTEGER];
  const path = rng.pick(STORAGE_EDGE_PATHS);
  const makeRes = () => {
    const metadata: Record<string, string> = {};
    if (rng.bool(0.72)) metadata.owner = rng.pick(uids);
    if (rng.bool(0.45)) metadata.tag = rng.pick(['clip', 'avatar', 'note', '']);
    if (rng.bool(0.25)) metadata.role = rng.pick(['admin', 'user']);
    return {
      size: rng.pick(sizes),
      contentType: rng.pick(STORAGE_EDGE_MIMES),
      name: path,
      metadata,
    };
  };
  const auth = rng.bool(0.72) ? { uid: rng.pick(uids) } : null;
  return {
    method,
    path,
    auth,
    ...(method === 'update' ? { before: makeRes() } : {}),
    after: makeRes(),
  };
}

export async function runDagAndDeriveSuite(
  loader: ModuleLoader,
  rng: SeededRng,
  counts: { dagModules: number; dagInputs: number; derivePolicies: number; deriveInputs: number; loopCases: number; builtinCases: number },
): Promise<number> {
  let executed = 0;

  for (let m = 0; m < counts.dagModules; m++) {
    const { source, entryName } = generateHelperDagModule(rng, m);
    const compiled = compileBoundedModule(source);
    const mod = await loader.load(compiled.moduleSource, `dagm_${m}`);
    const interp = interpretModule(source);
    for (let j = 0; j < counts.dagInputs; j++) {
      const mkList = () =>
        rng.bool(0.12)
          ? rng.pick(['bad', null, 42])
          : Array.from({ length: rng.int(0, 6) }, () => rng.pick([-3, -1, 0, 1, 2, 5, 1.5, -0.0, 'x', null]));
      const xs = mkList();
      const ys = mkList();
      const seed = rng.pick([-2, -0.0, 0, 1, 3, 7, 1.5, 'bad', null, Number.MAX_SAFE_INTEGER]);
      const o1 = captureCall(() => interp[entryName]!(xs, ys, seed));
      const o2 = captureCall(() => mod[entryName]!(xs, ys, seed));
      expect(outcomesMatch(o1, o2), `DAG module #${m} input #${j}:\n${source}\nargs=${safeJson([xs, ys, seed])}\ninterp=${safeJson(o1)}\nmod=${safeJson(o2)}`).toBe(true);
      executed++;
    }
  }

  for (let p = 0; p < counts.derivePolicies; p++) {
    const { source } = generateDeriveDagTransition(rng, p);
    const policy = compilePolicy(source);
    const mod = await loader.load(policy.standaloneModule().moduleSource, `dagt_${p}`);
    const modJudge = mod.judge as (t: Transition) => Verdict;
    for (let j = 0; j < counts.deriveInputs; j++) {
      const mkList = () =>
        rng.bool(0.1)
          ? 'bad'
          : Array.from({ length: rng.int(0, 6) }, () => rng.pick([-2, 0, 1, 3, 99, 'x']));
      const t: Transition = {
        before: { score: rng.pick([-2, -0.0, 0, 1, 5, 'bad']) },
        after: { score: rng.pick([-2, 0, 1, 2, 4, 6, 8, 'bad']), flag: rng.pick([true, false, null]) },
        input: { xs: mkList(), ys: mkList() },
      };
      const v1 = normalizeVerdictDetailed(policy.judge(t));
      const v2 = normalizeVerdictDetailed(modJudge(t));
      expect(detailedVerdictsMatch(v1, v2), `Derive DAG #${p} input #${j}:\n${source}\nt=${safeJson(t)}\ninterp=${safeJson(v1)}\nmod=${safeJson(v2)}`).toBe(true);
      executed++;
    }
  }

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
  const loopMod = await loader.load(loopFn.standaloneModule().moduleSource, 'loop_fold');
  for (let i = 0; i < counts.loopCases; i++) {
    const start = rng.pick([0, 1, -5, 90, Number.MAX_SAFE_INTEGER]);
    const moves = rng.bool(0.1)
      ? 'not-list'
      : Array.from({ length: rng.int(0, 8) }, () => rng.pick(['inc', 'dec', 'noop', 1]));
    const o1 = captureCall(() => loopFn(start, moves));
    const o2 = captureCall(() => loopMod.foldScore!(start, moves));
    expect(outcomesMatchWithSafeIntBridge(o1, o2), `loop #${i}: interp=${safeJson(o1)} mod=${safeJson(o2)}`).toBe(true);
    executed++;
  }

  const builtinsSrc = `
    use extension bounded;
    export function mathPack(x, y) { return [math.abs(x), math.ceil(x), math.floor(x), math.round(x), math.isNaN(x), math.pow(x, y)]; }
    export function convPack(x) { return [int(x), float(x), string(x)]; }
    export function setPack(a, b) {
      let sa = a.toSet();
      let sb = b.toSet();
      return [sa.size(), sa.union(sb).size(), sa.intersection(sb).size(), sa.difference(sb).size(), sa == sb];
    }
    export function diffPack(a, b) {
      let d = b.diff(a);
      return [d.addedKeys().size(), d.changedKeys().size(), d.removedKeys().size(), d.unchangedKeys().size()];
    }
    export function timePack(ms, sec) {
      let t = timestamp.value(ms);
      let d = duration.value(sec, 's');
      let u = t + d;
      return [t.year(), t.month(), t.day(), t.seconds(), u.toMillis(), duration.abs(d).seconds()];
    }
    export function bytesPack(s) { let b = s.toUtf8(); return [b.size(), b.toBase64(), b.toHexString()]; }
    export function slicePack(x, a, b) { return x[a:b]; }
  `;
  const bMod = await loader.load(compileBoundedModule(builtinsSrc).moduleSource, 'builtins');
  const bInterp = interpretModule(builtinsSrc);
  const nums: readonly unknown[] = [
    -2.5, -1.5, -0.5, -0.0, 0, 0.5, 1, 1.5, 2.5, Number.NaN, Infinity, -Infinity,
    1e-4, 1e-3, 1e7, 9007199254740991, 9007199254740992, 9007199254740993n,
  ];
  for (let i = 0; i < counts.builtinCases; i++) {
    const k = i % 7;
    let fnName: string;
    let args: unknown[];
    if (k === 0) {
      fnName = 'mathPack';
      args = [rng.pick(nums), rng.pick([-1, 0, 0.5, 2, 3, Number.NaN])];
    } else if (k === 1) {
      fnName = 'convPack';
      args = [rng.pick([...nums, '+1', '-0', '1.0f', ' 1.5 ', 'bad', true, null])];
    } else if (k === 2) {
      fnName = 'setPack';
      args = [
        [rng.pick(nums), rng.pick(nums)],
        [rng.pick(nums), rng.pick(nums)],
      ];
    } else if (k === 3) {
      fnName = 'diffPack';
      args = [{ a: rng.pick(nums), b: rng.pick([1, 'x']) }, { a: rng.pick(nums), c: 2 }];
    } else if (k === 4) {
      fnName = 'timePack';
      args = [rng.pick([0, -1, -1001, 1700000000123, -62135596800000, 253402300799999]), rng.pick([-90, 0, 60, 3600])];
    } else if (k === 5) {
      fnName = 'bytesPack';
      args = [rng.pick(UNICODE_EDGE_STRINGS)];
    } else {
      fnName = 'slicePack';
      args = [rng.pick(['', 'abc', 'a\uD83D\uDE00b', [1, 2, 3]]), rng.int(-1, 3), rng.int(-1, 4)];
    }
    const o1 = captureCall(() => bInterp[fnName]!(...args));
    const o2 = captureCall(() => bMod[fnName]!(...args));
    expect(outcomesMatch(o1, o2), `builtin #${i} ${fnName}(${safeJson(args)}): interp=${safeJson(o1)} mod=${safeJson(o2)}`).toBe(true);
    executed++;
  }
  return executed;
}

export async function runHostileAndBudgetSuite(loader: ModuleLoader, rng: SeededRng): Promise<number> {
  const modSrc = `
    use extension bounded;
    export function readField(x) { return x.a == 1; }
    export function passThrough(x) { return x == null; }
  `;
  const compiled = compileBoundedModule(modSrc);
  const mod = await loader.load(compiled.moduleSource, 'hostile_mod');
  const interp = interpretModule(modSrc);

  const policySrc = 'transition guard { require r { return after.a == 1; } }';
  const policy = compilePolicy(policySrc);
  const pMod = await loader.load(policy.standaloneModule().moduleSource, 'hostile_pol');
  const pModJudge = pMod.judge as (t: Transition) => Verdict;
  const guardInterp = createPolicyGuard(policySrc, { engine: 'interpreter' });
  const guardStand = createPolicyGuard(policySrc, { engine: 'standalone' });

  let checks = 0;
  for (const hostile of extendedHostilePayloads()) {
    for (const fnName of ['readField', 'passThrough'] as const) {
      const h1 = hostile.build();
      const o1 = captureCall(() => interp[fnName]!(h1.payload));
      expect(h1.wasGetterInvoked(), `interp getter on ${hostile.label}`).toBe(false);
      expect(o1.kind, `interp must reject ${hostile.label}`).not.toBe('value');
      expect(o1.kind, `interp unexpected crash on ${hostile.label}: ${safeJson(o1)}`).not.toBe('unexpected-error');
      checks++;

      const h2 = hostile.build();
      const o2 = captureCall(() => mod[fnName]!(h2.payload));
      expect(h2.wasGetterInvoked(), `module getter on ${hostile.label}`).toBe(false);
      expect(o2.kind, `module must reject ${hostile.label}`).not.toBe('value');
      expect(o2.kind, `module unexpected crash on ${hostile.label}: ${safeJson(o2)}`).not.toBe('unexpected-error');
      expect(o2.kind, `hostile error class mismatch on ${hostile.label}`).toBe(o1.kind);
      checks++;
    }
    for (const [label, fn] of [
      ['policy.judge', (p: unknown) => policy.judge({ before: {}, after: p, input: {} })],
      ['standalone.judge', (p: unknown) => pModJudge({ before: {}, after: p, input: {} })],
      ['guard.interp', (p: unknown) => guardInterp.check({ before: {}, after: p, input: {} })],
      ['guard.stand', (p: unknown) => guardStand.check({ before: {}, after: p, input: {} })],
    ] as const) {
      const built = hostile.build();
      const out = captureCall(() => fn(built.payload));
      expect(built.wasGetterInvoked(), `${label} invoked getter on ${hostile.label}`).toBe(false);
      expect(out.kind, `${label} must reject ${hostile.label}`).not.toBe('value');
      expect(out.kind, `${label} unexpected crash on ${hostile.label}`).not.toBe('unexpected-error');
      checks++;
    }
  }

  // Proxy get-trap must never be invoked during own-descriptor copy; throwing descriptor trap rejects.
  for (const [label, run] of [
    ['interp-proxy', (p: unknown) => interp.passThrough!(p)],
    ['mod-proxy', (p: unknown) => mod.passThrough!(p)],
  ] as const) {
    let getHit = false;
    const silentProxy = new Proxy({ a: 1 }, {
      get() {
        getHit = true;
        return 99;
      },
    });
    run(silentProxy);
    expect(getHit, `${label} invoked Proxy.get`).toBe(false);
    checks++;

    const throwingProxy = new Proxy({ a: 1 }, {
      getOwnPropertyDescriptor() {
        throw new Error('trap-denied');
      },
    });
    expect(() => run(throwingProxy), `${label} throwing proxy must reject`).toThrow(/trap-denied/);
    checks++;
  }

  // jsonBodyExtractor rejects forbidden prototype keys and oversize payloads.
  const extract = jsonBodyExtractor({ maxBodyBytes: 256 });
  for (const rawBody of [
    '{"after":{"__proto__":{"admin":true}}}',
    '{"after":{"constructor":{"x":1}}}',
    '{"after":{"prototype":{"x":1}}}',
    '{"after":{"nested":[{"__proto__":1}]}}',
    '{"after":"' + 'x'.repeat(300) + '"}',
    'not-json',
    '[1,2,3]',
  ]) {
    const req = new Request('https://policy.invalid/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: rawBody,
    });
    let rejected = false;
    try {
      await extract(req);
    } catch {
      rejected = true;
    }
    expect(rejected, `jsonBodyExtractor accepted hostile body: ${rawBody.slice(0, 40)}`).toBe(true);
    checks++;
  }

  // Tight expressionLimit budget sweeps: fatal tick exhaustion must NEVER absorb under || true or && false.
  const budgetSrc = `
    use extension bounded;
    transition tight {
      require r {
        return (bounded.count(input.xs, x => (x + 1) > 0, 50) >= 0) || true;
      }
    }
  `;
  const tightPol = compilePolicy(budgetSrc, { expressionLimit: 8 });
  const tightMod = await loader.load(tightPol.standaloneModule().moduleSource, 'tight_budget');
  const tightJudge = tightMod.judge as (t: Transition) => Verdict;
  for (let i = 0; i < 60; i++) {
    const len = rng.int(12, 40);
    const xs = Array.from({ length: len }, (_, k) => k);
    const v1 = normalizeVerdictDetailed(tightPol.judge({ before: {}, after: {}, input: { xs } }));
    const v2 = normalizeVerdictDetailed(tightJudge({ before: {}, after: {}, input: { xs } }));
    expect(v1.kind, `interp budget exhaustion must be fatal at len=${len}`).toBe('resource-limit');
    expect(v2.kind, `standalone budget exhaustion must be fatal at len=${len}`).toBe('resource-limit');
    checks += 2;
  }

  return checks;
}

export async function runRe2ParitySuite(loader: ModuleLoader, rng: SeededRng, total: number): Promise<number> {
  const src = `
    use extension bounded;
    export function m(s, p) { return s.matches(p); }
    export function absorb(s, p) { return s.matches(p) || true; }
    export function sp(s, p) { return s.split(p); }
    export function rp(s, p, r) { return s.replace(p, r); }
  `;
  const compiled = compileBoundedModule(src);
  const mod = await loader.load(compiled.moduleSource, 're2_suite');
  const interp = interpretModule(src);
  let executed = 0;

  const verify = (tag: string, fn: 'm' | 'absorb' | 'sp' | 'rp', args: unknown[]) => {
    const o1 = captureCall(() => interp[fn]!(...args));
    const o2 = captureCall(() => mod[fn]!(...args));
    expect(outcomesMatch(o1, o2), `RE2 ${tag} ${fn}(${safeJson(args)}):\ninterp=${safeJson(o1)}\nmod=${safeJson(o2)}`).toBe(true);
    executed++;
  };

  // Exhaustive curated backtracking linear-time guard (each call must stay well under 250ms).
  for (const [subj, pat] of RE2_BACKTRACK_CASES) {
    const t0 = performance.now();
    verify('backtrack', 'm', [subj, pat]);
    expect(performance.now() - t0, `Backtracking stall on ${pat}`).toBeLessThan(250);
  }

  // Deterministic surrogate zero-width split & replace sweep.
  const surrSubjects = ['\uD83D\uDE00', 'a\uD83D\uDE00b', '\uD83D\uDE00\uD83D\uDE01', '\uD800', '\uDC00'];
  const zwPatterns = ['', '^', '$', '\\A', '\\z', '\\b', '(?m)^', 'a*'];
  for (const s of surrSubjects) {
    for (const p of zwPatterns) {
      verify('surr-sp', 'sp', [s, p]);
      verify('surr-rp', 'rp', [s, p, '#']);
    }
  }

  // Deterministic pass over every curated pattern against a representative subject.
  for (const pat of RE2_CURATED_PATTERNS) {
    const s = rng.pick(UNICODE_EDGE_STRINGS);
    verify('curated-m', 'm', [s, pat]);
    verify('curated-abs', 'absorb', [s, pat]);
  }

  // Seeded random fuzz up to exact `total`.
  while (executed < total) {
    const c = generateRe2Case(rng);
    if (c.op === 'matches') verify('fuzz', 'm', [c.subject, c.pattern]);
    else if (c.op === 'absorb') verify('fuzz', 'absorb', [c.subject, c.pattern]);
    else if (c.op === 'split') verify('fuzz', 'sp', [c.subject, c.pattern]);
    else verify('fuzz', 'rp', [c.subject, c.pattern, c.replacement]);
  }
  return executed;
}

export async function runSplitEnforcementSuite(
  loader: ModuleLoader,
  rng: SeededRng,
  perTarget: number,
): Promise<{ executed: number; firestore: number; rtdb: number; storage: number; fatalChecked: number }> {
  const targets: readonly SplitTarget[] = ['firestore', 'rtdb', 'storage'];
  const orders: readonly SplitOrder[] = ['db-first', 'gateway-first', 'interleaved'];
  const policiesPerTarget = 20;
  const inputsPerPolicy = perTarget / policiesPerTarget;
  const counts = { executed: 0, firestore: 0, rtdb: 0, storage: 0, fatalChecked: 0 };

  for (const target of targets) {
    for (let p = 0; p < policiesPerTarget; p++) {
      const order = orders[p % orders.length]!;
      const spec = generateSplitPolicy(rng, target, order);
      const fullPol = compilePolicy(spec.fullSource);
      const resPol = compilePolicy(spec.residualSource);
      const fullMod = await loader.load(fullPol.standaloneModule().moduleSource, `sp_f_${target}_${p}`);
      const resMod = await loader.load(resPol.standaloneModule().moduleSource, `sp_r_${target}_${p}`);
      const fullJudge = fullMod.judge as (t: Transition) => Verdict;
      const resJudge = resMod.judge as (t: Transition) => Verdict;

      const fsSim = target === 'firestore' ? prepareFirestoreSim(spec.fullSource, { allowPartial: true }) : undefined;
      const rtSim = target === 'rtdb' ? prepareRtdbSim(spec.fullSource, { allowPartial: true }) : undefined;
      const stSim = target === 'storage' ? prepareStorageSim(spec.fullSource, spec.method!, { allowPartial: true, wildcard: true }) : undefined;
      const expectedDbCount = spec.orderKinds.filter((k) => k === 'db').length;
      const actualDbCount = (fsSim ?? rtSim ?? stSim)!.loweredRequirements.length;
      expect(actualDbCount, `Split policy ${target}#${p} (${order}) failed to lower DB reqs:\n${spec.fullSource}`).toBe(expectedDbCount);

      for (let j = 0; j < inputsPerPolicy; j++) {
        const items = rng.bool(0.1)
          ? 'bad'
          : Array.from({ length: rng.int(0, 5) }, () => rng.pick([-1, 0, 1, 2, 'bad']));
        let transition: Transition;
        let dbDecision: 'ALLOW' | 'DENY';
        if (target === 'firestore') {
          transition = {
            before: { x: rng.pick([0, 1, 5, 'bad']) },
            after: { x: rng.pick([-1, 0, 1, 2, 6, 150, 'bad']), tag: rng.pick(['ok', 'go', 'no']), flag: rng.pick([true, false, null]) },
            input: { items },
          };
          dbDecision = fsSim!.simulate(transition);
        } else if (target === 'rtdb') {
          const before: Record<string, unknown> = rng.bool(0.8) ? { x: rng.pick([0, 1, 5]) } : {};
          const after: Record<string, unknown> = {};
          if (rng.bool(0.8)) after.x = rng.pick([-1, 0, 1, 2, 6, 150, 1.5, 'bad']);
          if (rng.bool(0.6)) after.y = rng.pick([-1, 0, 2, 'bad']);
          if (rng.bool(0.7)) after.flag = rng.pick([true, false]);
          if (rng.bool(0.7)) after.s = rng.pick(['', 'a', 'ok', 'toolongstring']);
          transition = { before, after, input: { items } };
          dbDecision = rtSim!.simulate(before, after);
        } else {
          const base = genStorageExtInput(rng, spec.method!);
          const auth = base.auth ? { uid: base.auth.uid, token: { items } } : null;
          const stInput: StorageSimInput = { ...base, auth };
          transition = { before: stInput.before ?? null, after: stInput.after, input: { auth } };
          dbDecision = stSim!.simulate(stInput);
        }

        const vFullInterp = normalizeVerdictDetailed(fullPol.judge(transition));
        const vFullMod = normalizeVerdictDetailed(fullJudge(transition));
        const vResInterp = normalizeVerdictDetailed(resPol.judge(transition));
        const vResMod = normalizeVerdictDetailed(resJudge(transition));

        expect(detailedVerdictsMatch(vFullInterp, vFullMod), `Split full mismatch ${target}#${p}.${j}`).toBe(true);
        expect(detailedVerdictsMatch(vResInterp, vResMod), `Split residual mismatch ${target}#${p}.${j}`).toBe(true);
        expect(verdictsMatch(normalizeVerdict(fullPol.judge(transition)), normalizeVerdict(fullJudge(transition)))).toBe(true);

        // Allow equivalence: (dbPredicate && gatewayResidual) === fullStandalone.
        const splitAllowed = dbDecision === 'ALLOW' && vResMod.kind === 'allow';
        expect(
          splitAllowed,
          `Split allow parity failed (${target} ${order} #${p}.${j}): db=${dbDecision} res=${safeJson(vResMod)} full=${safeJson(vFullInterp)}\n${spec.fullSource}\nt=${safeJson(transition)}`,
        ).toBe(vFullInterp.kind === 'allow');

        // Fatal ResourceLimitError preservation: when full evaluation is fatal,
        // residual MUST also be fatal (never downgraded to non-fatal deny).
        if (vFullInterp.kind === 'resource-limit') {
          expect(vResMod.kind, `Fatal budget lost in split residual (${target} ${order} #${p}.${j})`).toBe('resource-limit');
          counts.fatalChecked++;
        }
        // Reverse order guarantee: when gateway is ordered FIRST and residual is fatal,
        // full evaluation MUST be fatal even when dbDecision === 'DENY'.
        if (order === 'gateway-first' && vResMod.kind === 'resource-limit') {
          expect(vFullInterp.kind, `Gateway-first fatal swallowed by DB deny (${target} #${p}.${j})`).toBe('resource-limit');
          expect(vFullMod.kind, `Gateway-first fatal swallowed in standalone (${target} #${p}.${j})`).toBe('resource-limit');
        }

        counts.executed++;
        counts[target]++;
      }
    }
  }
  return counts;
}

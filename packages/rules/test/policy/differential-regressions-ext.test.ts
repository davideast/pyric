// Permanent shrunk regression pins for every compiler bug discovered while scaling
// the multi-engine differential fuzzer past 10,000 cases.
// Strictly 7-bit ASCII: all non-ASCII test data uses \uXXXX escapes.
import { afterAll, describe, expect, test } from 'bun:test';
import {
  compileBoundedModule,
  compileFunction,
  compilePolicy,
  interpretModule,
  type RtdbBindings,
  type Transition,
  type Verdict,
} from '../../src/policy/index.js';
import { rtdbRules } from '../../src/api/rtdb.js';
import {
  captureCall,
  classifyError,
  createModuleLoader,
  decisionOf,
  defaultFirestoreBindings,
  normalizeVerdict,
  normalizeVerdictDetailed,
  outcomesMatch,
  outcomesMatchWithSafeIntBridge,
  prepareFirestoreSim,
  prepareRtdbSim,
  prepareStorageSim,
  simulateFirestorePolicy,
  simulateRtdbPolicy,
  simulateStoragePolicy,
} from './fuzz-oracle.js';

const loader = createModuleLoader('pyric-diff-reg-ext-');
afterAll(() => loader.cleanup());

function evalRtdbValidate(predicate: string, after: Record<string, unknown>): 'ALLOW' | 'DENY' {
  const ruleset = rtdbRules({ rules: { item: { '.write': 'newData.exists()', '.validate': predicate } } });
  const wire = Object.keys(after).length ? after : { _keep: true };
  return ruleset.simulate([
    { path: '/item', operation: 'write', expectation: 'ALLOW', data: { item: { _keep: true } }, newData: wire },
  ]).cases[0]!.decision as 'ALLOW' | 'DENY';
}

describe('10K differential fuzzer shrunk permanent regressions', () => {
  test('Reg-A1: RTDB compound `is bool` emits Kleene definedness guard instead of literal true', () => {
    const cases: readonly { src: string; after: Record<string, unknown>; want: 'ALLOW' | 'DENY' }[] = [
      { src: 'transition t { require r { return (after.x > 0 || after.y > 0) is bool; } }', after: {}, want: 'DENY' },
      { src: 'transition t { require r { return (after.x > 0 || after.y > 0) is bool; } }', after: { x: 1 }, want: 'ALLOW' },
      { src: 'transition t { require r { return (after.x > 0 || after.y > 0) is bool; } }', after: { x: -1 }, want: 'DENY' },
      { src: 'transition t { require r { return (after.x > 0 || after.y > 0) is bool; } }', after: { x: -1, y: -2 }, want: 'ALLOW' },
      { src: 'transition t { require r { return (after.x > 0 && after.y > 0) is bool; } }', after: {}, want: 'DENY' },
      { src: 'transition t { require r { return (after.x > 0 && after.y > 0) is bool; } }', after: { x: -1 }, want: 'ALLOW' },
      { src: 'transition t { require r { return (after.flag ? after.x > 0 : after.y > 0) is bool; } }', after: {}, want: 'DENY' },
      { src: 'transition t { require r { return (after.flag ? after.x > 0 : after.y > 0) is bool; } }', after: { flag: true, x: 2 }, want: 'ALLOW' },
      { src: 'transition t { require r { return (after.x > after.y) is bool; } }', after: {}, want: 'DENY' },
      { src: 'transition t { require r { return (after.x > after.y) is bool; } }', after: { x: 1, y: 2 }, want: 'ALLOW' },
      { src: 'transition t { require r { return !((after.x > 0 || after.y > 0) is bool); } }', after: {}, want: 'DENY' },
      { src: 'transition t { require r { return !((after.x > 0 || after.y > 0) is bool); } }', after: { x: 1 }, want: 'DENY' },
      { src: 'transition t { require r { return (after.x == 1) is bool; } }', after: {}, want: 'DENY' },
      { src: 'transition t { require r { return (after.x == 1) is bool; } }', after: { x: 'hello' }, want: 'ALLOW' },
    ];
    for (const c of cases) {
      const pol = compilePolicy(c.src);
      const want = decisionOf(normalizeVerdict(pol.judge({ before: {}, after: c.after, input: {} })));
      expect(want, c.src).toBe(c.want);
      const sim = simulateRtdbPolicy(c.src, {}, c.after);
      expect(sim.lowered, c.src).toBe(true);
      expect(sim.decision, `${c.src} after=${JSON.stringify(c.after)} pred=${sim.predicate}`).toBe(c.want);
    }

    // Child snapshot `(after.x is int) is bool` cannot distinguish missing vs null when negated;
    // must safely fall back to gateway-only instead of lowering to literal true.
    const childIsInt = compilePolicy('transition t { require r { return (after.x is int) is bool; } }');
    expect(childIsInt.rtdb({ after: 'newData' }, 'mixed')[0]?.predicate).toBeUndefined();
  });

  test('Reg-A2: RTDB ternary boundTerm checks branch bounds conditionally even when input guards match', () => {
    const src = 'transition t { require r { return (after.flag ? after.x * after.x : after.x + 1) > 0; } }';
    const allow = simulateRtdbPolicy(src, {}, { flag: false, x: 1000000000 });
    expect(allow.lowered).toBe(true);
    expect(allow.decision).toBe('ALLOW');

    // Taken overflowing branch remains safely fail-closed.
    const deny = simulateRtdbPolicy(src, {}, { flag: true, x: 1000000000 });
    expect(deny.lowered).toBe(true);
    expect(deny.decision).toBe('DENY');
  });

  test('Reg-A3 & Reg-A4: RTDB typed boolean ternaries and exact dotted child bindings enforce Kleene/exists guards', () => {
    const bindings: RtdbBindings = {
      'after.cond': { snapshot: 'newData', path: 'cond', type: 'boolean' },
      'after.cond2': { snapshot: 'newData', path: 'cond2', type: 'boolean' },
      'after.flag': { snapshot: 'newData', path: 'flag', type: 'boolean' },
      'after.flag2': { snapshot: 'newData', path: 'flag2', type: 'boolean' },
      'after.u': { snapshot: 'newData', path: 'u', type: 'any' },
      'after.x': { snapshot: 'newData', path: 'x', type: 'any' },
    };

    const failOpenChecks: readonly { body: string; after: Record<string, unknown>; want: 'ALLOW' | 'DENY' }[] = [
      { body: 'return (after.cond ? after.flag : true) != null;', after: {}, want: 'DENY' },
      { body: 'return !((after.cond ? after.flag : true) == null);', after: {}, want: 'DENY' },
      { body: 'return (after.cond ? after.flag : true) != null;', after: { cond: false }, want: 'ALLOW' },
      { body: 'return (after.cond ? after.flag : true) != null;', after: { cond: true }, want: 'DENY' },
      { body: 'return (after.cond ? after.flag : true) == null;', after: {}, want: 'DENY' },
      { body: 'return (after.cond ? after.flag : true) == (after.cond2 ? after.flag2 : true);', after: {}, want: 'DENY' },
      { body: 'return (after.cond ? after.flag : true) == (after.cond2 ? after.flag2 : true);', after: { cond: false, cond2: false }, want: 'ALLOW' },
      { body: 'return (after.cond ? after.flag : true) != (after.cond2 ? after.flag2 : true);', after: { cond: true, flag: false, cond2: false }, want: 'ALLOW' },
      { body: 'return after.u != (after.cond ? after.flag : true);', after: { u: true }, want: 'DENY' },
      { body: 'return after.u != (after.cond ? after.flag : true);', after: { cond: false }, want: 'DENY' },
      { body: 'return after.u != (after.cond ? after.flag : true);', after: { cond: false, u: false }, want: 'ALLOW' },
      { body: 'return (after.cond ? after.flag : true) != after.u;', after: { cond: false }, want: 'DENY' },
      { body: 'let t = after.cond ? after.flag : true; return after.u != t;', after: { cond: false }, want: 'DENY' },
      { body: 'return after.u != true;', after: {}, want: 'DENY' },
      { body: 'return after.u != true;', after: { u: 'hello' }, want: 'ALLOW' },
      { body: 'return (after.x == 1) is bool;', after: {}, want: 'DENY' },
      { body: 'return (after.x == 1) is bool;', after: { x: 'hello' }, want: 'ALLOW' },
    ];
    for (const c of failOpenChecks) {
      const src = `transition t { require r { ${c.body} } }`;
      const pol = compilePolicy(src);
      expect(decisionOf(normalizeVerdict(pol.judge({ before: {}, after: c.after, input: {} }))), c.body).toBe(c.want);
      const row = pol.rtdb(bindings, 'mixed')[0]!;
      expect(row.predicate, c.body).toBeDefined();
      expect(evalRtdbValidate(row.predicate!, c.after), `${c.body} after=${JSON.stringify(c.after)}`).toBe(c.want);
    }

    // Exact dotted child bindings must NOT be treated as root bindings for `== null` or negated `is`.
    for (const body of [
      'return after.x == null;',
      'return !(after.x is int);',
      'return (after.x is int) is bool;',
    ]) {
      const pol = compilePolicy(`transition t { require r { ${body} } }`);
      expect(pol.rtdb(bindings, 'mixed')[0]?.predicate, body).toBeUndefined();
    }
  });

  test('Reg-A5: standalone RE2 parity for \\Q...\\E flags, hex bounds, surrogates, \\s vs \\v, quantifiers, escapes, octals, orbits, and group names', async () => {
    const src = `
      use extension bounded;
      export function m(s, p) { return s.matches(p); }
      export function absorb(s, p) { return s.matches(p) || true; }
      export function sp(s, p) { return s.split(p); }
      export function rp(s, p, r) { return s.replace(p, r); }
    `;
    const mod = await loader.load(compileBoundedModule(src).moduleSource, 'reg_a5');
    const interp = interpretModule(src);

    const expectEq = (fn: 'm' | 'absorb' | 'sp' | 'rp', args: unknown[], want?: unknown) => {
      const o1 = captureCall(() => interp[fn]!(...args));
      const o2 = captureCall(() => mod[fn]!(...args));
      expect(outcomesMatch(o1, o2), `${fn}(${JSON.stringify(args)}): interp=${JSON.stringify(o1)} mod=${JSON.stringify(o2)}`).toBe(true);
      if (want !== undefined) {
        expect(o1.kind).toBe('value');
        if (o1.kind === 'value') expect(o1.value).toEqual(want);
      }
    };

    // 1. \Q...\E captures immutable ci snapshot.
    expectEq('m', ['ABCd', '\\Qabc\\E(?i)d'], false);
    expectEq('m', ['abcD', '\\Qabc\\E(?i)d'], true);
    expectEq('m', ['ABCd', '(?i)\\Qabc\\E(?-i)d'], true);
    expectEq('m', ['ABcd', '(?i)\\Qabc\\E(?-i)d'], true);
    expectEq('m', ['abcD', '(?i)\\Qabc\\E(?-i)d'], false);

    // 2. Out-of-range and >8-digit hex escapes raise RuleError (absorbed by || true), never RangeError.
    expectEq('absorb', ['a', '\\x{110000}'], true);
    expectEq('absorb', ['a', '\\x{000000001}'], true);
    expect(captureCall(() => mod.m!('a', '\\x{110000}')).kind).toBe('eval-error');

    // 3. Surrogate pair mid-codepoint assertions do not split or double-match ^ / \A / (?m)^.
    for (const pat of ['^', '\\A', '(?m)^']) {
      expectEq('sp', ['\uD83D\uDE00', pat], ['\uD83D\uDE00']);
      expectEq('rp', ['\uD83D\uDE00', pat, '#'], '#\uD83D\uDE00');
      expectEq('sp', ['\uD83D\uDE00\uD83D\uDE01', pat], ['\uD83D\uDE00\uD83D\uDE01']);
      expectEq('rp', ['\uD83D\uDE00\uD83D\uDE01', pat, '#'], '#\uD83D\uDE00\uD83D\uDE01');
    }

    // 4. \s excludes \v while POSIX [[:space:]] includes \v.
    expectEq('m', ['\u000b', '\\s'], false);
    expectEq('m', ['\u000b', '\\S'], true);
    expectEq('m', ['\u000b', '[[:space:]]'], true);

    // 5-6. Stacked quantifiers and quantified assertions / inline flags rejected; ()* allowed.
    for (const bad of ['a**', 'a++', 'a{1,2}{1,2}', 'a{1,2}??', '^*a', '$*', '\\b+', '\\B*', '\\A+', '\\z*', '(?i)*']) {
      expectEq('m', ['a', bad]);
      expect(captureCall(() => mod.m!('a', bad)).kind, bad).toBe('eval-error');
    }
    expectEq('m', ['', '()*'], true);

    // 7-8. Invalid ASCII escapes rejected; 2-digit octals rejected outside [...] and accepted inside [...].
    for (const bad of ['\\Z', '\\c', '\\e', '\\h', '\\u', '\\E', '[\\b]', '[\\Z]', '[\\1]', '\\10', '\\77', '\\400']) {
      expectEq('m', ['a', bad]);
      expect(captureCall(() => mod.m!('a', bad)).kind, bad).toBe('eval-error');
    }
    expectEq('m', ['\x08', '[\\10]'], true);
    expectEq('m', ['?', '[\\77]'], true);
    expectEq('m', [' ', '[\\400]'], true);
    expectEq('m', ['?', '\\077'], true);

    // 9. Unicode simple case-folding orbits and property/script classes.
    expectEq('m', ['\u017f', '(?i)s'], true);
    expectEq('m', ['\u03c2', '(?i)\u03c3'], true);
    expectEq('m', ['\u212a', '(?i)k'], true);
    expectEq('m', ['\u1e9e', '(?i)\u00df'], true);
    expectEq('m', ['A', '(?i)\\p{Ll}'], true);
    expectEq('m', ['\u03c3', '\\p{Greek}'], true);
    expectEq('m', ['a', '\\p{^Greek}'], true);
    expectEq('m', ['a', '\\pL'], true);
    expect(captureCall(() => mod.m!('a', '\\pX')).kind).toBe('eval-error');

    // 10. Duplicate and invalid named capture groups rejected.
    for (const bad of ['(?P<tag>a+)(?P<tag>a+)', '(?P<a>a)(?<a>a)', '(?<1a>a)', '(?P<1a>a)', '(?<>a)']) {
      expectEq('m', ['aa', bad]);
      expect(captureCall(() => mod.m!('aa', bad)).kind, bad).toBe('eval-error');
    }

    // End-to-end Firestore & Storage parity for \Q...\E and \s vs \v.
    const fsSrc = 'use extension methods; transition t { require r { return after.s.matches("\\\\Qabc\\\\E(?i)d"); } }';
    const fsPol = compilePolicy(fsSrc);
    const fsMod = await loader.load(fsPol.standaloneModule().moduleSource, 'reg_a5_fs');
    const fsT: Transition = { before: {}, after: { s: 'ABCd' }, input: {} };
    expect(fsPol.judge(fsT).ok).toBe(false);
    expect((fsMod.judge as (t: Transition) => Verdict)(fsT).ok).toBe(false);
    expect(simulateFirestorePolicy(fsSrc, fsT).decision).toBe('DENY');

    const stSrc = 'use extension methods; transition t { require r { return after.contentType.matches("^text/\\\\s+plain$"); } }';
    const stPol = compilePolicy(stSrc);
    const stMod = await loader.load(stPol.standaloneModule().moduleSource, 'reg_a5_st');
    const stAfter = { size: 1, contentType: 'text/\u000bplain', name: 'items/obj1', metadata: {} };
    const stT: Transition = { before: null, after: stAfter, input: { auth: { uid: 'a' } } };
    expect(stPol.judge(stT).ok).toBe(false);
    expect((stMod.judge as (t: Transition) => Verdict)(stT).ok).toBe(false);
    expect(simulateStoragePolicy(stSrc, { method: 'create', auth: { uid: 'a' }, after: stAfter }).decision).toBe('DENY');
  });

  test('Reg-A6: bounded.append and bounded.fold never swallow fatal ResourceLimitError behind recoverable list EvalError', async () => {
    const src = `
      use extension bounded;
      export function appErr(x, ys) { return bounded.append(1 / x, bounded.map(ys, y => y, 2), 2); }
      export function appNonList(ys) { return bounded.append(123, bounded.map(ys, y => y, 2), 2); }
      export function appLim(xs, x) { return bounded.append(xs, 1 / x, 2); }
      export function foldErr(x, ys) { return bounded.fold(1 / x, bounded.map(ys, y => y, 2), (acc, v) => acc, 2); }
      export function foldNonList(ys) { return bounded.fold(123, bounded.map(ys, y => y, 2), (acc, v) => acc, 2); }
      export function foldLim(xs, x) { return bounded.fold(xs, 1 / x, (acc, v) => acc, 2); }
    `;
    const mod = await loader.load(compileBoundedModule(src).moduleSource, 'reg_a6');
    const interp = interpretModule(src);
    const checks: Array<[string, unknown[]]> = [
      ['appErr', [0, [1, 2, 3]]],
      ['appNonList', [[1, 2, 3]]],
      ['appLim', [[1, 2, 3], 0]],
      ['foldErr', [0, [1, 2, 3]]],
      ['foldNonList', [[1, 2, 3]]],
      ['foldLim', [[1, 2, 3], 0]],
    ];
    for (const [name, args] of checks) {
      const o1 = captureCall(() => interp[name]!(...args));
      const o2 = captureCall(() => mod[name]!(...args));
      expect(o1.kind, `${name} interp`).toBe('resource-limit');
      expect(o2.kind, `${name} mod`).toBe('resource-limit');
    }
  });

  test('Reg-A7: Firestore lowering rejects emitted double-negation `--` instead of returning uncompilable rules', () => {
    const src = 'transition t { require r { return input.tag in [(-(-(1.5)))]; } }';
    const pol = compilePolicy(src);
    const row = pol.firestore(defaultFirestoreBindings(), 'mixed')[0]!;
    expect(row.predicate).toBeUndefined();
    expect(row.reason).toContain('decrement (--)');
    expect(prepareFirestoreSim(src).lowered).toBe(false);
  });

  test('Reg-A8: harness classifyError isolates unexpected JS host crashes and never masks them as parity', () => {
    const r = classifyError(new RangeError('out of range'));
    const t = classifyError(new TypeError('bad'));
    expect(r.kind).toBe('unexpected-error');
    expect(t.kind).toBe('unexpected-error');
    expect(outcomesMatch(r, r)).toBe(false);
    expect(outcomesMatch(r, { kind: 'eval-error', message: 'x' })).toBe(false);
  });

  test('Reg-A9: split-enforcement fatal order, RTDB .write delete/null, Storage non-sim sizes, and guard loops', async () => {
    // Gateway-first fatal ResourceLimitError + failing DB requirement stays fatal.
    const splitSrc = `
      use extension bounded;
      transition t {
        require gw { return bounded.count(input.items, x => x > 0, 2) >= 0; }
        require db { return after.x > 100; }
      }
    `;
    const pol = compilePolicy(splitSrc);
    const mod = await loader.load(pol.standaloneModule().moduleSource, 'reg_a9_split');
    const tr: Transition = { before: {}, after: { x: 1 }, input: { items: [1, 2, 3] } };
    expect(normalizeVerdictDetailed(pol.judge(tr)).kind).toBe('resource-limit');
    expect(normalizeVerdictDetailed((mod.judge as (t: Transition) => Verdict)(tr)).kind).toBe('resource-limit');
    expect(prepareFirestoreSim(splitSrc, { allowPartial: true }).simulate(tr)).toBe('DENY');
    expect(prepareRtdbSim(splitSrc, { allowPartial: true }).simulate({}, { x: 1 })).toBe('DENY');

    // RTDB .write handles true delete (newData = null) and create (before = null) without _keep sentinel.
    const delSrc = 'transition t { require r { return before == null || after == null || after.x > 0; } }';
    const delSim = prepareRtdbSim(delSrc, { ruleKind: 'write' });
    expect(delSim.lowered).toBe(true);
    expect(delSim.simulate({ x: 1 }, null)).toBe('ALLOW');
    expect(delSim.simulate(null, { x: -5 })).toBe('ALLOW');
    expect(delSim.simulate({ x: 1 }, { x: -5 })).toBe('DENY');

    // Storage bare-root || with absent auth and non-simulator sizes (-0.0, 1.5, -1, 2^53) interp vs ES module.
    const stSrc = 'transition t { require r { return (input.auth != null || after.size <= 10) && after.size is int; } }';
    const stPol = compilePolicy(stSrc);
    const stMod = await loader.load(stPol.standaloneModule().moduleSource, 'reg_a9_st');
    const stSim = prepareStorageSim(stSrc, 'create');
    expect(stSim.lowered).toBe(true);
    expect(stSim.simulate({ method: 'create', auth: null, after: { size: 5, contentType: 'text/plain' } })).toBe('ALLOW');
    expect(stSim.simulate({ method: 'create', auth: null, after: { size: 50, contentType: 'text/plain' } })).toBe('DENY');
    for (const size of [-0.0, 1.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
      const t: Transition = { before: null, after: { size, contentType: 'text/plain' }, input: { auth: null } };
      expect(stPol.judge(t).ok).toBe((stMod.judge as (x: Transition) => Verdict)(t).ok);
    }

    // for...of guard loop parity.
    const glSrc = `
      use extension loops;
      export function findBad(xs) {
        for (const x of bounded(xs, 5)) {
          if (x < 0) return 'neg';
          if (x == 0) return 'zero';
        }
        return 'ok';
      }
    `;
    const glFn = compileFunction(glSrc);
    const glMod = await loader.load(glFn.standaloneModule().moduleSource, 'reg_a9_gl');
    for (const xs of [[], [1, -1], [1, 0, 'bad'], ['bad', -1], [1, 2, 3, 4, 5, 6], 'bad']) {
      expect(outcomesMatchWithSafeIntBridge(captureCall(() => glFn(xs)), captureCall(() => glMod.findBad!(xs)))).toBe(true);
    }
  });
});

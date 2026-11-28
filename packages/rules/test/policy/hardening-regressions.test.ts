import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileBoundedModule, compilePolicy, interpretModule } from '../../src/policy/index.js';

let seq = 0;

async function loadModule(source: string): Promise<Record<string, (...args: unknown[]) => unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-policy-reg-'));
  const file = join(dir, `m-${++seq}.mjs`);
  writeFileSync(file, source, 'utf8');
  try {
    return (await import(pathToFileURL(file).href)) as Record<string, (...args: unknown[]) => unknown>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('Policy IR hardening and cross-engine parity regressions', () => {
  test('Finding 1: exponential DAG export is bounded by output node cap and ticks in both engines', async () => {
    const src = `
      use extension bounded;
      export function dagBomb() {
        let a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        let b = [a, a, a, a, a, a, a, a, a, a];
        let c = [b, b, b, b, b, b, b, b, b, b];
        let d = [c, c, c, c, c, c, c, c, c, c];
        let e = [d, d, d, d, d, d, d, d, d, d];
        return e;
      }
    `;
    const interp = interpretModule(src, { expressionLimit: 100 });
    const mod = await loadModule(compileBoundedModule(src).moduleSource);
    const t0 = performance.now();
    expect(() => interp.dagBomb()).toThrow(/Output depth or node bound|exceeds/i);
    expect(() => mod.dagBomb()).toThrow(/Output depth or node bound|budget/i);
    expect(performance.now() - t0).toBeLessThan(250);
  });

  test('Finding 2: pathological RE2 NFA state/slot work bills ticks and fails fast under budget', async () => {
    const pat = '(a?){100}'.repeat(20) + 'b';
    const src = `
      use extension bounded;
      export function heavyReplace(s, p) {
        return s.replace(p, 'X');
      }
    `;
    const mod = await loadModule(compileBoundedModule(src).moduleSource);
    const t0 = performance.now();
    expect(() => mod.heavyReplace('a'.repeat(1000), pat)).toThrow(/budget|state limit/i);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  test('Finding 3: standalone transition respects expressionLimit and charges full requirement cost', async () => {
    const sum40 = Array.from({ length: 40 }, () => '1').join(' + ');
    const bigPolicy = compilePolicy(
      `transition p { require big { return before.x + ${sum40} == 40; } }`,
      { expressionLimit: 10 },
    );
    const bigMod = await loadModule(bigPolicy.standaloneModule().moduleSource);
    const rInterp = bigPolicy.judge({ before: { x: 0 }, after: {}, input: {} });
    const rStand = bigMod.judge({ before: { x: 0 }, after: {}, input: {} }) as { ok: boolean; fatal?: boolean };
    expect(rInterp.ok).toBe(false);
    expect('fatal' in rInterp && rInterp.fatal).toBe(true);
    expect(rStand.ok).toBe(false);
    expect(rStand.fatal).toBe(true);

    const sum10 = Array.from({ length: 10 }, () => '1').join(' + ');
    const derivePolicy = compilePolicy(
      `use extension derive;
       transition p {
         derive { return {'v': before.x + ${sum10}}; }
         require ok { return after.v == derived.v; }
       }`,
      { expressionLimit: 5 },
    );
    const deriveMod = await loadModule(derivePolicy.standaloneModule().moduleSource);
    const dInterp = derivePolicy.judge({ before: { x: 0 }, after: { v: 10 }, input: {} });
    const dStand = deriveMod.judge({ before: { x: 0 }, after: { v: 10 }, input: {} }) as { ok: boolean; fatal?: boolean };
    expect(dInterp.ok).toBe(false);
    expect('fatal' in dInterp && dInterp.fatal).toBe(true);
    expect(dStand.ok).toBe(false);
    expect(dStand.fatal).toBe(true);
  });

  test('Finding 4: transition input boundary rejects getters, non-plain prototypes, and cycles while allowing omitted input', async () => {
    const policy = compilePolicy(`transition p { require ok { return after.x == 1; } }`);
    const mod = await loadModule(policy.standaloneModule().moduleSource);

    // Omitted optional input succeeds identically
    const noInput = { before: {}, after: { x: 1 } } as unknown as { before: unknown; after: unknown; input: unknown };
    expect(policy.judge(noInput)).toEqual({ ok: true });
    expect(mod.judge(noInput)).toEqual({ ok: true });

    // Hostile getter blocked without firing in both engines
    let fired = false;
    const getterObj: Record<string, unknown> = {};
    Object.defineProperty(getterObj, 'x', {
      enumerable: true,
      get() {
        fired = true;
        return 1;
      },
    });
    expect(() => policy.judge({ before: {}, after: getterObj, input: {} })).toThrow(/Missing own data value/);
    expect(() => mod.judge({ before: {}, after: getterObj, input: {} })).toThrow(/Missing own data value/);
    expect(fired).toBe(false);

    // Non-plain prototype rejected identically
    const nonPlain = Object.create({ x: 1 });
    expect(() => policy.judge({ before: {}, after: nonPlain, input: {} })).toThrow(/Expected plain record data/);
    expect(() => mod.judge({ before: {}, after: nonPlain, input: {} })).toThrow(/Expected plain record data/);

    // Cyclic object rejected identically
    const cyc: Record<string, unknown> = { x: 1 };
    cyc.self = cyc;
    expect(() => policy.judge({ before: {}, after: cyc, input: {} })).toThrow(/Input depth or node bound/);
    expect(() => mod.judge({ before: {}, after: cyc, input: {} })).toThrow(/Input depth or node bound/);

    // Chaining derive() outputs carrying RulesFloat wrappers back into derive()/judge() succeeds
    const chain = compilePolicy(`
      use extension derive;
      transition step {
        derive { return {'x': before.x + 0.5}; }
        require matches { return after.x == derived.x; }
      }
    `);
    const s1 = chain.derive({ before: { x: 1 }, input: {} });
    const s2 = chain.derive({ before: s1, input: {} });
    expect(chain.judge({ before: s1, after: s2, input: {} })).toEqual({ ok: true });
  });

  test('Finding 5: fail(msg) is never swallowed by || true or && false in either engine', async () => {
    const src = `
      use extension bounded;
      export function orFail() { return fail('boom') || true; }
      export function andFail() { return fail('boom') && false; }
    `;
    const interp = interpretModule(src);
    const mod = await loadModule(compileBoundedModule(src).moduleSource);
    expect(() => interp.orFail()).toThrow('boom');
    expect(() => mod.orFail()).toThrow('boom');
    expect(() => interp.andFail()).toThrow('boom');
    expect(() => mod.andFail()).toThrow('boom');
  });

  test('Finding 6: forbidden map keys (__proto__, constructor, prototype) fail identically in all engines', async () => {
    const modSrc = `
      use extension bounded;
      export function makeProto() { return {'__proto__': 1}; }
      export function makeCtor() { return {constructor: 1}; }
      export function makePrototype() { return {'prototype': 1}; }
    `;
    const interp = interpretModule(modSrc);
    const mod = await loadModule(compileBoundedModule(modSrc).moduleSource);
    for (const fn of ['makeProto', 'makeCtor', 'makePrototype']) {
      expect(() => interp[fn]!()).toThrow(/forbidden key/);
      expect(() => mod[fn]!()).toThrow(/forbidden key/);
    }

    const pol = compilePolicy(`transition p { require bad { return {'constructor': 1} is map; } }`);
    const polMod = await loadModule(pol.standaloneModule().moduleSource);
    const v1 = pol.judge({ before: {}, after: {}, input: {} });
    const v2 = polMod.judge({ before: {}, after: {}, input: {} }) as { ok: boolean; reason?: string };
    expect(v1.ok).toBe(false);
    expect(v2.ok).toBe(false);
    if (!v1.ok) expect(v1.reason).toMatch(/forbidden key/);
    expect(v2.reason).toMatch(/forbidden key/);
  });

  test('Finding 7: bounded.count surfaces later fatal ResourceLimitError even after earlier EvalError', async () => {
    const pol = compilePolicy(`
      use extension bounded;
      transition p {
        require check {
          let n = bounded.count(before.items, item => item == 0 ? (1 / 0 == 1) : bounded.any(before.tooBig, x => x == 1, 1), 10);
          return n >= 0 || true;
        }
      }
    `);
    const polMod = await loadModule(pol.standaloneModule().moduleSource);
    const input = { before: { items: [0, 1], tooBig: [1, 2] }, after: {}, input: {} };
    const v1 = pol.judge(input);
    const v2 = polMod.judge(input) as { ok: boolean; fatal?: boolean };
    expect(v1.ok).toBe(false);
    expect('fatal' in v1 && v1.fatal).toBe(true);
    expect(v2.ok).toBe(false);
    expect(v2.fatal).toBe(true);
  });

  test('Finding 8: for...of helper error stays lazy in unused let binding in both engines', async () => {
    const src = `
      use extension bounded;
      use extension loops;
      function helper(xs) {
        let acc = 0;
        for (const x of bounded(xs, 10)) {
          acc = acc + x.bad;
        }
        return acc;
      }
      export function unused(xs) {
        let ig = helper(xs);
        return true;
      }
      export function used(xs) {
        return helper(xs);
      }
    `;
    const interp = interpretModule(src);
    const mod = await loadModule(compileBoundedModule(src).moduleSource);
    expect(interp.unused([{}])).toBe(true);
    expect(mod.unused([{}])).toBe(true);
    expect(() => interp.used([{}])).toThrow();
    expect(() => mod.used([{}])).toThrow();
  });

  test('Finding 9: RE2 Unicode classes, octal escapes, and surrogate-pair split/replace match simulator', async () => {
    const src = `
      use extension bounded;
      export function re2Parity(emoji) {
        return {
          'unicodeMatch': 'hello'.matches('\\\\p{L}+'),
          'unicodeShort': 'hello'.matches('\\\\pL+'),
          'unicodeNonMatch': 'p{L}'.matches('\\\\p{L}'),
          'unicodeInClass': 'hello'.matches('[\\\\p{L}]+'),
          'octalA': 'A'.matches('\\\\101'),
          'backrefRejected': ('aa'.matches('(a)\\\\1') || true),
          'splitEmoji': emoji.split(''),
          'replaceEmoji': emoji.replace('', '-')
        };
      }
    `;
    const interp = interpretModule(src);
    const mod = await loadModule(compileBoundedModule(src).moduleSource);
    const sample = 'a\ud83d\ude00b';
    const expected = interp.re2Parity(sample);
    const actual = mod.re2Parity(sample);
    expect(actual).toEqual(expected);
    expect(actual).toEqual({
      unicodeMatch: true,
      unicodeShort: true,
      unicodeNonMatch: false,
      unicodeInClass: true,
      octalA: true,
      backrefRejected: true,
      splitEmoji: ['a', '\ud83d', '\ude00', 'b'],
      replaceEmoji: '-a-\ud83d-\ude00-b-',
    });
  });
});

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  checkPolicyIR,
  compileBoundedModule,
  compileFunction,
  compilePolicy,
  interpretModule,
  parsePolicyIR,
} from '../../src/policy/index.js';

const tempDir = mkdtempSync(join(tmpdir(), 'pyric-policy-ir-'));
let modSeq = 0;
afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function loadStandalone(moduleSource: string) {
  const file = join(tempDir, `mod-${modSeq++}.mjs`);
  writeFileSync(file, moduleSource, 'utf8');
  return import(pathToFileURL(file).href);
}

describe('Unified IR & static checker (ir.ts + check.ts)', () => {
  test('parses and checks acyclic helper DAG with deterministic topological order', () => {
    const src = `
      use extension bounded;
      function leaf(x) { return x + 1; }
      function mid(x) { return leaf(x) * 2; }
      export function top(x) { return mid(x) + leaf(x); }
    `;
    const ir = parsePolicyIR(src, 'module');
    const checked = checkPolicyIR(ir);
    expect(checked.topoOrder).toEqual(['leaf', 'mid', 'top']);
    expect(checked.exports).toEqual(['top']);
  });

  test('rejects direct and mutual recursion in modules and transitions', () => {
    expect(() =>
      compileBoundedModule(`
        use extension bounded;
        export function selfRec(n) { return selfRec(n - 1); }
      `),
    ).toThrow(/Recursive calls/);

    expect(() =>
      compileBoundedModule(`
        use extension bounded;
        function a(n) { return b(n); }
        function b(n) { return c(n); }
        function c(n) { return a(n); }
        export function entry(n) { return a(n); }
      `),
    ).toThrow(/Recursive calls/);

    expect(() =>
      compilePolicy(`
        function ping(x) { return pong(x); }
        function pong(x) { return ping(x); }
        transition bad { require r { return ping(after.x) == 1; } }
      `),
    ).toThrow(/Recursive calls/);
  });

  test('enforces int64 literal bounds across all policy forms and dead branches', () => {
    expect(() =>
      compileBoundedModule(`
        use extension bounded;
        export function bad() { return false ? 9223372036854775808 : 0; }
      `),
    ).toThrow(/Invalid number literal 9223372036854775808/);

    expect(() =>
      compileBoundedModule(`
        use extension bounded;
        export function badParen() { return -(9223372036854775808); }
      `),
    ).toThrow(/Invalid number literal 9223372036854775808/);

    expect(() =>
      compilePolicy(`
        transition t { require r { return false ? 9223372036854775808 == 0 : true; } }
      `),
    ).toThrow(/Invalid number literal 9223372036854775808/);

    const okMin = compileBoundedModule(`
      use extension bounded;
      export function minInt() { return -9223372036854775808; }
    `);
    expect(okMin.exports).toEqual(['minInt']);
  });

  test('validates extension opt-ins, arities, shadowing, and bound caps', () => {
    expect(() => compileBoundedModule('export function f(x) { return x; }')).toThrow(/use extension bounded/);
    expect(() =>
      compileBoundedModule(`
        use extension bounded;
        use extension bogus;
        export function f(x) { return x; }
      `),
    ).toThrow(/Unknown extension/);
    expect(() =>
      compileBoundedModule(`
        use extension bounded;
        export function f(xs) { return bounded.all(xs, x => x, 0); }
      `),
    ).toThrow(/bound/);
    expect(() =>
      compileBoundedModule(`
        use extension bounded;
        export function f(xs) { return bounded.map(xs, x => x, 4097); }
      `),
    ).toThrow(/bound/);
    expect(() =>
      compileBoundedModule(`
        use extension bounded;
        export function f(x) { return math.abs(x, 1); }
      `),
    ).toThrow(/arity/i);
    expect(() =>
      compileBoundedModule(`
        use extension bounded;
        export function f(x) { return x.unknownMethod(); }
      `),
    ).toThrow(/Unsupported method/);
    expect(() =>
      compilePolicy('transition t { require r { return after.items.size() == 1; } }'),
    ).toThrow(/subset/);
  });

  test('supports all composable bounded ops across interpreter and standalone ES module', async () => {
    const src = `
      use extension bounded;
      export function pipeline(xs, extra) {
        let joined = bounded.append(xs, extra, 16);
        let pos = bounded.select(joined, n => n > 0, 16);
        let doubled = bounded.map(pos, n => n * 2, 16);
        let allEven = bounded.all(doubled, n => n % 2 == 0, 16);
        let anyBig = bounded.any(doubled, n => n >= 10, 16);
        let bigCount = bounded.count(doubled, n => n >= 10, 16);
        let sum = bounded.fold(doubled, 0, (acc, n) => {
          let step = acc + n;
          return step;
        }, 16);
        return {
          'allEven': allEven,
          'anyBig': anyBig,
          'bigCount': bigCount,
          'sum': sum,
          'size': doubled.size()
        };
      }
    `;
    const compiled = compileBoundedModule(src);
    const mod = await loadStandalone(compiled.moduleSource);
    const interp = interpretModule(src);

    const expected = { allEven: true, anyBig: true, bigCount: 2, sum: 32, size: 4 };
    expect(mod.pipeline([-3, 1, 5], [0, 2, 8])).toEqual(expected);
    expect(interp.pipeline([-3, 1, 5], [0, 2, 8])).toEqual(expected);
    expect(() => mod.pipeline(Array(10).fill(1), Array(7).fill(1))).toThrow(/limit|bound/);
    expect(() => interp.pipeline(Array(10).fill(1), Array(7).fill(1))).toThrow(/limit|bound/);
  });

  test('supports for...of loops in bounded modules and compileFunction.standaloneModule()', async () => {
    const fnSrc = `
      use extension loops;
      function sumCapped(xs) {
        let total = 0;
        for (const x of bounded(xs, 4)) {
          total = total + x;
        }
        return total;
      }
    `;
    const fn = compileFunction(fnSrc);
    const mod = await loadStandalone(fn.standaloneModule().moduleSource);
    expect(Number(fn([1, 2, 3]))).toBe(6);
    expect(mod.sumCapped([1, 2, 3])).toBe(6);
    expect(() => fn([1, 2, 3, 4, 5])).toThrow(/bound/);
    expect(() => mod.sumCapped([1, 2, 3, 4, 5])).toThrow(/bound/);

    const modSrc = `
      use extension bounded;
      use extension loops;
      export function firstPositive(xs) {
        for (const x of bounded(xs, 4)) {
          if (x > 0) return x;
        }
        return -1;
      }
    `;
    const m = await loadStandalone(compileBoundedModule(modSrc).moduleSource);
    const interp = interpretModule(modSrc);
    expect(m.firstPositive([-2, 0, 7, 9])).toBe(7);
    expect(interp.firstPositive([-2, 0, 7, 9])).toBe(7);
    expect(m.firstPositive([-2, -1])).toBe(-1);
    expect(interp.firstPositive([-2, -1])).toBe(-1);
  });

  test('supports helper functions, bounded.all, and standaloneModule() in compilePolicy transitions', async () => {
    const policySrc = `
      use extension bounded;
      use extension derive;
      function delta(a, b) { return b - a; }
      transition scored {
        derive {
          let bonus = bounded.count(input.tags, t => t == 'vip', 8);
          return {'next': before.score + input.points + bonus};
        }
        require nonNegativeDeltas {
          let ok = bounded.all(input.deltas, d => d >= 0, 8);
          return ok && delta(before.score, after.score) >= 0;
        }
        require matchesDerived {
          return after.score == derived.next;
        }
      }
    `;
    const policy = compilePolicy(policySrc);
    const mod = await loadStandalone(policy.standaloneModule().moduleSource);

    const good = { before: { score: 10 }, after: { score: 17 }, input: { points: 5, tags: ['vip', 'std', 'vip'], deltas: [0, 3] } };
    expect(policy.judge(good)).toEqual({ ok: true });
    expect(mod.judge(good)).toEqual({ ok: true });
    expect(Number(policy.derive(good).next)).toBe(17);
    expect(mod.derive(good)).toEqual({ next: 17 });

    const bad = { before: { score: 10 }, after: { score: 17 }, input: { points: 5, tags: ['vip'], deltas: [-1] } };
    expect(policy.judge(bad).ok).toBe(false);
    expect(mod.judge(bad).ok).toBe(false);
    expect((policy.judge(bad) as { requirement: string }).requirement).toBe('nonNegativeDeltas');
    expect(mod.judge(bad).requirement).toBe('nonNegativeDeltas');
  });
});

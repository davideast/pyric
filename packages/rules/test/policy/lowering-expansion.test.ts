// Deliverable 2 tests: expanded target lowering coverage across Firestore, RTDB, and Storage.
// Covers multi-binding `require` blocks, acyclic helper-function inlining with hygiene,
// deeper nested/multi-field `derive` projections, sibling soundness, trusted inputs,
// exponential DAG refusal, and budget/cost breakdown diagnostics on fallback.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { firestoreRules } from '../../src/api/firestore.js';
import { rtdbRules } from '../../src/api/rtdb.js';
import { storageRules } from '../../src/api/storage.js';
import { compilePolicy, createPolicyGuard, jsonBodyExtractor, provePolicy, type Transition, type Verdict } from '../../src/policy/index.js';

const tempDir = mkdtempSync(join(tmpdir(), 'pyric-lowering-exp-'));
let seq = 0;
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

async function importStandalone(source: string, tag: string) {
  const file = join(tempDir, `${tag}-${seq++}.mjs`);
  writeFileSync(file, source, 'utf8');
  return (await import(pathToFileURL(file).href)) as { judge: (t: Transition) => Verdict };
}

function evalFirestore(predicate: string, before: Record<string, unknown>, after: Record<string, unknown>, auth?: { uid: string; token?: Record<string, unknown> } | null) {
  const rules = firestoreRules(`rules_version = '2'; service cloud.firestore {
    match /databases/{db}/documents { match /items/{id} { allow update: if ${predicate}; } }
  }`);
  const [row] = rules.simulate([
    { description: 't', method: 'update', path: 'items/1', resource: before, data: after, ...(auth !== undefined ? { auth } : {}), expectation: 'ALLOW' },
  ]).cases;
  expect(row?.unsupported).toBe(false);
  return row!.decision;
}

function evalRtdb(predicate: string, before: unknown, after: unknown) {
  const rules = rtdbRules({ rules: { item: { '.write': predicate } } });
  const [row] = rules.simulate([{ path: '/item', operation: 'write', expectation: 'ALLOW', data: { item: before }, newData: after }]).cases;
  expect(row?.unsupported).toBe(false);
  return row!.decision;
}

function evalStorage(
  predicate: string,
  method: 'create' | 'update',
  reqRes: { size: number; contentType?: string; metadata?: Record<string, string> },
  res?: { size: number; contentType?: string; metadata?: Record<string, string> },
  auth?: { uid: string } | null,
) {
  const rules = storageRules(
    `rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /items/{id} { allow ${method}: if ${predicate}; } } }`,
    { bucket: 'test-bucket.appspot.com' },
  );
  const [row] = rules.simulate([
    { description: 't', method, path: 'items/1', requestResource: reqRes, ...(res ? { resource: res } : {}), ...(auth !== undefined ? { auth } : {}), expectation: 'ALLOW' },
  ]).cases;
  expect(row?.unsupported).toBe(false);
  return row!.decision;
}

describe('Multi-binding require blocks across Firestore, RTDB, and Storage', () => {
  test('lowers chained let bindings with cross-engine parity and cost attribution', async () => {
    const src = `
      transition multiLet {
        require stepped {
          let base = before.x + 1;
          let doubled = base * 2;
          let ceiling = doubled + 10;
          return after.y >= doubled && after.y <= ceiling;
        }
      }
    `;
    const policy = compilePolicy(src);
    const mod = await importStandalone(policy.standaloneModule().moduleSource, 'multilet');

    const [fsRow] = policy.firestore({ 'before.x': 'resource.data.x', 'after.y': 'request.resource.data.y' }, 'complete');
    expect(fsRow!.enforcement).toBe('standalone and database');
    expect(fsRow!.cost.inlinedLets).toBe(3);
    expect(fsRow!.cost.withinTargetBudget).toBe(true);

    const [rtRow] = policy.rtdb({ before: 'data', after: 'newData' }, 'complete');
    expect(rtRow!.enforcement).toBe('gateway and database');
    expect(rtRow!.cost.inlinedLets).toBe(3);
    expect(rtRow!.cost.targetCharLimit).toBe(16384);

    const storageSrc = `
      use extension methods;
      transition uploadLimits {
        require check {
          let minSize = before.size;
          let maxSize = minSize + 1024;
          let meta = after.metadata;
          return after.size >= minSize && after.size <= maxSize && meta.get('owner', '') == input.uid;
        }
      }
    `;
    const stPol = compilePolicy(storageSrc);
    const [stRow] = stPol.storage({ before: 'resource', after: 'request.resource', 'input.uid': 'request.auth.uid' }, 'complete');
    expect(stRow!.cost.inlinedLets).toBe(3);
    expect(evalStorage(stRow!.predicate!, 'update', { size: 600, metadata: { owner: 'u1' } }, { size: 500 }, { uid: 'u1' })).toBe('ALLOW');
    expect(evalStorage(stRow!.predicate!, 'update', { size: 2000, metadata: { owner: 'u1' } }, { size: 500 }, { uid: 'u1' })).toBe('DENY');

    for (const [x, y, want] of [[2, 6, 'ALLOW'], [2, 16, 'ALLOW'], [2, 5, 'DENY'], [2, 17, 'DENY']] as const) {
      const t = { before: { x }, after: { y }, input: {} };
      expect(policy.judge(t).ok).toBe(want === 'ALLOW');
      expect(mod.judge(t).ok).toBe(want === 'ALLOW');
      expect(evalFirestore(fsRow!.predicate!, { x }, { y })).toBe(want);
      expect(evalRtdb(rtRow!.predicate!, { x }, { y })).toBe(want);
    }
  });

  test('supports deep linear let chains, lazy unused erroring let, double negation, and refuses unused bounded op let', () => {
    // 12-step linear chain lowers cleanly under work headroom
    const lets = Array.from({ length: 12 }, (_, i) => `let v${i} = ${i === 0 ? 'before.x' : `v${i - 1}`} + 1;`).join('\n');
    const linear = compilePolicy(`transition t { require r { ${lets} return after.x == v11; } }`);
    const [linRow] = linear.firestore({ 'before.x': 'resource.data.x', 'after.x': 'request.resource.data.x' }, 'complete');
    expect(evalFirestore(linRow!.predicate!, { x: 10 }, { x: 22 })).toBe('ALLOW');
    expect(evalFirestore(linRow!.predicate!, { x: 10 }, { x: 21 })).toBe('DENY');

    // Unused pure erroring let preserves lazy semantics
    const lazy = compilePolicy(`
      transition t {
        require r {
          let dead = 1 / 0;
          return after.x == 1;
        }
      }
    `);
    const [lazyFs] = lazy.firestore({ 'after.x': 'request.resource.data.x' }, 'complete');
    expect(lazy.judge({ before: {}, after: { x: 1 }, input: {} })).toEqual({ ok: true });
    expect(evalFirestore(lazyFs!.predicate!, {}, { x: 1 })).toBe('ALLOW');

    // Double unary negation preserves numeric semantics across Firestore, Storage, and RTDB
    const dblNeg = compilePolicy(`transition t { require r { let neg = -before.x; return -neg == after.x; } }`);
    const [negFs] = dblNeg.firestore({ 'before.x': 'resource.data.x', 'after.x': 'request.resource.data.x' }, 'complete');
    const [negSt] = dblNeg.storage({ 'before.x': 'resource.size', 'after.x': 'request.resource.size' }, 'complete');
    const [negRt] = dblNeg.rtdb({ before: 'data', after: 'newData' }, 'complete');
    expect(evalFirestore(negFs!.predicate!, { x: 7 }, { x: 7 })).toBe('ALLOW');
    expect(evalFirestore(negFs!.predicate!, { x: 7 }, { x: -7 })).toBe('DENY');
    expect(evalStorage(negSt!.predicate!, 'update', { size: 7 }, { size: 7 })).toBe('ALLOW');
    expect(evalStorage(negSt!.predicate!, 'update', { size: 8 }, { size: 7 })).toBe('DENY');
    expect(evalRtdb(negRt!.predicate!, { x: 7 }, { x: 7 })).toBe('ALLOW');
    expect(evalRtdb(negRt!.predicate!, { x: 7 }, { x: -7 })).toBe('DENY');

    // Unused boundedOp let MUST be refused so fatal ResourceLimitError can never be swallowed
    const unusedBounded = compilePolicy(`
      use extension bounded;
      transition t {
        require r {
          let dead = bounded.all(input.items, x => x > 0, 2);
          return after.x == 1;
        }
      }
    `);
    const [ubFs] = unusedBounded.firestore({ 'after.x': 'request.resource.data.x' }, 'mixed');
    const [ubRt] = unusedBounded.rtdb({ after: 'newData' }, 'mixed');
    const [ubSt] = unusedBounded.storage({ 'after.x': 'request.resource.size' }, 'mixed');
    expect(ubFs!.predicate).toBeUndefined();
    expect(ubRt!.predicate).toBeUndefined();
    expect(ubSt!.predicate).toBeUndefined();
    expect(ubFs!.diagnostics.some((d) => d.code === 'USES_BOUNDED_OP')).toBe(true);
  });

  test('rejects exponential let DAG bomb quickly with structured budget diagnostics', () => {
    const chain = ['let v0 = before.x + before.x;'];
    for (let i = 1; i <= 14; i++) chain.push(`let v${i} = v${i - 1} + v${i - 1};`);
    const bomb = compilePolicy(`transition t { require r { ${chain.join('\n')} return after.x == v14; } }`);
    const t0 = performance.now();
    const [row] = bomb.firestore({ 'before.x': 'resource.data.x', 'after.x': 'request.resource.data.x' }, 'mixed');
    expect(performance.now() - t0).toBeLessThan(200);
    expect(row!.predicate).toBeUndefined();
    expect(row!.enforcement).toBe('standalone only');
    expect(row!.diagnostics.some((d) => d.code === 'EXPRESSION_BUDGET_EXCEEDED')).toBe(true);
    expect(row!.cost.withinTargetBudget).toBe(false);
    expect(row!.cost.fallbackSummary).toContain('Fallback (standalone only)');
    expect(row!.cost.expansionNodeLimit).toBe(256);
  });
});

describe('Acyclic helper-function inlining with hygiene and cost limits', () => {
  test('inlines multi-level diamond helper DAGs and prevents variable capture across all 3 targets', async () => {
    const src = `
      function inc(before) { return before + 1; }
      function clamp(x, lo, hi) {
        let low = x < lo ? lo : x;
        return low > hi ? hi : low;
      }
      function boundedStep(v, lo, hi) {
        let next = inc(v);
        return clamp(next, lo, hi);
      }
      transition helperDag {
        require check {
          let lo = 0;
          let target = boundedStep(before.x, lo, 10);
          return after.x == target;
        }
      }
    `;
    const pol = compilePolicy(src);
    const mod = await importStandalone(pol.standaloneModule().moduleSource, 'helper-dag');
    const [fsRow] = pol.firestore({ 'before.x': 'resource.data.x', 'after.x': 'request.resource.data.x' }, 'complete');
    const [rtRow] = pol.rtdb({ before: 'data', after: 'newData' }, 'complete');
    const [stRow] = pol.storage({ 'before.x': 'resource.size', 'after.x': 'request.resource.size' }, 'complete');

    expect(fsRow!.cost.inlinedHelpers).toEqual(expect.arrayContaining(['inc', 'clamp', 'boundedStep']));
    expect(rtRow!.cost.inlinedHelpers).toEqual(expect.arrayContaining(['inc', 'clamp', 'boundedStep']));
    expect(stRow!.cost.inlinedHelpers).toEqual(expect.arrayContaining(['inc', 'clamp', 'boundedStep']));
    expect(fsRow!.cost.helperUnits).toBeGreaterThan(0);

    for (const [bx, ax, want] of [[0, 1, 'ALLOW'], [9, 10, 'ALLOW'], [10, 10, 'ALLOW'], [10, 11, 'DENY'], [5, 7, 'DENY']] as const) {
      const t = { before: { x: bx }, after: { x: ax }, input: {} };
      expect(pol.judge(t).ok).toBe(want === 'ALLOW');
      expect(mod.judge(t).ok).toBe(want === 'ALLOW');
      expect(evalFirestore(fsRow!.predicate!, { x: bx }, { x: ax })).toBe(want);
      expect(evalRtdb(rtRow!.predicate!, { x: bx }, { x: ax })).toBe(want);
      expect(evalStorage(stRow!.predicate!, 'update', { size: ax }, { size: bx })).toBe(want);
    }

    // Parameter shadowing root `before` and caller local `y` must never capture
    const captureSrc = `
      function swap(x, y) { return x - y; }
      transition cap {
        require r {
          let y = before.a;
          return swap(y, after.b) == 3;
        }
      }
    `;
    const cap = compilePolicy(captureSrc);
    const [capRow] = cap.firestore({ 'before.a': 'resource.data.a', 'after.b': 'request.resource.data.b' }, 'complete');
    expect(evalFirestore(capRow!.predicate!, { a: 10 }, { b: 7 })).toBe('ALLOW');
    expect(evalFirestore(capRow!.predicate!, { a: 7 }, { b: 10 })).toBe('DENY');
  });

  test('unrelated impure helper does not block pure requirements; called impure helper reports transitive op cost', () => {
    const src = `
      use extension bounded;
      function pureInc(n) { return n + 1; }
      function impureDeadLet(xs) {
        let unused = bounded.all(xs, v => v > 0, 4);
        return true;
      }
      transition mixedHelpers {
        require pureReq { return after.x == pureInc(before.x); }
        require impureReq { return impureDeadLet(input.items); }
      }
    `;
    const pol = compilePolicy(src);
    const rows = pol.firestore({ 'before.x': 'resource.data.x', 'after.x': 'request.resource.data.x' }, 'mixed');
    expect(rows[0]!.enforcement).toBe('standalone and database');
    expect(rows[0]!.cost.inlinedHelpers).toEqual(['pureInc']);
    expect(rows[1]!.enforcement).toBe('standalone only');
    expect(rows[1]!.diagnostics.some((d) => d.code === 'USES_BOUNDED_OP' && d.detail?.includes('impureDeadLet'))).toBe(true);
    expect(rows[1]!.cost.boundedOps).toEqual([expect.objectContaining({ op: 'bounded.all', limit: 4 })]);
    expect(rows[1]!.cost.fallbackSummary).toContain('bounded.all');

    // Proves true split enforcement with provePolicy
    const report = provePolicy(src, {
      firestore: { 'before.x': 'resource.data.x', 'after.x': 'request.resource.data.x' },
      scenarios: [
        { name: 'ok', transition: { before: { x: 1 }, after: { x: 2 }, input: { items: [1] } }, expectOk: true },
        { name: 'fatal overflow', transition: { before: { x: 1 }, after: { x: 2 }, input: { items: [1, 2, 3, 4, 5] } }, expectOk: false },
      ],
      fuzz: { seed: 5, cases: 20 },
    });
    expect(report.ok).toBe(true);
    expect(report.split?.firestore?.plan.mode).toBe('split');
    expect(report.split?.firestore?.plan.databaseRequirements).toEqual(['pureReq']);
    expect(report.split?.firestore?.plan.residualRequirements).toEqual(['impureReq']);
  });

  test('rejects exponential diamond helper bomb quickly with budget breakdown', () => {
    const fns = ['function f0(x) { return x + x; }'];
    for (let i = 1; i <= 10; i++) fns.push(`function f${i}(x) { return f${i - 1}(x) + f${i - 1}(x); }`);
    const src = `${fns.join('\n')}\ntransition t { require r { return after.x == f10(before.x); } }`;
    const pol = compilePolicy(src);
    const t0 = performance.now();
    const [row] = pol.firestore({ 'before.x': 'resource.data.x', 'after.x': 'request.resource.data.x' }, 'mixed');
    expect(performance.now() - t0).toBeLessThan(200);
    expect(row!.predicate).toBeUndefined();
    expect(row!.diagnostics.some((d) => d.code === 'EXPRESSION_BUDGET_EXCEEDED')).toBe(true);
    expect(row!.cost.withinTargetBudget).toBe(false);
    expect(row!.cost.fallbackSummary).toContain('Fallback (standalone only)');
  });
});

describe('Deeper derive projections, sibling soundness, and trusted-input checks', () => {
  test('projects nested maps, multi-field compound predicates, require lets, and helper calls across all targets', async () => {
    const src = `
      use extension derive;
      function fee(n) { return n * 2; }
      function inBand(val, lo, hi) { return val >= lo && val <= hi; }
      transition nestedDerive {
        derive {
          let base = before.x + fee(input.bonus);
          let bounds = {'lo': base, 'hi': base + 5, 'label': 'ok'};
          return {'bounds': bounds, 'owner': before.owner};
        }
        require checkAll {
          let minVal = derived.bounds.lo;
          let maxVal = derived.bounds.hi;
          return inBand(after.x, minVal, maxVal) && after.owner == derived.owner;
        }
      }
    `;
    const pol = compilePolicy(src);
    const mod = await importStandalone(pol.standaloneModule().moduleSource, 'nested-derive');

    const fsBindings = {
      'before.x': 'resource.data.x',
      'before.owner': 'resource.data.owner',
      'input.bonus': 'resource.data.bonus',
      'after.x': 'request.resource.data.x',
      'after.owner': 'request.resource.data.owner',
    };
    const [fsRow] = pol.firestore(fsBindings, 'complete');
    expect(fsRow!.completeReason).toBeUndefined();
    expect(fsRow!.cost.projectedDerivePaths).toEqual(expect.arrayContaining(['bounds.lo', 'bounds.hi', 'owner']));
    expect(fsRow!.cost.deriveUnits).toBeGreaterThan(0);
    expect(fsRow!.cost.inlinedHelpers).toEqual(['inBand']);

    const rtBindings = {
      before: 'data' as const,
      after: 'newData' as const,
      'input.bonus': { snapshot: 'data' as const, path: 'bonus' },
    };
    const [rtRow] = pol.rtdb(rtBindings, 'complete');
    expect(rtRow!.completeReason).toBeUndefined();

    const good: Transition = { before: { x: 10, owner: 'a' }, after: { x: 18, owner: 'a' }, input: { bonus: 3 } };
    const low: Transition = { before: { x: 10, owner: 'a' }, after: { x: 15, owner: 'a' }, input: { bonus: 3 } };
    expect(pol.judge(good)).toEqual({ ok: true });
    expect(mod.judge(good)).toEqual({ ok: true });
    expect(evalFirestore(fsRow!.predicate!, { x: 10, owner: 'a', bonus: 3 }, { x: 18, owner: 'a' })).toBe('ALLOW');
    expect(evalFirestore(fsRow!.predicate!, { x: 10, owner: 'a', bonus: 3 }, { x: 15, owner: 'a' })).toBe('DENY');
    expect(evalRtdb(rtRow!.predicate!, { x: 10, owner: 'a', bonus: 3 }, { x: 18, owner: 'a' })).toBe('ALLOW');
    expect(evalRtdb(rtRow!.predicate!, { x: 10, owner: 'a', bonus: 3 }, { x: 15, owner: 'a' })).toBe('DENY');
    expect(pol.judge(low).ok).toBe(false);

    // Storage nested derive projection (size <= derived.limits.max)
    const stDerive = compilePolicy(`
      use extension derive;
      transition uploadQuota {
        derive { return {'limits': {'max': before.size + 512, 'tag': 'v1'}}; }
        require withinQuota { return after.size <= derived.limits.max; }
      }
    `);
    const [stRow] = stDerive.storage({ before: 'resource', after: 'request.resource' }, 'complete');
    expect(stRow!.completeReason).toBeUndefined();
    expect(evalStorage(stRow!.predicate!, 'update', { size: 900 }, { size: 500 })).toBe('ALLOW');
    expect(evalStorage(stRow!.predicate!, 'update', { size: 1200 }, { size: 500 })).toBe('DENY');
  });

  test('prevents fail-open when a derive sibling is only read behind ||, while allowing single-leaf ||', () => {
    const twoLeafOr = compilePolicy(`
      use extension derive;
      transition t {
        derive { return {'a': before.x + 1, 'b': before.y + 1}; }
        require r1 { return after.a == derived.a; }
        require r2 { return after.ok || after.b == derived.b; }
      }
    `);
    const fsB = {
      'before.x': 'resource.data.x',
      'before.y': 'resource.data.y',
      'after.a': 'request.resource.data.a',
      'after.b': 'request.resource.data.b',
      'after.ok': 'request.resource.data.ok',
    };
    expect(() => twoLeafOr.firestore(fsB, 'complete')).toThrow(/Unverified derive outputs: b/);
    expect(() => twoLeafOr.rtdb({ before: 'data', after: 'newData' }, 'complete')).toThrow(/Gateway required/);
    expect(() => twoLeafOr.bind.rtdb({ path: '/item', bindings: { before: 'data', after: 'newData' } })).toThrow(/Unverified derive outputs: b/);
    const rtMixed = twoLeafOr.rtdb({ before: 'data', after: 'newData' }, 'mixed');
    expect(rtMixed[0]!.completeReason).toBe('Unverified derive outputs: b');

    // Partially covered nested map reports dotted sibling leaf
    const nestedMissing = compilePolicy(`
      use extension derive;
      transition t {
        derive { return {'meta': {'next': before.x + 1, 'other': before.y + 1}, 'extra': {'z': before.z + 1}}; }
        require r { return after.x == derived.meta.next; }
      }
    `).firestore({ 'before.x': 'resource.data.x', 'after.x': 'request.resource.data.x' }, 'mixed');
    expect(nestedMissing[0]!.completeReason).toBe('Unverified derive outputs: meta.other, extra');

    // Single non-literal leaf read behind || is sound and matches standalone
    const singleOr = compilePolicy(`
      use extension derive;
      transition t {
        derive { return {'a': before.x + 1}; }
        require r { return after.ok || after.a == derived.a; }
      }
    `);
    const [row] = singleOr.firestore(
      { 'before.x': 'resource.data.x', 'after.a': 'request.resource.data.a', 'after.ok': 'request.resource.data.ok' },
      'complete',
    );
    expect(row!.completeReason).toBeUndefined();
    expect(singleOr.judge({ before: {}, after: { ok: true }, input: {} })).toEqual({ ok: true });
    expect(evalFirestore(row!.predicate!, {}, { ok: true })).toBe('ALLOW');
    expect(singleOr.judge({ before: {}, after: { ok: false, a: 1 }, input: {} }).ok).toBe(false);
    expect(evalFirestore(row!.predicate!, {}, { ok: false, a: 1 })).toBe('DENY');
  });

  test('enforces trusted inputs, rejects forbidden derive keys, rejects impure derive helpers, and bounds projection size', () => {
    const src = `
      use extension derive;
      transition t {
        derive { return {'next': before.x + input.step}; }
        require r { return after.x == derived.next; }
      }
    `;
    const pol = compilePolicy(src);
    // Firestore rejects client-controlled request.resource.data input
    const [fsBad] = pol.firestore(
      { 'before.x': 'resource.data.x', 'after.x': 'request.resource.data.x', 'input.step': 'request.resource.data.step' },
      'mixed',
    );
    expect(fsBad!.predicate).toBeUndefined();
    expect(fsBad!.diagnostics.some((d) => d.code === 'UNTRUSTED_DERIVE_INPUT')).toBe(true);

    // Storage rejects request.resource input
    const [stBad] = pol.storage(
      { 'before.x': 'resource.size', 'after.x': 'request.resource.size', 'input.step': 'request.resource.size' },
      'mixed',
    );
    expect(stBad!.predicate).toBeUndefined();
    expect(stBad!.diagnostics.some((d) => d.code === 'UNTRUSTED_DERIVE_INPUT')).toBe(true);

    // RTDB rejects newData input and accepts trusted data input
    const [rtBad] = pol.rtdb({ before: 'data', after: 'newData', 'input.step': { snapshot: 'newData', path: 'step' } }, 'mixed');
    expect(rtBad!.predicate).toBeUndefined();
    expect(rtBad!.diagnostics.some((d) => d.code === 'UNTRUSTED_DERIVE_INPUT')).toBe(true);

    // Forbidden derive keys rejected from lowering
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const bad = compilePolicy(`
        use extension derive;
        transition t {
          derive { return {'${key}': 1, 'ok': before.x + 1}; }
          require r { return after.x == derived.ok; }
        }
      `).firestore({ 'before.x': 'resource.data.x', 'after.x': 'request.resource.data.x' }, 'mixed');
      expect(bad[0]!.predicate, key).toBeUndefined();
      expect(bad[0]!.reason, key).toContain('Forbidden derive output key');
    }

    // Derive calling impure helper reports USES_BOUNDED_OP and refuses lowering
    const impureDerive = compilePolicy(`
      use extension derive;
      use extension bounded;
      function countVip(xs) { return bounded.count(xs, t => t == 'vip', 8); }
      transition t {
        derive { return {'bonus': countVip(input.tags)}; }
        require r { return after.bonus == derived.bonus; }
      }
    `).firestore({ 'after.bonus': 'request.resource.data.bonus' }, 'mixed');
    expect(impureDerive[0]!.predicate).toBeUndefined();
    expect(impureDerive[0]!.diagnostics.some((d) => d.code === 'USES_BOUNDED_OP')).toBe(true);
    expect(impureDerive[0]!.reason).toContain('countVip');

    // Deep doubling derive projection hits PROJECTION_BUDGET_EXCEEDED quickly
    const dLets = ['let d0 = before.x + before.x;'];
    for (let i = 1; i <= 12; i++) dLets.push(`let d${i} = d${i - 1} + d${i - 1};`);
    const bigDerive = compilePolicy(`
      use extension derive;
      transition t {
        derive { ${dLets.join('\n')} return {'v': d12}; }
        require r { return after.x == derived.v; }
      }
    `);
    const [bigRow] = bigDerive.firestore({ 'before.x': 'resource.data.x', 'after.x': 'request.resource.data.x' }, 'mixed');
    expect(bigRow!.predicate).toBeUndefined();
    expect(bigRow!.cost.withinTargetBudget).toBe(false);
    expect(bigRow!.diagnostics.some((d) => d.code === 'PROJECTION_BUDGET_EXCEEDED' || d.code === 'EXPRESSION_BUDGET_EXCEEDED')).toBe(true);
    expect(bigRow!.cost.fallbackSummary).toContain('Fallback (standalone only)');
  });

  test('pins hardening: provePolicy surfaces firestoreModule errors and guard surfaces fatal derive limits', async () => {
    // Transition named after a Firestore builtin fails firestoreModule() emission instead of silently dropping fsEval
    const builtinConflict = provePolicy('transition get { require r { return after.x == 1; } }', {
      firestore: { 'after.x': 'request.resource.data.x' },
      fuzz: { enabled: false },
    });
    expect(builtinConflict.ok).toBe(false);
    expect(builtinConflict.targetErrors?.firestore).toMatch(/builtin/);

    // Allowed transition whose unused derive throws a fatal ResourceLimitError fails with fatalStatus (never swallowed)
    const fatalDeriveSrc = `
      use extension derive;
      use extension bounded;
      transition t {
        derive {
          let total = bounded.fold(input.items, 0, (a, x) => a + x, 2);
          return {'total': total};
        }
        require ok { return after.ok == true; }
      }
    `;
    const guard = createPolicyGuard(fatalDeriveSrc, { engine: 'standalone', fatalStatus: 422 });
    const route = guard.wrapFetch(jsonBodyExtractor(), () => new Response('ok', { status: 200 }));
    const res = await route(
      new Request('https://app.example/t', {
        method: 'POST',
        body: JSON.stringify({ before: {}, after: { ok: true }, input: { items: [1, 2, 3] } }),
      }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string; fatal?: boolean })).toMatchObject({
      error: 'POLICY_LIMIT_EXCEEDED',
      fatal: true,
    });
  });
});

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileBoundedModule, compilePolicy, interpretModule } from '../../src/policy/index.js';

const tempDir = mkdtempSync(join(tmpdir(), 'pyric-policy-val-'));
let seq = 0;
afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function loadBoth(source: string) {
  const full = source.startsWith('use extension') ? source : 'use extension bounded;\n' + source;
  const compiled = compileBoundedModule(full);
  const file = join(tempDir, `val-${seq++}.mjs`);
  writeFileSync(file, compiled.moduleSource, 'utf8');
  const mod = await import(pathToFileURL(file).href);
  const interp = interpretModule(full);
  return { mod, interp, moduleSource: compiled.moduleSource };
}

describe('Rules-v2-faithful value model parity (standalone ES module === interpreter)', () => {
  test('matches int64, float64, -0.0, NaN, Infinity, and 2^53 boundary semantics', async () => {
    const { mod, interp } = await loadBoth(`
      export function probe(x) {
        return {
          'isInt': x is int,
          'isFloat': x is float,
          'isNum': x is number,
          'eqZero': x == 0,
          'listEqPosZero': [x] == [0.0],
          'listEqNegZero': [x] == [-0.0],
          'listEqIntZero': [x] == [0],
          'inFloatZero': x in [0.0],
          'inIntZero': x in [0],
          'str': string(x)
        };
      }
      export function nanChecks(x) {
        return {
          'selfEq': x == x,
          'selfNeq': x != x,
          'isNaN': math.isNaN(x),
          'setDedup': [x, x].toSet().size(),
          'trunc': int(x),
          'round': math.round(x),
          'str': string(x)
        };
      }
      export function int64Checks(bigIntVal, bigFloatVal) {
        return {
          'crossEq': bigIntVal == bigFloatVal,
          'inSet': bigIntVal in [bigFloatVal].toSet(),
          'divTrunc': (-7) / 2,
          'remSign': (-7) % 2,
          'minDivNeg1': (-9223372036854775808) / (-1),
          'overflowAbsorbed': (9223372036854775807 + 1 == 0) || true,
          'divZeroAbsorbed': (1 / 0 == 0) || true,
          'floatDivZeroInf': (1.0 / 0.0) == float('Infinity'),
          'negMinAbsorbed': (-(-9223372036854775808) == 0) || true
        };
      }
    `);

    for (const sample of [0, -0, 1.5, 2 ** 53]) {
      expect(mod.probe(sample)).toEqual(interp.probe(sample));
    }
    expect(mod.probe(-0)).toEqual({
      isInt: false,
      isFloat: true,
      isNum: true,
      eqZero: true,
      listEqPosZero: false,
      listEqNegZero: true,
      listEqIntZero: false,
      inFloatZero: true,
      inIntZero: false,
      str: '-0.0',
    });
    expect(mod.probe(0)).toEqual({
      isInt: true,
      isFloat: false,
      isNum: true,
      eqZero: true,
      listEqPosZero: false,
      listEqNegZero: false,
      listEqIntZero: true,
      inFloatZero: false,
      inIntZero: true,
      str: '0',
    });
    expect(mod.probe(2 ** 53).isFloat).toBe(true);
    expect(mod.probe(2 ** 53).isInt).toBe(false);

    expect(mod.nanChecks(Number.NaN)).toEqual(interp.nanChecks(Number.NaN));
    expect(mod.nanChecks(Number.NaN)).toEqual({
      selfEq: false,
      selfNeq: true,
      isNaN: true,
      setDedup: 1,
      trunc: 0,
      round: 0,
      str: 'NaN',
    });

    const bigRes = mod.int64Checks(9007199254740993n, 9007199254740992);
    expect(bigRes).toEqual(interp.int64Checks(9007199254740993n, 9007199254740992));
    expect(bigRes).toEqual({
      crossEq: true,
      inSet: false,
      divTrunc: -3,
      remSign: -1,
      minDivNeg1: -9223372036854775808n,
      overflowAbsorbed: true,
      divZeroAbsorbed: true,
      floatDivZeroInf: true,
      negMinAbsorbed: true,
    });
  });

  test('supports structural equality, slicing, sets, map diffs, and standard Rules methods', async () => {
    const { mod, interp } = await loadBoth(`
      export function collections(a, b) {
        let d = b.diff(a);
        let s1 = [1, 1.0, 2].toSet();
        let s2 = [2, 3].toSet();
        return {
          'eqMap': {'a': 1, 'b': [2, 3]} == {'b': [2, 3], 'a': 1},
          'neqMixed': [1] == [1.0],
          'sliceOk': 'abcdef'[1:4],
          'sliceEmpty': [10, 20, 30][1:1],
          'sliceZeroErr': ([10][0:0] == []) || true,
          'keys': {'2': 1, '10': 2, '1': 3, 'a': 4, 'A': 5}.keys(),
          'values': {'b': 1, '1': 2, 'a': 3}.values(),
          'getNested': {'u': {'role': 'admin'}}.get(['u', 'role'], 'guest'),
          'getFallback': {'u': {}}.get(['u', 'role'], 'guest'),
          'added': d.addedKeys().hasOnly(['c']),
          'changed': d.changedKeys().hasOnly(['x']),
          'unchanged': d.unchangedKeys().hasOnly(['same']),
          'removed': d.removedKeys().hasOnly(['old']),
          'setSize': s1.size(),
          'setInter': s1.intersection(s2) == [2].toSet(),
          'setUnion': s1.union(s2).size(),
          'setDiff': s1.difference(s2) == [1].toSet(),
          'listRemove': [1, 1.0, 2].removeAll([1]),
          'listJoin': [1, 1.0, true, null].join(','),
          'asciiLower': 'AbC\u00c9'.lower(),
          'asciiUpper': 'aBc\u00e9'.upper(),
          'trimCtrl': '\\x01 hello \\x1f'.trim()
        };
      }
    `);
    const before = { same: 1, x: 10, old: true };
    const after = { same: 1.0, x: 20, c: 'new' };
    const expected = interp.collections(before, after);
    expect(mod.collections(before, after)).toEqual(expected);
    expect(expected.eqMap).toBe(true);
    expect(expected.neqMixed).toBe(false);
    expect(expected.sliceOk).toBe('bcd');
    expect(expected.sliceEmpty).toEqual([]);
    expect(expected.sliceZeroErr).toBe(true);
    expect(expected.keys).toEqual(['1', '10', '2', 'A', 'a']);
    expect(expected.values).toEqual([1, 2, 3]);
    expect(expected.added).toBe(true);
    expect(expected.changed).toBe(true);
    expect(expected.unchanged).toBe(true);
    expect(expected.removed).toBe(true);
    expect(expected.setSize).toBe(2);
    expect(expected.setInter).toBe(true);
    expect(expected.setUnion).toBe(3);
    expect(expected.setDiff).toBe(true);
    expect(expected.listRemove).toEqual([1, 2]);
    expect(expected.listJoin).toBe('1,1.0,true,null');
    expect(expected.asciiLower).toBe('abc\u00c9');
    expect(expected.asciiUpper).toBe('ABC\u00e9');
    expect(expected.trimCtrl).toBe('hello');
  });

  test('supports timestamps, durations, bytes, and math namespace consistently', async () => {
    const { mod, interp } = await loadBoth(`
      export function temporalAndBytes(rawBytes) {
        let t0 = timestamp.date(2026, 3, 15);
        let d = duration.value(90, 'm');
        let t1 = t0 + d;
        let lit = b'hi';
        let utf = 'hi'.toUtf8();
        return {
          't1Year': t1.year(),
          't1Month': t1.month(),
          't1Day': t1.day(),
          't1Hours': t1.hours(),
          't1Minutes': t1.minutes(),
          't1Dow': t1.dayOfWeek(),
          'diffSec': (t1 - t0).seconds(),
          'negDur': (-d).seconds(),
          'absDur': duration.abs(-d).seconds(),
          'isTs': t1 is timestamp,
          'isDur': d is duration,
          'tsNotMap': !(t1 is map),
          'bytesEq': lit == utf,
          'bytesHex': rawBytes.toHexString(),
          'bytesB64': rawBytes.toBase64(),
          'bytesSize': rawBytes.size(),
          'bytesLt': b'aa' < b'ab',
          'isBytes': rawBytes is bytes,
          'mathPow': math.pow(2, 3),
          'mathCeil': math.ceil(1.2),
          'mathFloor': math.floor(1.8),
          'mathRound': math.round(2.5),
          'mathAbsMin': math.abs(-9223372036854775808)
        };
      }
    `);
    const sampleBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const expected = interp.temporalAndBytes(sampleBytes);
    expect(mod.temporalAndBytes(sampleBytes)).toEqual(expected);
    expect(expected.t1Year).toBe(2026);
    expect(expected.t1Hours).toBe(1);
    expect(expected.t1Minutes).toBe(30);
    expect(expected.t1Dow).toBe(7);
    expect(expected.diffSec).toBe(5400);
    expect(expected.negDur).toBe(-5400);
    expect(expected.absDur).toBe(5400);
    expect(expected.tsNotMap).toBe(true);
    expect(expected.bytesEq).toBe(true);
    expect(expected.bytesHex).toBe('DEADBEEF');
    expect(expected.bytesSize).toBe(4);
    expect(expected.bytesLt).toBe(true);
    expect(expected.isBytes).toBe(true);
    expect(expected.mathRound).toBe(3);
    expect(expected.mathAbsMin).toBe(-9223372036854775808n);
  });

  test('evaluates RE2 matches/split/replace in guaranteed linear time and rejects non-RE2 features', async () => {
    const { mod, interp } = await loadBoth(`
      export function regexSuite(s) {
        return {
          'basic': s.matches('[a-z]+-[0-9]{2}'),
          'ciFlag': 'HeLLo'.matches('(?i)hello'),
          'quoted': 'a+b'.matches('\\\\Qa+b\\\\E'),
          'splitDrop': 'a,b,'.split(','),
          'replaceCap': 'foo123bar'.replace('([a-z]+)([0-9]+)', '$2:$1'),
          'lookaheadRejected': ('abc'.matches('(?=a).*') || true),
          'backrefRejected': ('aa'.matches('(a)\\\\1') || true),
          'noBacktrack': ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac').matches('((a+)+)b')
        };
      }
    `);
    const t0 = performance.now();
    const res = mod.regexSuite('item-42');
    const elapsedMs = performance.now() - t0;
    expect(res).toEqual(interp.regexSuite('item-42'));
    expect(res).toEqual({
      basic: true,
      ciFlag: true,
      quoted: true,
      splitDrop: ['a', 'b'],
      replaceCap: '123:foobar',
      lookaheadRejected: true,
      backrefRejected: true,
      noBacktrack: false,
    });
    expect(elapsedMs).toBeLessThan(250);
  });

  test('preserves prototype, getter, __proto__/constructor, error-absorption, and fatal-limit hardening', async () => {
    const { mod, interp } = await loadBoth(`
      export function echo(x) { return x; }
      export function readKey(x, k) { return x[k]; }
      export function anyAbsorb(xs) { return bounded.any(xs, x => x.flag, 4); }
      export function allAbsorb(xs) { return bounded.all(xs, x => x.flag, 4); }
      export function fatalNotAbsorbed(xs) { return bounded.all(xs, x => x, 1) && false; }
      export function ownProtoSafe(x) { return 'a' in x && !('constructor' in x); }
    `);

    // Non-plain prototypes and Array subclasses rejected
    class Box {
      a = 1;
    }
    class EvilArray extends Array<number> {}
    const evilArr = new EvilArray();
    evilArr.push(1);
    for (const evil of [new Box(), Object.create({ a: 1 }), new Map(), new Date(), evilArr]) {
      expect(() => mod.echo(evil)).toThrow(/plain/);
      expect(() => interp.echo(evil)).toThrow(/plain/);
    }

    // Enumerable, non-enumerable, symbol, and array-attached getters rejected without invoking them
    let called = false;
    const enumGetter = { get x() { called = true; return 1; } };
    const nonEnumGetter = {};
    Object.defineProperty(nonEnumGetter, 'hidden', { get() { called = true; return 1; }, enumerable: false });
    const symGetter: Record<PropertyKey, unknown> = {};
    Object.defineProperty(symGetter, Symbol('trap'), { get() { called = true; return 1; } });
    const arrGetter = [1];
    Object.defineProperty(arrGetter, 'trap', { get() { called = true; return 1; } });
    for (const trap of [enumGetter, nonEnumGetter, symGetter, arrGetter]) {
      expect(() => mod.echo(trap)).toThrow(/data|symbols/);
      expect(() => interp.echo(trap)).toThrow(/data|symbols/);
    }
    expect(called).toBe(false);

    // constructor, __proto__, prototype lookups AND own forbidden keys rejected
    expect(() => mod.readKey({}, 'constructor')).toThrow(/own data/);
    expect(() => mod.readKey({}, '__proto__')).toThrow(/own data/);
    expect(() => mod.readKey({}, 'prototype')).toThrow(/own data/);
    expect(() => interp.readKey({}, 'constructor')).toThrow();
    expect(() => interp.readKey({}, '__proto__')).toThrow();
    expect(mod.ownProtoSafe({ a: 1 })).toBe(true);
    expect(interp.ownProtoSafe({ a: 1 })).toBe(true);

    const parsedProto = JSON.parse('{"__proto__":{"polluted":true}}');
    const ownCtor = { constructor: 1 };
    const ownProtoKey = { prototype: 1 };
    for (const badRecord of [parsedProto, ownCtor, ownProtoKey]) {
      expect(() => mod.echo(badRecord)).toThrow(/forbidden/);
      expect(() => interp.echo(badRecord)).toThrow(/forbidden/);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    // Error absorption in bounded.any and bounded.all vs fatal bound errors
    expect(mod.anyAbsorb([{}, { flag: true }])).toBe(true);
    expect(interp.anyAbsorb([{}, { flag: true }])).toBe(true);
    expect(() => mod.anyAbsorb([{}, { flag: false }])).toThrow(/own data/);
    expect(mod.allAbsorb([{}, { flag: false }])).toBe(false);
    expect(interp.allAbsorb([{}, { flag: false }])).toBe(false);
    expect(() => mod.allAbsorb([{}, { flag: true }])).toThrow(/own data/);
    expect(() => mod.fatalNotAbsorbed([true, true])).toThrow(/bound/);
    expect(() => interp.fatalNotAbsorbed([true, true])).toThrow(/limit|bound/);
  });

  test('compilePolicy revives -0/2^53 host numbers and distinguishes recoverable vs fatal require bindings', async () => {
    const policy = compilePolicy(`
      use extension bounded;
      transition hostNumericAndErrors {
        require negZeroIsFloat {
          return before.z is float && before.big is float && after.count == before.count + 1;
        }
        require absorbedRequireBinding {
          let n = bounded.count(input.maybeList, x => x > 0, 2);
          return n == 0 || input.fallback;
        }
      }
    `);
    const file = join(tempDir, `pol-${seq++}.mjs`);
    writeFileSync(file, policy.standaloneModule().moduleSource, 'utf8');
    const mod = await import(pathToFileURL(file).href);

    const okInput = {
      before: { z: -0, big: 2 ** 53, count: 5 },
      after: { count: 6 },
      input: { fallback: true },
    };
    expect(policy.judge(okInput)).toEqual({ ok: true });
    expect(mod.judge(okInput)).toEqual({ ok: true });

    const mismatch = {
      before: { z: -0, big: 2 ** 53, count: 5 },
      after: { count: 9 },
      input: { maybeList: [1], fallback: true },
    };
    const mv = policy.judge(mismatch);
    expect(mv.ok).toBe(false);
    if (!mv.ok) expect(mv.reason).toBe('after.count was 9, expected 6');
    expect(mod.judge(mismatch).ok).toBe(false);

    const overBound = {
      before: { z: -0, big: 2 ** 53, count: 5 },
      after: { count: 6 },
      input: { maybeList: [1, 2, 3], fallback: true },
    };
    const fv = policy.judge(overBound);
    const mfv = mod.judge(overBound);
    expect(fv.ok).toBe(false);
    expect(mfv.ok).toBe(false);
    if (!fv.ok) expect(fv.fatal).toBe(true);
    expect(mfv.fatal).toBe(true);
  });
});

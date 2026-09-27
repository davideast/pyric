import { describe, it, expect } from 'bun:test';
import { parseStorageRules } from '../../../src/storage/sandbox/rules.js';
import { evaluateStorageRules } from '../../../src/storage/sandbox/rules-evaluator.js';
import { typeMatches } from '../../../src/storage/sandbox/rules-operators.js';
import { StorageLatLng } from '../../../src/storage/sandbox/rules-latlng.js';
import { StoragePath } from '../../../src/storage/sandbox/rules-path.js';

// ─── Operators over Timestamp, Duration, and Bytes values ────────
//
// rules-storage-stdlib-timestamp-duration captures production's
// "Unsupported operation error. Received: timestamp < int." for a timestamp
// compared with an int.

const path = 'b/pyric-default/o/docs/d1.json';

function evalRead(cond: string): { allowed: boolean; reasons: string[] } {
  const rules = parseStorageRules(`service firebase.storage {
    match /b/{bucket}/o {
      match /docs/{docId} { allow read: if ${cond}; }
    }
  }`);
  return evaluateStorageRules(
    rules,
    { request: { auth: { uid: 'alice' }, method: 'read', path }, resource: { size: 10 } },
    new Date('2025-06-15T13:45:30.250Z'),
  );
}

describe('evaluateStorageRules — value operators', () => {
  it('compares timestamps and durations by value', () => {
    expect(evalRead('timestamp.value(1000) == timestamp.value(1000)').allowed).toBe(true);
    expect(evalRead('timestamp.value(1000) < timestamp.value(2000)').allowed).toBe(true);
    expect(evalRead("duration.value(1, 's') <= duration.value(1000, 'ms')").allowed).toBe(true);
    expect(evalRead("duration.value(1, 's') == duration.value(1000, 'ms')").allowed).toBe(true);
  });

  it('adds a timestamp and a duration in either order', () => {
    expect(evalRead("duration.value(1, 's') + timestamp.value(0) == timestamp.value(1000)").allowed).toBe(true);
  });

  it('denies comparing a timestamp with an int, through a negation too', () => {
    const r = evalRead('!(request.time < 0)');
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('Unsupported operation error. Received: timestamp < int.');
  });

  it('denies arithmetic between a timestamp and an int', () => {
    const r = evalRead('request.time + 1000 > request.time');
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(' ')).toContain('Received: timestamp + int.');
  });

  it('compares bytes by value and in byte order', () => {
    expect(evalRead("'a'.toUtf8() < 'b'.toUtf8() && 'a'.toUtf8() == 'a'.toUtf8()").allowed).toBe(true);
  });

  it('keeps int and float comparisons numeric', () => {
    expect(evalRead('1 < 1.5 && 2.0 == 2').allowed).toBe(true);
  });
});

// ─── Arithmetic operators over every operand pair ────────────────
//
// rules-storage-arithmetic-operand-types captures production's `+`: string +
// string concatenates, int and float add with float promotion, and every
// other pair (list + list, string + int, int + string, list + string,
// map + map) is "Unsupported operation error. Received: <left> + <right>.",
// an error value that `||` absorbs and that survives `!=` and `!`. `-`, `*`,
// `/`, and `%` on strings or lists are the same error.

describe('evaluateStorageRules arithmetic over operand types', () => {
  it('concatenates two strings, including a path built from bindings', () => {
    expect(evalRead("'a' + 'b' == 'ab'").allowed).toBe(true);
    expect(evalRead("'docs/' + docId == 'docs/d1.json'").allowed).toBe(true);
    expect(evalRead("'docs/' + docId != 'docs/d1.json'").allowed).toBe(false);
  });

  it('adds ints and promotes an int plus a float to a float', () => {
    expect(evalRead('1 + 2 == 3 && (resource.size + 1) is int').allowed).toBe(true);
    expect(evalRead('resource.size + 1.5 == 11.5 && (resource.size + 1.5) is float').allowed).toBe(true);
    expect(evalRead('1.5 + 1 == 2.5 && (1.5 + 1) is float').allowed).toBe(true);
  });

  const unsupported: Array<[string, string]> = [
    ['[1] + [2]', 'list + list'],
    ["docId + resource.size", 'string + int'],
    ["resource.size + docId", 'int + string'],
    ["docId.split('[.]') + docId", 'list + string'],
    ["docId + docId.split('[.]')", 'string + list'],
    ["{'a': 1} + {'b': 2}", 'map + map'],
    ['docId + null', 'string + null'],
    ['true + true', 'bool + bool'],
  ];

  for (const [sum, received] of unsupported) {
    it(`denies ${received} as an unsupported operation, through != and !`, () => {
      const neq = evalRead(`${sum} != 'zzz'`);
      expect(neq.allowed).toBe(false);
      expect(neq.reasons.join(' ')).toContain(`Unsupported operation error. Received: ${received}.`);
      expect(evalRead(`!(${sum} == 'zzz')`).allowed).toBe(false);
    });

    it(`absorbs the ${received} error through ||`, () => {
      expect(evalRead(`(${sum} == 'zzz') || true`).allowed).toBe(true);
    });
  }

  it('denies -, *, /, and % on operands that are not numbers', () => {
    for (const [expr, received] of [
      ["docId - 'a'", 'string - string'],
      ['docId * 2', 'string * int'],
      ['docId / docId', 'string / string'],
      ['docId % docId', 'string % string'],
      ['[1, 2] - [1]', 'list - list'],
      ["docId / 0", 'string / int'],
    ]) {
      const r = evalRead(`${expr} != 'zzz'`);
      expect(r.allowed).toBe(false);
      expect(r.reasons.join(' ')).toContain(`Unsupported operation error. Received: ${received}.`);
    }
  });
});

// ─── Ordering operators over every operand pair ──────────────────
//
// rules-storage-ordering-operand-types captures production's `<`, `>`, `<=`,
// and `>=`: int and float order by value, strings order lexicographically,
// and every other pair (int < string, bool < bool, list < list, map < map,
// int < null) is "Unsupported operation error. Received: <left> <op>
// <right>.", an error value that survives `!`, that `|| true` and
// `&& false` absorb, and that denies on its own. `==` and `!=` across types
// are false and true, not errors.

describe('evaluateStorageRules ordering over operand types', () => {
  it('orders ints and floats by value and strings lexicographically', () => {
    expect(evalRead('resource.size < 10.5 && 9.5 <= resource.size && resource.size >= 10').allowed).toBe(true);
    expect(evalRead("docId < 'e' && docId >= 'd'").allowed).toBe(true);
    expect(evalRead("docId > 'e'").allowed).toBe(false);
  });

  const unsupported: Array<[string, string]> = [
    ['resource.size < docId', 'int < string'],
    ['docId >= resource.size', 'string >= int'],
    ['docId > 2', 'string > int'],
    ["1 < 'a'", 'int < string'],
    ["'a' >= 2", 'string >= int'],
    ["false < (docId == 'd1.json')", 'bool < bool'],
    ["(docId == 'd1.json') <= resource.size", 'bool <= int'],
    ["docId.split('[.]') < ['z']", 'list < list'],
    ["{'k': 'v'} > {'k': 'w'}", 'map > map'],
    ['resource.size < null', 'int < null'],
    ['null >= null', 'null >= null'],
    ['1.5 < docId', 'float < string'],
  ];

  for (const [comparison, received] of unsupported) {
    it(`denies ${received} as an unsupported operation, through !`, () => {
      const bare = evalRead(comparison);
      expect(bare.allowed).toBe(false);
      expect(bare.reasons.join(' ')).toContain(`Unsupported operation error. Received: ${received}.`);
      const negated = evalRead(`!(${comparison})`);
      expect(negated.allowed).toBe(false);
      expect(negated.reasons.join(' ')).toContain(`Unsupported operation error. Received: ${received}.`);
    });

    it(`absorbs the ${received} error through || true and && false`, () => {
      expect(evalRead(`(${comparison}) || true`).allowed).toBe(true);
      expect(evalRead(`!((${comparison}) && false)`).allowed).toBe(true);
      expect(evalRead(`!((${comparison}) && true)`).allowed).toBe(false);
    });
  }

  it('denies a timestamp ordered against an int in either position', () => {
    expect(evalRead('!(request.time > resource.size)').reasons.join(' '))
      .toContain('Unsupported operation error. Received: timestamp > int.');
    expect(evalRead('!(resource.size <= request.time)').reasons.join(' '))
      .toContain('Unsupported operation error. Received: int <= timestamp.');
  });

  it('evaluates == and != across types as false and true, not an error', () => {
    expect(evalRead('resource.size == docId').allowed).toBe(false);
    expect(evalRead('resource.size != docId').allowed).toBe(true);
    expect(evalRead('!(resource.size == docId)').allowed).toBe(true);
    expect(evalRead("1 != '1'").allowed).toBe(true);
    expect(evalRead("(docId == 'd1.json') != 1").allowed).toBe(true);
    expect(evalRead('request.time != resource.size').allowed).toBe(true);
    expect(evalRead("docId.split('[.]') != {'k': 'v'}").allowed).toBe(true);
    expect(evalRead('null != resource.size').allowed).toBe(true);
  });
});

describe('evaluateStorageRules — is over value types', () => {
  it('types timestamps, durations, and bytes', () => {
    expect(evalRead("request.time is timestamp && duration.value(1, 's') is duration && 'a'.toUtf8() is bytes").allowed)
      .toBe(true);
  });

  it('does not type a timestamp as an int or an int as a timestamp', () => {
    expect(evalRead('!(request.time is int) && !(resource.size is timestamp)').allowed).toBe(true);
  });

  it('denies a type test the evaluator cannot answer', () => {
    expect(evalRead('resource.size is latlng || true').allowed).toBe(true);
    expect(evalRead('resource.size is latlng').allowed).toBe(false);
  });
});

describe('typeMatches — latlng, path, and null', () => {
  it('supports null type check', () => {
    expect(typeMatches(null, 'null')).toBe(true);
    expect(typeMatches('not null', 'null')).toBe(false);
    expect(typeMatches(undefined, 'null')).toBe(false);
  });

  it('supports path type check', () => {
    const p = new StoragePath('users/alice');
    expect(typeMatches(p, 'path')).toBe(true);
    expect(typeMatches('users/alice', 'path')).toBe(false);
  });

  it('supports latlng type check', () => {
    const ll = new StorageLatLng(37.7749, -122.4194);
    expect(typeMatches(ll, 'latlng')).toBe(true);
    expect(typeMatches({ latitude: 37.7749, longitude: -122.4194 }, 'latlng')).toBe(false);
  });
});


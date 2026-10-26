// RTDB hunt 2026-10 findings CS-2, CS-3, CS-13, CS-14, CS-15, CS-16 (#1247).
// Each case is the finding's repro, asserting the contract the finding cites.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  all, any, defineRtdbRules, fieldIsBoolean, fieldIsNumber, fieldIsString, hasChild, hasRole, isMember,
  ownPath, rootEquals, rootExists, rtdbRules, rtdbStdlib,
} from '../../../../src/rules/index.js';
import { RTDB_STDLIB_MODULES } from '../../../../src/rules/rtdb/stdlib/catalog.js';
import { dataParentVal, newDataParentVal } from '../../../../src/rules/rtdb/constraints/data.js';
import type { PathDef } from '../../../../src/rules/rtdb/constraints/types.js';

const cast = (def: unknown): PathDef => def as PathDef;
const toJson = (def: PathDef) => rtdbRules(defineRtdbRules({ paths: { '/a': def } })).toJSON();

describe('CS-2: falsy rule values are kept or refused', () => {
  test('validate: false is written as .validate false', () => {
    expect((toJson(cast({ write: 'true', validate: false })).rules as any).a['.validate']).toBe(false);
  });
  test('validate: false denies a write', () => {
    const rs = rtdbRules(defineRtdbRules({ paths: { '/a': cast({ write: 'true', validate: false }) } }));
    const r = rs.simulate([{ expectation: 'DENY', operation: 'write', path: '/a', auth: { uid: 'u', token: {} }, newData: 1 }]).cases[0]!;
    expect(r.decision).toBe('DENY');
  });
  test('an empty rule string is refused', () => {
    expect(() => toJson(cast({ write: 'true', validate: '' }))).toThrow(/validate/);
  });
  test('read: false and write: false are kept', () => {
    const json = toJson(cast({ read: false, write: false })).rules as any;
    expect(json.a['.read']).toBe(false);
    expect(json.a['.write']).toBe(false);
  });
  test('a shape() field rule of true keeps a validate rule', () => {
    const s = rtdbStdlib.validation.shape({ a: true as never });
    const json = rtdbRules(defineRtdbRules({ paths: { '/r': s } })).toJSON().rules as any;
    expect(json.r.a['.validate']).toBe(true);
  });
  test('a child definition that is not an object or boolean is refused', () => {
    expect(() => toJson(cast({ children: { '/b': '' } }))).toThrow(/\/a\/b/);
  });
});

describe('CS-3: unknown PathDef keys are refused', () => {
  test('a typo names the key and the nearest valid key', () => {
    expect(() => toJson(cast({ write: 'true', valdiate: 'newData.isString()' }))).toThrow(/valdiate.*validate/);
  });
  test('a nested child path def is checked too', () => {
    expect(() => toJson(cast({ children: { '/b': { raed: 'true' } } }))).toThrow(/raed.*read/);
  });
  test('a key with no near match is still named', () => {
    expect(() => toJson(cast({ zzzzzzzz: 1 }))).toThrow(/zzzzzzzz/);
  });
});

describe('CS-13: builders refuse keys RTDB rejects', () => {
  const refused: Array<[string, () => unknown]> = [
    ["hasChild('')", () => hasChild('')],
    ["fieldIsString('a#')", () => fieldIsString('a#')],
    ["fieldIsNumber('a.b')", () => fieldIsNumber('a.b')],
    ["fieldIsBoolean('a[')", () => fieldIsBoolean('a[')],
    ['rootExists([])', () => rootExists([])],
    ["rootExists([''])", () => rootExists([''])],
    ["rootExists(['a$'])", () => rootExists(['a$'])],
    ["rootEquals([''], 'x')", () => rootEquals([''], 'x')],
    ["hasRole(['roles', ''], 'admin')", () => hasRole(['roles', ''], 'admin')],
    ["isMember('', 'roomId')", () => isMember('', 'roomId')],
    ["isMember('members', '$roomId')", () => isMember('members', '$roomId')],
    ["ownPath('')", () => ownPath('')],
  ];
  for (const [name, call] of refused) test(`${name} throws`, () => expect(call).toThrow());
  test('valid calls still build', () => {
    expect(hasChild('a')).toBe("newData.hasChild('a')");
    expect(rootExists(['rooms', { $: '$roomId' }])).toBe("root.child('rooms').child($roomId).exists()");
    expect(isMember('members', 'roomId')).toBe("root.child('members').child($roomId).child(auth.uid).exists()");
    expect(ownPath('$uid')).toBe('auth.uid == $uid');
  });
});

describe('CS-14: whitespace-only operands are dropped', () => {
  test('all and any drop them', () => {
    expect(all('  ', 'auth != null')).toBe('auth != null');
    expect(any(' ', 'auth != null')).toBe('auth != null');
  });
  test('only whitespace operands leave nothing', () => {
    expect(() => all(' ')).toThrow();
    expect(() => any('\t')).toThrow();
  });
});

describe('CS-15: fromFirebaseJson edges', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cs15-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ database: { rules: 'db.rules.json' } }));
  writeFileSync(join(dir, 'db.rules.json'), JSON.stringify({ rules: { a: { '.read': "root.child('x').exists()" } } }));
  const fj = join(dir, 'firebase.json');

  test("projectId '' is not an instance name", () => {
    const c = rtdbRules.fromFirebaseJson(fj, { projectId: '' })
      .simulate([{ expectation: 'ALLOW', operation: 'read', path: '/a' }]).cases[0]!;
    expect(c.instance).not.toBe('-default-rtdb');
  });
  const run = (instances: Record<string, unknown>) => rtdbRules.fromFirebaseJson(fj, { projectId: 'p' })
    .simulate([{ expectation: 'ALLOW', operation: 'read', path: '/a', data: { instances } as never }]).cases[0]!.decision;
  test('duplicate instance aliases are UNSUPPORTED in either key order', () => {
    expect(run({ 'p-default-rtdb': { x: 1 }, default: {} })).toBe('UNSUPPORTED');
    expect(run({ default: {}, 'p-default-rtdb': { x: 1 } })).toBe('UNSUPPORTED');
  });
});

describe('CS-16: catalog and builder agree on null', () => {
  test('the catalog signature does not advertise null and the builder refuses it', () => {
    const entry = RTDB_STDLIB_MODULES.flatMap((m) => m.entries).find((e) => e.name === 'hasClaim')!;
    expect(entry.signature).not.toMatch(/null/);
    expect(() => rtdbStdlib.auth.hasClaim('x', null as never)).toThrow(/null/);
  });
});

// LD-11 (builder half; the lint half, a 20,000-term expression, is stream S5): a huge
// count is a typed error naming the argument and its limit, not a raw RangeError.
describe('LD-11: bounded builder counts', () => {
  const t = rtdbStdlib.turns;
  const calls: Array<[string, () => unknown, RegExp]> = [
    ['isSeatTurn', () => t.isSeatTurn(1e21), /seatCount.*1 to 1000/],
    ['turnAdvanced', () => t.turnAdvanced(1e21), /seatCount.*1 to 1000/],
    ['slotKey', () => rtdbStdlib.collections.slotKey('$s', 1e21), /max.*1 to 1000/],
    ['dataParentVal', () => dataParentVal(1e21, 'x'), /depth.*1 to 32/],
    ['newDataParentVal', () => newDataParentVal(1e21, 'x'), /depth.*1 to 32/],
  ];
  for (const [name, call, message] of calls) {
    test(`${name} refuses 1e21`, () => {
      expect(call).toThrow(message);
      expect(call).not.toThrow(RangeError);
    });
  }
  test('the limits themselves still build', () => {
    expect(() => t.isSeatTurn(1000)).not.toThrow();
    expect(() => dataParentVal(32, 'x')).not.toThrow();
  });
});

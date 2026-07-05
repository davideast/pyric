/**
 * Bytes wrapper contract tests (Item 5.3) — equals + serialization +
 * coercion + method dispatch + binaryOp lex compare + integration with
 * the evaluator's String.toUtf8() and hashing.* dispatch.
 *
 * Per type table (rules.Bytes):
 *   size() → Integer    byte count
 *   toBase64() → String  base64url, no padding
 *   toHexString() → String  lowercase hex
 *
 * Per 0.B contract:
 *   typeName='bytes', valueOf=byte length, toString=base64url,
 *   equals=byte-by-byte, binaryOp=lexicographic for < <= > >=.
 */
import { describe, test, expect } from 'bun:test';
import { Bytes } from '../../../../src/rules/simulator/wrappers/bytes.js';
import { NO_OP } from '../../../../src/rules/simulator/wrappers/base.js';
import { SimulateFirestoreRulesHandler } from '../../../../src/rules/simulator/handler.js';
import type { TestCase } from '../../../../../src/rules/firestore/test/spec.js';

// ─── Wrapper-level tests ───────────────────────────────────────────────────

describe('Bytes — construction', () => {
  test('fromUtf8 encodes ASCII', () => {
    expect(Bytes.fromUtf8('abc').data).toEqual(new Uint8Array([97, 98, 99]));
  });

  test('fromUtf8 encodes multi-byte UTF-8', () => {
    // 'é' is U+00E9 → 0xC3 0xA9 in UTF-8
    expect(Bytes.fromUtf8('é').data).toEqual(new Uint8Array([0xC3, 0xA9]));
  });

  test('fromHex parses lowercase', () => {
    expect(Bytes.fromHex('deadbeef').data).toEqual(new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]));
  });

  test('fromHex on odd-length input throws', () => {
    expect(() => Bytes.fromHex('abc')).toThrow();
  });
});

describe('Bytes — equals (0.B contract)', () => {
  test('two instances with same bytes are value-equal', () => {
    const a = Bytes.fromUtf8('hello');
    const b = Bytes.fromUtf8('hello');
    expect(a === b).toBe(false);
    expect(a.equals(b)).toBe(true);
    expect(b.equals(a)).toBe(true);
  });

  test('different bytes are not equal', () => {
    expect(Bytes.fromUtf8('hi').equals(Bytes.fromUtf8('hii'))).toBe(false);
    expect(Bytes.fromUtf8('hi').equals(Bytes.fromUtf8('Hi'))).toBe(false);
  });

  test('empty bytes equal each other', () => {
    expect(new Bytes(new Uint8Array()).equals(new Bytes(new Uint8Array()))).toBe(true);
  });

  test('not equal to non-Bytes values', () => {
    expect(Bytes.fromUtf8('x').equals(null)).toBe(false);
    expect(Bytes.fromUtf8('x').equals('x')).toBe(false);
    expect(Bytes.fromUtf8('x').equals(new Uint8Array([0x78]))).toBe(false);
  });
});

describe('Bytes — serialization (0.B contract)', () => {
  test('toJSON shape', () => {
    const json = JSON.parse(JSON.stringify(Bytes.fromUtf8('hi'))) as { __type: string; base64: string };
    expect(json.__type).toBe('bytes');
    expect(json.base64).toBe('aGk'); // 'hi' base64url, no padding
  });

  test('toString returns base64url (RFC 4648 URL-safe, no padding)', () => {
    // 0x3E and 0x3F decode to '+' and '/' in standard base64;
    // base64url uses '-' and '_'. Verify with bytes that exercise both.
    const b = new Bytes(new Uint8Array([0xFB, 0xFF, 0xFE])); // → +//+ in base64
    expect(String(b)).not.toContain('+');
    expect(String(b)).not.toContain('/');
    expect(String(b)).not.toContain('=');
  });
});

describe('Bytes — coercion (0.B contract)', () => {
  test('Number() returns byte count', () => {
    expect(Number(Bytes.fromUtf8('hello'))).toBe(5);
    expect(Bytes.fromUtf8('hello').valueOf()).toBe(5);
  });
});

describe('Bytes — method dispatch', () => {
  test('size returns byte count', () => {
    expect(Bytes.fromUtf8('hello').callMethod('size', [])).toBe(5);
    // Multi-byte UTF-8: 'é' is 2 bytes, not 1 codepoint.
    expect(Bytes.fromUtf8('é').callMethod('size', [])).toBe(2);
  });

  test('toBase64 returns base64url', () => {
    expect(Bytes.fromUtf8('hi').callMethod('toBase64', [])).toBe('aGk');
  });

  test('toHexString returns lowercase hex', () => {
    expect(Bytes.fromHex('DEADBEEF').callMethod('toHexString', [])).toBe('deadbeef');
  });

  test('unknown method returns NO_OP', () => {
    expect(Bytes.fromUtf8('x').callMethod('mystery', [])).toBe(NO_OP);
  });
});

describe('Bytes — binaryOp (lexicographic)', () => {
  test('shorter prefix < longer', () => {
    const a = new Bytes(new Uint8Array([1, 2]));
    const b = new Bytes(new Uint8Array([1, 2, 3]));
    expect(a.binaryOp('<', b)).toBe(true);
    expect(a.binaryOp('>', b)).toBe(false);
    expect(a.binaryOp('<=', b)).toBe(true);
  });

  test('byte-wise compare', () => {
    const a = new Bytes(new Uint8Array([1, 2]));
    const b = new Bytes(new Uint8Array([1, 3]));
    expect(a.binaryOp('<', b)).toBe(true);
    expect(b.binaryOp('>', a)).toBe(true);
  });

  test('equal lengths and bytes → all comparisons reflect equality', () => {
    const a = new Bytes(new Uint8Array([5, 5]));
    const b = new Bytes(new Uint8Array([5, 5]));
    expect(a.binaryOp('<=', b)).toBe(true);
    expect(a.binaryOp('>=', b)).toBe(true);
    expect(a.binaryOp('<', b)).toBe(false);
    expect(a.binaryOp('>', b)).toBe(false);
  });

  test('non-Bytes other returns NO_OP', () => {
    expect(Bytes.fromUtf8('x').binaryOp('<', 'string')).toBe(NO_OP);
    expect(Bytes.fromUtf8('x').binaryOp('<', 5)).toBe(NO_OP);
  });
});

// ─── Integration tests through the evaluator ───────────────────────────────

const sim = new SimulateFirestoreRulesHandler();

function rules(condition: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{id} {
      allow create: if ${condition};
    }
  }
}`;
}

function tc(condition: string, expectation: 'ALLOW' | 'DENY'): TestCase {
  return {
    description: condition,
    expectation,
    method: 'create',
    path: 'docs/d1',
    auth: { uid: 'u1' },
    data: {},
  };
}

describe('String.toUtf8() — through evaluator', () => {
  test("'hello'.toUtf8().size() == 5", () => {
    const r = sim.simulate(
      rules("'hello'.toUtf8().size() == 5"),
      [tc('utf8 size', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test("'é'.toUtf8().size() == 2 (multi-byte UTF-8)", () => {
    const r = sim.simulate(
      rules("'é'.toUtf8().size() == 2"),
      [tc('multibyte size', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test("'hi'.toUtf8() is bytes", () => {
    const r = sim.simulate(
      rules("'hi'.toUtf8() is bytes"),
      [tc('is bytes', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test("toUtf8 round-trips through toBase64", () => {
    const r = sim.simulate(
      rules("'hi'.toUtf8().toBase64() == 'aGk'"),
      [tc('base64 round-trip', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test("toUtf8 round-trips through toHexString", () => {
    const r = sim.simulate(
      rules("'hi'.toUtf8().toHexString() == '6869'"),
      [tc('hex round-trip', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test("two equal-byte Bytes compare equal via ==", () => {
    const r = sim.simulate(
      rules("'abc'.toUtf8() == 'abc'.toUtf8()"),
      [tc('bytes equality', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });
});

describe('hashing.* — through evaluator', () => {
  test('hashing.md5 of empty string has known value', () => {
    // md5('') = d41d8cd98f00b204e9800998ecf8427e
    const r = sim.simulate(
      rules("hashing.md5('').toHexString() == 'd41d8cd98f00b204e9800998ecf8427e'"),
      [tc('md5 empty', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('hashing.md5 of "hello"', () => {
    // md5('hello') = 5d41402abc4b2a76b9719d911017c592
    const r = sim.simulate(
      rules("hashing.md5('hello').toHexString() == '5d41402abc4b2a76b9719d911017c592'"),
      [tc('md5 hello', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('hashing.sha256 of empty string has known value', () => {
    // sha256('') = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const r = sim.simulate(
      rules(
        "hashing.sha256('').toHexString() == 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'",
      ),
      [tc('sha256 empty', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('hashing.sha256 of "abc"', () => {
    // sha256('abc') = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    const r = sim.simulate(
      rules(
        "hashing.sha256('abc').toHexString() == 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'",
      ),
      [tc('sha256 abc', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('hashing.crc32 of "123456789" = 0xCBF43926 (IEEE 802.3 reference)', () => {
    const r = sim.simulate(
      rules("hashing.crc32('123456789').toHexString() == 'cbf43926'"),
      [tc('crc32 ref', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('hashing.crc32c of "123456789" = 0xE3069283 (Castagnoli reference)', () => {
    const r = sim.simulate(
      rules("hashing.crc32c('123456789').toHexString() == 'e3069283'"),
      [tc('crc32c ref', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('hashing.* result is bytes', () => {
    const r = sim.simulate(
      rules("hashing.md5('x') is bytes"),
      [tc('hash result is bytes', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('hashing accepts pre-encoded Bytes too', () => {
    const r = sim.simulate(
      rules("hashing.md5('hello'.toUtf8()) == hashing.md5('hello')"),
      [tc('Bytes input == String input for same UTF-8', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test('unknown hashing method → UNSUPPORTED', () => {
    const r = sim.simulate(
      rules("hashing.sha512('x').size() == 64"),
      [tc('unknown alg', 'ALLOW')],
    );
    expect(r.success && r.data.unsupported).toBe(1);
  });
});

describe('Bytes — lexicographic ordering through evaluator', () => {
  test("'aa'.toUtf8() < 'ab'.toUtf8()", () => {
    const r = sim.simulate(
      rules("'aa'.toUtf8() < 'ab'.toUtf8()"),
      [tc('bytes lex <', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test("'ab'.toUtf8() > 'aa'.toUtf8()", () => {
    const r = sim.simulate(
      rules("'ab'.toUtf8() > 'aa'.toUtf8()"),
      [tc('bytes lex >', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });

  test("'a'.toUtf8() <= 'a'.toUtf8()", () => {
    const r = sim.simulate(
      rules("'a'.toUtf8() <= 'a'.toUtf8()"),
      [tc('bytes lex <=', 'ALLOW')],
    );
    expect(r.success && r.data.passed).toBe(1);
  });
});

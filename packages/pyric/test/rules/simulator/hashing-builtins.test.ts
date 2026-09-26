import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { evaluateHashingMethod } from '../../../src/rules/simulator/hashing-builtins.js';
import { Bytes } from '../../../src/rules/simulator/wrappers/bytes.js';

function hexOf(method: string, input: string | Bytes): string {
  return (evaluateHashingMethod(method, [input]) as Bytes).toHexString();
}

/** Deterministic bytes covering every octet value. */
function patternBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

describe('hashing built-ins', () => {
  test('hashes string input to the production byte representation', () => {
    const digest = evaluateHashingMethod('sha256', ['abc']) as Bytes;
    expect(digest.toHexString()).toBe('BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD');
  });
});

describe('hashing.md5 matches the RFC 1321 test suite', () => {
  const vectors: Array<[string, string]> = [
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['a', '0cc175b9c0f1b6a831c399e269772661'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
    ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
    [
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
      'd174ab98d277d9f5a5611c2c9f419d9f',
    ],
    [
      '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
      '57edf4a22be3c955ac49da2e2107b67a',
    ],
  ];
  for (const [input, expected] of vectors) {
    test(`md5(${JSON.stringify(input)})`, () => {
      expect(hexOf('md5', input)).toBe(expected.toUpperCase());
    });
  }
});

describe('hashing.sha256 matches the FIPS 180-4 examples', () => {
  const vectors: Array<[string, string]> = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    [
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
    ],
  ];
  for (const [input, expected] of vectors) {
    test(`sha256(${JSON.stringify(input.length > 16 ? `${input.slice(0, 16)}...` : input)})`, () => {
      expect(hexOf('sha256', input)).toBe(expected.toUpperCase());
    });
  }

  test('sha256 of one million "a" characters', () => {
    expect(hexOf('sha256', 'a'.repeat(1_000_000))).toBe(
      'CDC76E5C9914FB9281A1C7E284D73E67F1809A48A497200E046D39CCC7112CD0',
    );
  });
});

describe('hashing.md5 and hashing.sha256 agree with node:crypto', () => {
  for (const method of ['md5', 'sha256'] as const) {
    test(`${method} over Bytes of every length from 0 to 300`, () => {
      for (let length = 0; length <= 300; length++) {
        const data = patternBytes(length);
        const digest = evaluateHashingMethod(method, [new Bytes(data)]) as Bytes;
        const expected = createHash(method).update(data).digest();
        expect({ length, bytes: Array.from(digest.data) }).toEqual({ length, bytes: Array.from(expected) });
        expect(digest.toHexString()).toBe(expected.toString('hex').toUpperCase());
        expect(digest.toBase64()).toBe(expected.toString('base64').replace(/\+/g, '-').replace(/\//g, '_'));
      }
    });

    test(`${method} over strings of every length from 0 to 300`, () => {
      for (let length = 0; length <= 300; length++) {
        const input = 'x'.repeat(length);
        const expected = createHash(method).update(input, 'utf8').digest('hex').toUpperCase();
        expect({ length, hex: hexOf(method, input) }).toEqual({ length, hex: expected });
      }
    });

    test(`${method} hashes non-ASCII strings as their UTF-8 bytes`, () => {
      for (const input of ['é', 'naïve café', '日本語のテキスト', '😀 emoji', 'Ω'.repeat(40), '\u0000￿']) {
        const expected = createHash(method).update(input, 'utf8').digest('hex').toUpperCase();
        expect(hexOf(method, input)).toBe(expected);
      }
    });
  }
});

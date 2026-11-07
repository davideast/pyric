import { describe, expect, test } from 'bun:test';
import { randomKey, realmHash, sipHash, utf8 } from '../src/keyed-hash.js';

/** The key of the SipHash paper's test vectors: bytes 00 to 0f. */
const VECTOR_KEY = Uint8Array.from({ length: 16 }, (_, index) => index);
const message = (length: number) => Uint8Array.from({ length }, (_, index) => index);

/** Runs `run` with `name` gone from `globalThis`, as a realm without it has it, then puts it back. */
function without<T>(name: string, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  expect(descriptor?.configurable).toBe(true);
  Reflect.deleteProperty(globalThis, name);
  try {
    return run();
  } finally {
    Object.defineProperty(globalThis, name, descriptor!);
  }
}

describe('the keyed hash', () => {
  test('is SipHash-2-4: it gives the reference vectors, read as little-endian words', () => {
    expect(sipHash(VECTOR_KEY, message(0))).toBe('726fdb47dd0e0e31');
    expect(sipHash(VECTOR_KEY, message(7))).toBe('ab0200f58b01d137');
    expect(sipHash(VECTOR_KEY, message(8))).toBe('93f5f5799a932462');
    expect(sipHash(VECTOR_KEY, message(15))).toBe('a129ca6149be45e5');
    expect(sipHash(VECTOR_KEY, message(63))).toBe('958a324ceb064572');
  });

  test("encodes text as TextEncoder does, without it: ASCII, two-, three- and four-byte characters, and a lone surrogate", () => {
    const texts = ['', 'rooms/lobby', 'café', '€', '部屋', '😀', 'a\uD800b', '\uDC00', 'x'.repeat(100)];
    const encoded = texts.map((text) => Array.from(new TextEncoder().encode(text)));
    expect(without('TextEncoder', () => texts.map((text) => Array.from(utf8(text))))).toEqual(encoded);
  });

  test('hashes one text the same within a realm and two texts apart, as 16 lowercase hex characters that hold neither', () => {
    const lobby = realmHash('["document","rooms/lobby"]');
    expect(lobby).toMatch(/^[0-9a-f]{16}$/);
    expect(realmHash('["document","rooms/lobby"]')).toBe(lobby);
    expect(realmHash('["document","rooms/hall"]')).not.toBe(lobby);
  });

  test("draws the realm's key at random, and still draws one where the realm has no crypto", () => {
    expect(Array.from(randomKey())).not.toEqual(Array.from(randomKey()));
    const fallback = without('crypto', () => [randomKey(), randomKey()]);
    expect(fallback.every((key) => key.length === 16)).toBe(true);
    expect(Array.from(fallback[0]!)).not.toEqual(Array.from(fallback[1]!));
  });
});

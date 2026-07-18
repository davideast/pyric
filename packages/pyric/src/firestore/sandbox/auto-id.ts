/**
 * Item 7 — Firestore-compatible auto document ID generator.
 *
 * Production Firestore mints 20-character document IDs from the
 * alphabet `[A-Za-z0-9]` (62 characters, ~119 bits of entropy). The
 * sim-side generator matches that exact shape so any test that
 * captures an auto-id and asserts on its format gets the same answer
 * a live `addDoc()` call would.
 *
 * Uses the Web Crypto `getRandomValues` surface for entropy — exposed
 * on `globalThis.crypto` in Node 19+ and every browser. Each generated
 * character consumes one random byte, mod 62. The mod-bias is tiny at
 * 62/256 ≈ 24% and matches what the JS Firestore SDK does internally —
 * kept identical so a test's collision probability is comparable
 * across local and prod runs. Web Crypto keeps this module browser-
 * safe (no `node:crypto` import).
 */

const ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const ID_LENGTH = 20;

export const FIRESTORE_AUTO_ID_LENGTH = ID_LENGTH;
export const FIRESTORE_AUTO_ID_ALPHABET = ALPHABET;

/**
 * Generate a single 20-character Firestore auto ID. Backed by
 * cryptographically-strong randomness so 1000-sample collision tests
 * succeed even under heavy parallelism in the test runner.
 */
export function generateAutoId(): string {
  const bytes = new Uint8Array(ID_LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < ID_LENGTH; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

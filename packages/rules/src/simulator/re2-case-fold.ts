/**
 * Unicode Simple Case Folding (`C` + `S` mappings from Unicode CaseFolding.txt)
 * for RE2's `(?i)` flag.
 *
 * RE2 folds characters by equivalence classes (orbits) under simple case
 * folding: `'k'`, `'K'`, and `'\u212A'` (Kelvin sign) form one 3-member orbit,
 * as do `'s'`, `'S'`, and `'\u017F'` (Latin long s), `'A'`/`'a'` with ring and
 * `'\u212B'` (Angstrom sign), and the multi-member Latin digraph, Greek, and
 * Cyrillic orbits listed below. Two-member asymmetric simple folds (such as
 * `'\u00DF'` / `'\u1E9E'`) are included alongside symmetric single-codepoint
 * `toLowerCase` / `toUpperCase` pairs.
 */

const SPECIAL_CASE_FOLD_ORBITS: ReadonlyArray<readonly number[]> = [
  // Multi-member Latin & symbol orbits
  [0x004b, 0x006b, 0x212a], // K, k, Kelvin sign
  [0x0053, 0x0073, 0x017f], // S, s, Latin small letter long s
  [0x00b5, 0x039c, 0x03bc], // micro sign, Greek capital Mu, Greek small mu
  [0x00c5, 0x00e5, 0x212b], // A-ring, a-ring, Angstrom sign
  [0x01c4, 0x01c5, 0x01c6], // DZ, Dz, dz with caron
  [0x01c7, 0x01c8, 0x01c9], // LJ, Lj, lj
  [0x01ca, 0x01cb, 0x01cc], // NJ, Nj, nj
  [0x01f1, 0x01f2, 0x01f3], // DZ, Dz, dz
  [0x1e60, 0x1e61, 0x1e9b], // S-dot, s-dot, long s with dot

  // Multi-member Greek orbits
  [0x0345, 0x0399, 0x03b9, 0x1fbe], // ypogegrammeni, Iota, iota, prosgegrammeni
  [0x0392, 0x03b2, 0x03d0], // Beta, beta, beta symbol
  [0x0395, 0x03b5, 0x03f5], // Epsilon, epsilon, lunate epsilon symbol
  [0x0398, 0x03b8, 0x03d1, 0x03f4], // Theta, theta, theta symbol, capital theta symbol
  [0x039a, 0x03ba, 0x03f0], // Kappa, kappa, kappa symbol
  [0x03a0, 0x03c0, 0x03d6], // Pi, pi, pi symbol
  [0x03a1, 0x03c1, 0x03f1], // Rho, rho, rho symbol
  [0x03a3, 0x03c2, 0x03c3], // Sigma, final sigma, sigma
  [0x03a6, 0x03c6, 0x03d5], // Phi, phi, phi symbol
  [0x03a9, 0x03c9, 0x2126], // Omega, omega, Ohm sign

  // Multi-member Cyrillic orbits (Cyrillic + Cyrillic Extended-C)
  [0x0412, 0x0432, 0x1c80],
  [0x0414, 0x0434, 0x1c81],
  [0x041e, 0x043e, 0x1c82],
  [0x0421, 0x0441, 0x1c83],
  [0x0422, 0x0442, 0x1c84, 0x1c85],
  [0x042a, 0x044a, 0x1c86],
  [0x0462, 0x0463, 0x1c87],
  [0xa64a, 0xa64b, 0x1c88],

  // Two-member simple folds where JS toUpperCase/toLowerCase expands or uses titlecase
  [0x00df, 0x1e9e], // sharp s, capital sharp s
  [0x0390, 0x1fd3], // Greek iota with dialytika and tonos / oxia
  [0x03b0, 0x1fe3], // Greek upsilon with dialytika and tonos / oxia
  [0x1fb3, 0x1fbc], // Greek alpha with ypogegrammeni / prosgegrammeni
  [0x1fc3, 0x1fcc], // Greek eta with ypogegrammeni / prosgegrammeni
  [0x1ff3, 0x1ffc], // Greek omega with ypogegrammeni / prosgegrammeni
  [0xfb05, 0xfb06], // ligature long s-t, ligature s-t
  ...Array.from({ length: 8 }, (_, i) => [0x1f80 + i, 0x1f88 + i] as const),
  ...Array.from({ length: 8 }, (_, i) => [0x1f90 + i, 0x1f98 + i] as const),
  ...Array.from({ length: 8 }, (_, i) => [0x1fa0 + i, 0x1fa8 + i] as const),
];

const ORBIT_BY_CHAR: Map<string, readonly string[]> = (() => {
  const map = new Map<string, readonly string[]>();
  for (const codePoints of SPECIAL_CASE_FOLD_ORBITS) {
    const chars = Object.freeze(codePoints.map((cp) => String.fromCodePoint(cp)));
    for (const ch of chars) {
      map.set(ch, chars);
    }
  }
  return map;
})();

const PAIR_CACHE = new Map<string, readonly string[]>();

/**
 * Return every character in `ch`'s Unicode simple case-folding equivalence
 * class (`[ch]` when `ch` does not fold to any other code point).
 */
export function re2CaseFoldOrbit(ch: string): readonly string[] {
  const special = ORBIT_BY_CHAR.get(ch);
  if (special !== undefined) return special;

  const cached = PAIR_CACHE.get(ch);
  if (cached !== undefined) return cached;

  const lo = ch.toLowerCase();
  if (lo !== ch && Array.from(lo).length === 1 && lo.toUpperCase() === ch) {
    const pair = Object.freeze([ch, lo]);
    PAIR_CACHE.set(ch, pair);
    PAIR_CACHE.set(lo, pair);
    return pair;
  }

  const up = ch.toUpperCase();
  if (up !== ch && Array.from(up).length === 1 && up.toLowerCase() === ch) {
    const pair = Object.freeze([ch, up]);
    PAIR_CACHE.set(ch, pair);
    PAIR_CACHE.set(up, pair);
    return pair;
  }

  const single = Object.freeze([ch]);
  PAIR_CACHE.set(ch, single);
  return single;
}

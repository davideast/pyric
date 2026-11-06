/**
 * `string.lower()` and `string.upper()` as Firestore rules evaluate them:
 * map the ASCII letters `A`-`Z` and `a`-`z` and leave every other code unit
 * as it is.
 *
 * JavaScript's `toLowerCase()` and `toUpperCase()` apply the full Unicode
 * case mapping, so `'é'.toUpperCase()` is `'É'` and `'ß'.toUpperCase()` is
 * `'SS'`. The 2026-11-04 capture `string-case-mapping` (hunt `c11-case-mapping`)
 * shows production keeping é, Ä, Σ, ж, ß, İ and the fullwidth ａ unchanged.
 */
export function lowerRulesString(subject: string): string {
  return subject.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
}

export function upperRulesString(subject: string): string {
  return subject.replace(/[a-z]+/g, (letters) => letters.toUpperCase());
}

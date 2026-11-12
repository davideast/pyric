/** Suggests the valid key nearest to a misspelled one, for "did you mean" errors. */

/** The key in `keys` closest to `input`, or null when none is reasonably close. */
export function closestKey(input: string, keys: readonly string[]): string | null {
  const want = input.toLowerCase();
  let best: { key: string; d: number } | null = null;
  for (const key of keys) {
    const d = levenshtein(want, key.toLowerCase());
    if (best === null || d < best.d) best = { key, d };
  }
  // Only return a suggestion if it's reasonably close.
  if (best && best.d <= Math.max(2, Math.floor(want.length / 3))) return best.key;
  return null;
}

function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const v0: number[] = new Array(b.length + 1).fill(0).map((_, i) => i);
  const v1: number[] = new Array(b.length + 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1]! + 1, v0[j]! + cost);
    }
    for (let j = 0; j <= b.length; j++) v0[j] = v1[j]!;
  }
  return v1[b.length]!;
}

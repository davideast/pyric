/**
 * The two things a rejection message needs beyond the record itself: the name
 * the caller probably meant, and how a value is shown back to them.
 *
 * A method name and an argument name are both drawn from a closed set, so a
 * miss is almost always a near miss, and naming the near miss is the difference
 * between a rejection a model can act on and one it can only retry.
 */
/** Levenshtein distance, for suggesting the name that was meant. */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      row.push(Math.min(previous[j] + 1, row[j - 1] + 1, substitution));
    }
    previous = row;
  }
  return previous[b.length];
}

/**
 * The closest candidate, or null when nothing is close enough to name. The
 * budget scales with the longer of the two names rather than the input, so that
 * `setDocument` still finds `setDoc`: a name lengthened by a whole word is the
 * common miss, and it is further away by edit distance than a typo is.
 */
export function closest(input: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = editDistance(input.toLowerCase(), candidate.toLowerCase());
    const budget = Math.max(3, Math.ceil(Math.max(input.length, candidate.length) / 2));
    if (distance < bestDistance && distance <= budget) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/** Quote a value the way a message shows it back to the caller. */
export function quoted(value: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  if (value === undefined) return 'missing';
  return `'${JSON.stringify(value)}'`;
}

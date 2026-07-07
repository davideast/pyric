/**
 * Tiny line-based diff. Returns added + removed counts via a standard
 * LCS table — O(n×m) on line counts, fine for source files under a
 * few thousand lines.
 *
 * Trade-off: classic LCS doesn't distinguish "modified" from "added +
 * removed of the same offset" the way Myers' or a histogram diff
 * would. For the UI purpose ("show the scale of the change") it's
 * close enough — a modified line counts as 1 added + 1 removed,
 * which is the honest read in most cases.
 */
export interface DiffStats {
  added: number;
  removed: number;
}

export function diffLines(before: string, after: string): DiffStats {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  const n = a.length;
  const m = b.length;

  // Trivial cases skip the DP allocation.
  if (n === 0) return { added: m, removed: 0 };
  if (m === 0) return { added: 0, removed: n };

  // LCS table. `prev` + `curr` rolling rows to keep memory O(min(n,m))
  // since source files can be a few thousand lines and full tables
  // would allocate megabytes of `number[]`.
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1]! + 1;
      } else {
        curr[j] = Math.max(prev[j]!, curr[j - 1]!);
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  const lcs = prev[m]!;
  return { added: m - lcs, removed: n - lcs };
}

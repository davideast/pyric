/**
 * Line-level unified diff for the teaching UI. `~/lib/utils/diff`
 * deliberately returns only counts (the activity row's `Δ +N / −M`);
 * this module produces the actual row stream the drill-in renders so
 * the user can SEE what a `write_file` changed, not just how much.
 *
 * Pure functions — no React, no stores — so tests drive them
 * headlessly and the DiffView component stays a thin renderer.
 *
 * Algorithm: common prefix/suffix trim, then a classic LCS table with
 * backtracking over the remaining middle. O(n×m) on the trimmed line
 * counts; a `tooLarge` guard (default ~2M cells) bails before
 * allocating a table that would jank the UI — callers fall back to
 * the full-source view.
 */

export type DiffRowKind = 'context' | 'add' | 'del';

export interface DiffRow {
  kind: DiffRowKind;
  text: string;
  /** 1-based line number in the BEFORE text (absent on adds). */
  oldLine?: number;
  /** 1-based line number in the AFTER text (absent on dels). */
  newLine?: number;
}

/** A rendered segment: either visible rows or a collapsed run of
 *  unchanged lines ("⋯ N unchanged lines"). */
export type DiffPart =
  | { kind: 'rows'; rows: DiffRow[] }
  | { kind: 'skip'; count: number };

export interface UnifiedDiff {
  parts: DiffPart[];
  added: number;
  removed: number;
  /** True when before === after (nothing to show). */
  unchanged: boolean;
  /** True when the inputs were too large to diff responsively —
   *  `parts` is empty; callers should render the full source instead. */
  tooLarge: boolean;
}

export interface UnifiedDiffOptions {
  /** Unchanged lines to keep around each change (default 3). */
  context?: number;
  /** LCS table cell budget — n×m past this returns `tooLarge`. */
  maxCells?: number;
}

const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_CELLS = 2_000_000;

function splitLines(s: string): string[] {
  return s === '' ? [] : s.split('\n');
}

/** Raw del/add/context row stream via LCS backtracking. */
function diffRows(a: string[], b: string[], maxCells: number): DiffRow[] | null {
  // Trim the common prefix/suffix first — typical agent edits touch a
  // small region of an otherwise-identical file, and trimming keeps
  // the LCS table tiny.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const n = endA - start;
  const m = endB - start;
  if (n * m > maxCells) return null;

  // LCS table over the middle. Int32Array keeps the worst case
  // (~2M cells) at ~8MB instead of a number[] forest.
  const width = m + 1;
  const table = new Int32Array((n + 1) * width);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      table[i * width + j] =
        a[start + i - 1] === b[start + j - 1]
          ? table[(i - 1) * width + (j - 1)]! + 1
          : Math.max(table[(i - 1) * width + j]!, table[i * width + (j - 1)]!);
    }
  }

  // Backtrack the middle into rows (built in reverse, then flipped).
  const middle: DiffRow[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[start + i - 1] === b[start + j - 1]) {
      middle.push({
        kind: 'context',
        text: a[start + i - 1]!,
        oldLine: start + i,
        newLine: start + j,
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || table[i * width + (j - 1)]! >= table[(i - 1) * width + j]!)) {
      middle.push({ kind: 'add', text: b[start + j - 1]!, newLine: start + j });
      j--;
    } else {
      middle.push({ kind: 'del', text: a[start + i - 1]!, oldLine: start + i });
      i--;
    }
  }
  middle.reverse();

  const rows: DiffRow[] = [];
  for (let k = 0; k < start; k++) {
    rows.push({ kind: 'context', text: a[k]!, oldLine: k + 1, newLine: k + 1 });
  }
  rows.push(...middle);
  const tailLen = a.length - endA;
  for (let k = 0; k < tailLen; k++) {
    rows.push({
      kind: 'context',
      text: a[endA + k]!,
      oldLine: endA + k + 1,
      newLine: endB + k + 1,
    });
  }
  return rows;
}

/**
 * Build the renderable diff. Long runs of unchanged lines collapse
 * into `skip` parts, keeping `context` lines visible on each side of
 * every change — the standard unified-diff reading experience.
 */
export function buildUnifiedDiff(
  before: string,
  after: string,
  options: UnifiedDiffOptions = {},
): UnifiedDiff {
  const context = options.context ?? DEFAULT_CONTEXT;
  const maxCells = options.maxCells ?? DEFAULT_MAX_CELLS;

  if (before === after) {
    return { parts: [], added: 0, removed: 0, unchanged: true, tooLarge: false };
  }

  const rows = diffRows(splitLines(before), splitLines(after), maxCells);
  if (rows === null) {
    return { parts: [], added: 0, removed: 0, unchanged: false, tooLarge: true };
  }

  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.kind === 'add') added++;
    else if (r.kind === 'del') removed++;
  }

  // Mark which rows stay visible: changes + `context` neighbors.
  const visible = new Array<boolean>(rows.length).fill(false);
  for (let k = 0; k < rows.length; k++) {
    if (rows[k]!.kind === 'context') continue;
    const lo = Math.max(0, k - context);
    const hi = Math.min(rows.length - 1, k + context);
    for (let v = lo; v <= hi; v++) visible[v] = true;
  }

  // Group into parts. Skip runs of 1-2 hidden lines aren't worth a
  // separator row — fold them into the visible stream.
  const MIN_SKIP = 3;
  const parts: DiffPart[] = [];
  let k = 0;
  while (k < rows.length) {
    if (visible[k]) {
      const chunk: DiffRow[] = [];
      while (k < rows.length && visible[k]) chunk.push(rows[k++]!);
      parts.push({ kind: 'rows', rows: chunk });
    } else {
      let count = 0;
      const from = k;
      while (k < rows.length && !visible[k]) {
        count++;
        k++;
      }
      if (count < MIN_SKIP) {
        // Too small to be worth a separator — emit as visible rows,
        // merging into the previous part when it exists.
        const small = rows.slice(from, k);
        const prev = parts[parts.length - 1];
        if (prev && prev.kind === 'rows') prev.rows.push(...small);
        else parts.push({ kind: 'rows', rows: small });
      } else {
        parts.push({ kind: 'skip', count });
      }
    }
  }
  // Merge a rows-part that directly follows another rows-part (can
  // happen when a small skip got folded in above).
  const merged: DiffPart[] = [];
  for (const p of parts) {
    const prev = merged[merged.length - 1];
    if (p.kind === 'rows' && prev && prev.kind === 'rows') prev.rows.push(...p.rows);
    else merged.push(p);
  }

  return { parts: merged, added, removed, unchanged: false, tooLarge: false };
}

/** Plain-text serialization (for the copy button) — `-`/`+`/space
 *  prefixes plus `⋯` separators, the shape every dev tool understands. */
export function serializeUnifiedDiff(diff: UnifiedDiff): string {
  const lines: string[] = [];
  for (const part of diff.parts) {
    if (part.kind === 'skip') {
      lines.push(`⋯ ${part.count} unchanged lines`);
      continue;
    }
    for (const row of part.rows) {
      const prefix = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ';
      lines.push(`${prefix} ${row.text}`);
    }
  }
  return lines.join('\n');
}

/**
 * Editor-language label for a workspace path — feeds CodeBlock's
 * header chip. Mirrors the vocabulary the retired write-tool views
 * used ('firestore rules', 'tsx', 'javascript').
 */
export function languageForPath(path: string): string {
  if (path.endsWith('.rules')) return 'firestore rules';
  const dot = path.lastIndexOf('.');
  const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
  switch (ext) {
    case 'tsx':
      return 'tsx';
    case 'ts':
      return 'ts';
    case 'jsx':
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'json':
      return 'json';
    case 'css':
      return 'css';
    case 'html':
      return 'html';
    case 'md':
      return 'markdown';
    default:
      return ext || 'text';
  }
}

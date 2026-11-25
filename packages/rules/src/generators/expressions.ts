/**
 * Firestore rules expression generators for grid-based games.
 *
 * Each function returns a string that is a valid Firestore rules boolean expression.
 * The expressions use parameter names (b, ob, nc, nr, mark) that must match
 * the function signatures in the generated rules.
 */

import type { GridConfig } from './grid.js';
import { indexToColRow } from './grid.js';

/**
 * Win detection: OR of all winning lines for a specific mark.
 * Uses `b` as the board parameter name.
 *
 * Example output: (b.c0r0 == 'R' && b.c1r0 == 'R' && b.c2r0 == 'R' && b.c3r0 == 'R') || ...
 */
export function winCheckExpr(mark: string, lines: number[][], grid: GridConfig): string {
  return lines.map(line => {
    const cells = line.map(i => {
      const [c, r] = indexToColRow(i, grid.cols);
      return `b.${grid.cellName(c, r)} == '${mark}'`;
    });
    return `(${cells.join(' && ')})`;
  }).join('\n          || ');
}

/**
 * Split win lines by direction for per-direction functions.
 * Returns { horizontal, vertical, diagUp, diagDown }.
 */
export function splitWinLinesByDirection(
  lines: number[][],
  cols: number,
): { horizontal: number[][]; vertical: number[][]; diagUp: number[][]; diagDown: number[][] } {
  const horizontal: number[][] = [];
  const vertical: number[][] = [];
  const diagUp: number[][] = [];
  const diagDown: number[][] = [];

  for (const line of lines) {
    const first = line[0];
    const second = line[1];
    if (first === undefined || second === undefined) continue;
    const [c0, r0] = indexToColRow(first, cols);
    const [c1, r1] = indexToColRow(second, cols);
    const dc = c1 - c0;
    const dr = r1 - r0;
    if (dc === 1 && dr === 0) horizontal.push(line);
    else if (dc === 0 && dr === 1) vertical.push(line);
    else if (dc === 1 && dr === 1) diagUp.push(line);
    else diagDown.push(line);
  }

  return { horizontal, vertical, diagUp, diagDown };
}

const WIN_DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

function escapeSingleQuoted(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function isCellInBounds(col: number, row: number, grid: GridConfig): boolean {
  return col >= 0 && col < grid.cols && row >= 0 && row < grid.rows;
}

function maxStepsInDirection(
  col: number,
  row: number,
  dc: number,
  dr: number,
  maxSteps: number,
  grid: GridConfig,
): number {
  let steps = 0;
  while (steps < maxSteps && isCellInBounds(col + (steps + 1) * dc, row + (steps + 1) * dr, grid)) {
    steps++;
  }
  return steps;
}

/**
 * Factored boolean expression checking whether placing `markVar` at `(col, row)`
 * completes any contiguous `winLineCount`-in-a-row segment along `(dc, dr)`.
 * Assumes `boardVar.<cell(col, row)> == markVar` is already verified by the caller.
 * Returns `null` when no `winLineCount` segment along `(dc, dr)` fits through `(col, row)`.
 */
export function directionRunThroughCellExpr(
  boardVar: string,
  markVar: string,
  col: number,
  row: number,
  dc: number,
  dr: number,
  winLineCount: number,
  grid: GridConfig,
): string | null {
  if (winLineCount < 2) return null;
  const maxSpan = winLineCount - 1;
  const maxBack = maxStepsInDirection(col, row, -dc, -dr, maxSpan, grid);
  const maxFwd = maxStepsInDirection(col, row, dc, dr, maxSpan, grid);
  const minLeft = Math.max(0, maxSpan - maxFwd);
  const maxLeft = maxBack;
  if (minLeft > maxLeft) return null;

  const cellEq = (c: number, r: number): string => `${boardVar}.${grid.cellName(c, r)} == ${markVar}`;
  const backCell = (step: number): string => cellEq(col - step * dc, row - step * dr);
  const fwdChain = (count: number): string => {
    const parts: string[] = [];
    for (let step = 1; step <= count; step++) {
      parts.push(cellEq(col + step * dc, row + step * dr));
    }
    if (parts.length === 1) return parts[0] ?? 'true';
    return `(${parts.join(' && ')})`;
  };

  const fromStep = (left: number): string => {
    const rightNeeded = maxSpan - left;
    if (left === maxLeft) {
      if (rightNeeded === 0) return 'true';
      return fwdChain(rightNeeded);
    }
    const rightExpr = fwdChain(rightNeeded);
    const nextLeft = left + 1;
    const nextRightNeeded = maxSpan - nextLeft;
    let leftBranch: string;
    if (nextLeft === maxLeft && nextRightNeeded === 0) {
      leftBranch = backCell(nextLeft);
    } else {
      leftBranch = `(${backCell(nextLeft)} && ${fromStep(nextLeft)})`;
    }
    return `(${rightExpr} || ${leftBranch})`;
  };

  const prefixParts: string[] = [];
  for (let step = 1; step <= minLeft; step++) {
    prefixParts.push(backCell(step));
  }

  if (minLeft === maxLeft && maxSpan - minLeft === 0) {
    if (prefixParts.length === 1) return prefixParts[0] ?? 'true';
    return `(${prefixParts.join(' && ')})`;
  }

  const tail = fromStep(minLeft);
  if (prefixParts.length === 0) return tail;
  return `(${[...prefixParts, tail].join(' && ')})`;
}

function cellDirectionsExpr(
  boardVar: string,
  markVar: string,
  col: number,
  row: number,
  winLineCount: number,
  grid: GridConfig,
): string | null {
  const dirs: string[] = [];
  for (const [dc, dr] of WIN_DIRECTIONS) {
    const expr = directionRunThroughCellExpr(boardVar, markVar, col, row, dc, dr, winLineCount, grid);
    if (expr !== null) dirs.push(expr);
  }
  if (dirs.length === 0) return null;
  if (dirs.length === 1) return dirs[0] ?? null;
  return `(${dirs.join(' || ')})`;
}

/**
 * Classic nested-board win check rooted at `(nc, nr)` via binary search over
 * column and row coordinates (`O(log(cols) + log(rows))` comparisons).
 * Uses `b`, `mark`, `nc`, `nr` parameter names.
 */
export function classicWinAtCellExpr(grid: GridConfig, winLineCount: number): string {
  if (grid.cols <= 0 || grid.rows <= 0 || winLineCount < 2) return 'false';

  const leafExpr = (col: number, row: number): string => {
    const dirExpr = cellDirectionsExpr('b', 'mark', col, row, winLineCount, grid);
    if (dirExpr === null) return 'false';
    return `(nc == ${col} && nr == ${row} && b.${grid.cellName(col, row)} == mark && ${dirExpr})`;
  };

  const bisectRow = (col: number, loRow: number, hiRow: number): string => {
    if (loRow === hiRow) return leafExpr(col, loRow);
    const midRow = Math.floor((loRow + hiRow) / 2);
    const left = bisectRow(col, loRow, midRow);
    const right = bisectRow(col, midRow + 1, hiRow);
    if (left === 'false' && right === 'false') return 'false';
    return `(nr <= ${midRow} ? ${left} : ${right})`;
  };

  const bisectCol = (loCol: number, hiCol: number): string => {
    if (loCol === hiCol) return bisectRow(loCol, 0, grid.rows - 1);
    const midCol = Math.floor((loCol + hiCol) / 2);
    const left = bisectCol(loCol, midCol);
    const right = bisectCol(midCol + 1, hiCol);
    if (left === 'false' && right === 'false') return 'false';
    return `(nc <= ${midCol} ? ${left} : ${right})`;
  };

  return bisectCol(0, grid.cols - 1);
}

/**
 * Flat-board win check rooted at `lm` (`lastMove` field name) via binary search
 * over sorted cell names (`O(log(cols * rows))` comparisons).
 * Uses `d`, `mark`, `lm` parameter names.
 */
export function flatWinAtMoveExpr(grid: GridConfig, winLineCount: number): string {
  if (grid.cols <= 0 || grid.rows <= 0 || winLineCount < 2) return 'false';

  const entries: Array<{ key: string; expr: string }> = [];
  const seenKeys = new Set<string>();
  for (let col = 0; col < grid.cols; col++) {
    for (let row = 0; row < grid.rows; row++) {
      const key = grid.cellName(col, row);
      if (seenKeys.has(key)) {
        throw new Error(`assembleGameRules: duplicate cell name ${JSON.stringify(key)} at (${col}, ${row})`);
      }
      seenKeys.add(key);
      const dirExpr = cellDirectionsExpr('d', 'mark', col, row, winLineCount, grid);
      if (dirExpr === null) continue;
      const escapedKey = escapeSingleQuoted(key);
      entries.push({
        key,
        expr: `(lm == '${escapedKey}' && d.${key} == mark && ${dirExpr})`,
      });
    }
  }

  if (entries.length === 0) return 'false';

  entries.sort((a, b) => {
    if (a.key < b.key) return -1;
    if (a.key > b.key) return 1;
    return 0;
  });

  const bisect = (lo: number, hi: number): string => {
    if (lo === hi) return entries[lo]?.expr ?? 'false';
    const mid = Math.floor((lo + hi) / 2);
    const pivotEntry = entries[mid + 1];
    if (pivotEntry === undefined) return entries[lo]?.expr ?? 'false';
    const pivot = escapeSingleQuoted(pivotEntry.key);
    return `(lm < '${pivot}' ? ${bisect(lo, mid)} : ${bisect(mid + 1, hi)})`;
  };

  return bisect(0, entries.length - 1);
}

/**
 * Gravity: per-column lowest-empty-row check.
 * Uses `nc` (new col), `nr` (new row), `ob` (old board) as parameter names.
 *
 * For each column: if nc == col, verify nr is the lowest empty row.
 */
export function gravityExpr(grid: GridConfig): string {
  const colChecks: string[] = [];
  for (let c = 0; c < grid.cols; c++) {
    const rowChecks: string[] = [];
    for (let r = 0; r < grid.rows; r++) {
      const parts: string[] = [`nr == ${r}`];
      for (let below = 0; below < r; below++) {
        parts.push(`ob.${grid.cellName(c, below)} != ''`);
      }
      parts.push(`ob.${grid.cellName(c, r)} == ''`);
      rowChecks.push(`(${parts.join(' && ')})`);
    }
    colChecks.push(`(nc == ${c} && (${rowChecks.join(' || ')}))`);
  }
  return colChecks.join('\n          || ');
}

/**
 * Board integrity: verify all non-move cells are unchanged.
 * Uses `nc`, `nr`, `b` (new board), `ob` (old board) as parameter names.
 *
 * For each cell: either it's the move cell OR old == new.
 */
export function boardIntegrityExpr(grid: GridConfig): string {
  const checks: string[] = [];
  for (let c = 0; c < grid.cols; c++) {
    const colChecks: string[] = [];
    for (let r = 0; r < grid.rows; r++) {
      const cn = grid.cellName(c, r);
      colChecks.push(`((nc == ${c} && nr == ${r}) || b.${cn} == ob.${cn})`);
    }
    checks.push(`(${colChecks.join(' && ')})`);
  }
  return checks.join('\n          && ');
}

/**
 * Cell-was-empty check: verify the cell at (nc, nr) was empty before the move.
 * Uses `nc`, `nr`, `ob` (old board) as parameter names.
 * For gravity games this is redundant (gravity already checks ob.cell == ''),
 * but for non-gravity games it prevents overwriting occupied cells.
 */
export function cellEmptyExpr(grid: GridConfig): string {
  const checks: string[] = [];
  for (let c = 0; c < grid.cols; c++) {
    for (let r = 0; r < grid.rows; r++) {
      checks.push(`(nc == ${c} && nr == ${r} && ob.${grid.cellName(c, r)} == '')`);
    }
  }
  return checks.join('\n          || ');
}

/**
 * Placement: verify the cell at (nc, nr) has the correct mark.
 * Uses `nc`, `nr`, `mark`, `b` (new board) as parameter names.
 */
export function placementExpr(grid: GridConfig): string {
  const checks: string[] = [];
  for (let c = 0; c < grid.cols; c++) {
    for (let r = 0; r < grid.rows; r++) {
      checks.push(`(nc == ${c} && nr == ${r} && b.${grid.cellName(c, r)} == mark)`);
    }
  }
  return checks.join('\n          || ');
}

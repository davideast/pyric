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
    const [c0, r0] = indexToColRow(line[0], cols);
    const [c1, r1] = indexToColRow(line[1], cols);
    const dc = c1 - c0;
    const dr = r1 - r0;
    if (dc === 1 && dr === 0) horizontal.push(line);
    else if (dc === 0 && dr === 1) vertical.push(line);
    else if (dc === 1 && dr === 1) diagUp.push(line);
    else diagDown.push(line);
  }

  return { horizontal, vertical, diagUp, diagDown };
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

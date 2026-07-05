/**
 * Grid geometry utilities for grid-based game rule generation.
 */

export interface GridConfig {
  cols: number;
  rows: number;
  cellName: (col: number, row: number) => string;
}

export function defaultCellName(col: number, row: number): string {
  return `c${col}r${row}`;
}

export function indexToColRow(index: number, cols: number): [number, number] {
  return [index % cols, Math.floor(index / cols)];
}

/**
 * Generate all winning lines for N-in-a-row on a rectangular grid.
 * Returns arrays of flat indices (row * cols + col).
 *
 * Directions: horizontal (→), vertical (↑), diagonal (↗), diagonal (↘)
 */
export function generateWinLines(cols: number, rows: number, count: number): number[][] {
  const lines: number[][] = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Horizontal (→)
      if (c + count <= cols) {
        lines.push(Array.from({ length: count }, (_, i) => r * cols + c + i));
      }
      // Vertical (↑)
      if (r + count <= rows) {
        lines.push(Array.from({ length: count }, (_, i) => (r + i) * cols + c));
      }
      // Diagonal (↗)
      if (c + count <= cols && r + count <= rows) {
        lines.push(Array.from({ length: count }, (_, i) => (r + i) * cols + c + i));
      }
      // Diagonal (↘)
      if (c + count <= cols && r - count + 1 >= 0) {
        lines.push(Array.from({ length: count }, (_, i) => (r - i) * cols + c + i));
      }
    }
  }

  return lines;
}

/**
 * Generate an empty board object with all cells set to empty string.
 */
export function emptyBoard(grid: GridConfig): Record<string, string> {
  const board: Record<string, string> = {};
  for (let c = 0; c < grid.cols; c++) {
    for (let r = 0; r < grid.rows; r++) {
      board[grid.cellName(c, r)] = '';
    }
  }
  return board;
}

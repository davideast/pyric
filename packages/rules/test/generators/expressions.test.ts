import { describe, test, expect } from 'bun:test';
import {
  winCheckExpr,
  directionRunThroughCellExpr,
  classicWinAtCellExpr,
  flatWinAtMoveExpr,
  gravityExpr,
  boardIntegrityExpr,
  placementExpr,
} from '../../src/generators/expressions.js';
import { defaultCellName, emptyBoard, generateWinLines, indexToColRow } from '../../src/generators/grid.js';
import type { GridConfig } from '../../src/generators/grid.js';
import { firestoreRules } from '../../src/index.js';

const c4Grid: GridConfig = { cols: 7, rows: 6, cellName: defaultCellName };
const tttGrid: GridConfig = { cols: 3, rows: 3, cellName: defaultCellName };

describe('winCheckExpr', () => {
  test('contains all win lines', () => {
    const lines = generateWinLines(7, 6, 4);
    const expr = winCheckExpr('R', lines, c4Grid);
    // 69 lines -> 69 conjunctions joined by ||
    const branches = expr.split('||').length;
    expect(branches).toBe(69);
  });

  test('uses correct cell names from grid config', () => {
    const lines = generateWinLines(3, 3, 3);
    const expr = winCheckExpr('X', lines, tttGrid);
    expect(expr).toContain('b.c0r0');
    expect(expr).toContain('b.c2r2');
  });

  test('uses correct mark string', () => {
    const lines = generateWinLines(3, 3, 3);
    const expr = winCheckExpr('O', lines, tttGrid);
    expect(expr).toContain("== 'O'");
    expect(expr).not.toContain("== 'X'");
  });

  test('each line is a conjunction of count comparisons', () => {
    const lines = generateWinLines(3, 3, 3);
    const expr = winCheckExpr('X', lines, tttGrid);
    // Each branch should have exactly 2 '&&' (for 3 cells: a && b && c)
    const branches = expr.split('||').map(b => b.trim());
    for (const branch of branches) {
      const ands = branch.split('&&').length;
      expect(ands).toBe(3);
    }
  });
});

describe('last-move win expressions', () => {
  test('directionRunThroughCellExpr returns null when no segment fits', () => {
    const small: GridConfig = { cols: 2, rows: 3, cellName: defaultCellName };
    // Horizontal 3-in-a-row cannot fit on a 2-column grid
    expect(directionRunThroughCellExpr('b', 'mark', 0, 0, 1, 0, 3, small)).toBeNull();
    // Vertical 3-in-a-row fits on a 3-row grid
    expect(directionRunThroughCellExpr('b', 'mark', 0, 1, 0, 1, 3, small)).toBe(
      '(b.c0r0 == mark && b.c0r2 == mark)',
    );
  });

  test('classicWinAtCellExpr and flatWinAtMoveExpr match exact line-through-move semantics', () => {
    const grid: GridConfig = { cols: 4, rows: 4, cellName: defaultCellName };
    const winLineCount = 3;
    const allLines = generateWinLines(grid.cols, grid.rows, winLineCount);

    const classicRules = firestoreRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function wonAtCell(b, mark, nc, nr) {
      return ${classicWinAtCellExpr(grid, winLineCount)};
    }
    match /games/{id} {
      allow update: if wonAtCell(request.resource.data.board, request.resource.data.mark, request.resource.data.lastCol, request.resource.data.lastRow);
    }
  }
}`);

    const flatRules = firestoreRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function wonAtMove(d, mark, lm) {
      return ${flatWinAtMoveExpr(grid, winLineCount)};
    }
    match /games/{id} {
      allow update: if wonAtMove(request.resource.data, request.resource.data.mark, request.resource.data.lastMove);
    }
  }
}`);

    // Every generated line, completed at each of its cells, must ALLOW;
    // the same board with a different lastMove cell not on that line must DENY.
    for (const line of allLines) {
      const board = emptyBoard(grid);
      for (const idx of line) {
        const [c, r] = indexToColRow(idx, grid.cols);
        board[grid.cellName(c, r)] = 'host';
      }
      for (let col = 0; col < grid.cols; col++) {
        for (let row = 0; row < grid.rows; row++) {
          const cellIdx = row * grid.cols + col;
          const expectedWin = line.includes(cellIdx);
          const expectation = expectedWin ? 'ALLOW' : 'DENY';
          const classicRes = classicRules.simulate([
            {
              description: `classic (${col},${row})`,
              expectation,
              method: 'update',
              path: 'games/g1',
              resource: { ok: true },
              data: { board, mark: 'host', lastCol: col, lastRow: row },
            },
          ]);
          expect(classicRes.passed).toBe(1);

          const flatRes = flatRules.simulate([
            {
              description: `flat (${col},${row})`,
              expectation,
              method: 'update',
              path: 'games/g1',
              resource: { ok: true },
              data: { ...board, mark: 'host', lastMove: grid.cellName(col, row) },
            },
          ]);
          expect(flatRes.passed).toBe(1);
        }
      }
    }
  });
});

describe('gravityExpr', () => {
  test('generates one block per column', () => {
    const expr = gravityExpr(c4Grid);
    for (let c = 0; c < 7; c++) {
      expect(expr).toContain(`nc == ${c}`);
    }
  });

  test('row 0 check has no below-occupied conditions', () => {
    const expr = gravityExpr(c4Grid);
    // For column 0, row 0: should be (nr == 0 && ob.c0r0 == '')
    expect(expr).toContain("nr == 0 && ob.c0r0 == ''");
  });

  test('row 3 check includes occupied conditions for rows 0-2', () => {
    const expr = gravityExpr(c4Grid);
    expect(expr).toContain("nr == 3 && ob.c0r0 != '' && ob.c0r1 != '' && ob.c0r2 != '' && ob.c0r3 == ''");
  });

  test('custom cell namer is respected', () => {
    const custom: GridConfig = { cols: 2, rows: 2, cellName: (c, r) => `cell_${c}_${r}` };
    const expr = gravityExpr(custom);
    expect(expr).toContain('ob.cell_0_0');
    expect(expr).toContain('ob.cell_1_1');
  });
});

describe('boardIntegrityExpr', () => {
  test('generates one check per cell', () => {
    const expr = boardIntegrityExpr(tttGrid);
    // 9 cells -> 9 checks with nc/nr guards
    for (let c = 0; c < 3; c++) {
      for (let r = 0; r < 3; r++) {
        expect(expr).toContain(`nc == ${c} && nr == ${r}`);
      }
    }
  });

  test('move cell is excluded via guard', () => {
    const expr = boardIntegrityExpr(tttGrid);
    // Each check: ((nc == c && nr == r) || b.cell == ob.cell)
    expect(expr).toContain('(nc == 0 && nr == 0) || b.c0r0 == ob.c0r0');
  });

  test('all non-move cells compare b to ob', () => {
    const expr = boardIntegrityExpr(tttGrid);
    expect(expr).toContain('b.c1r1 == ob.c1r1');
    expect(expr).toContain('b.c2r0 == ob.c2r0');
  });
});

describe('placementExpr', () => {
  test('generates one branch per cell with mark comparison', () => {
    const expr = placementExpr(tttGrid);
    // 9 cells -> 9 branches
    const branches = expr.split('||').length;
    expect(branches).toBe(9);
    expect(expr).toContain('nc == 0 && nr == 0 && b.c0r0 == mark');
    expect(expr).toContain('nc == 2 && nr == 2 && b.c2r2 == mark');
  });
});

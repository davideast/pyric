import { describe, test, expect } from 'bun:test';
import {
  defaultCellName,
  indexToColRow,
  generateWinLines,
  emptyBoard,
} from '../../../src/rules/generators/grid.js';

describe('defaultCellName', () => {
  test('(0, 0) → c0r0', () => {
    expect(defaultCellName(0, 0)).toBe('c0r0');
  });

  test('(6, 5) → c6r5', () => {
    expect(defaultCellName(6, 5)).toBe('c6r5');
  });
});

describe('indexToColRow', () => {
  test('index 0 in 7-col grid → [0, 0]', () => {
    expect(indexToColRow(0, 7)).toEqual([0, 0]);
  });

  test('index 10 in 7-col grid → [3, 1]', () => {
    expect(indexToColRow(10, 7)).toEqual([3, 1]);
  });
});

describe('generateWinLines', () => {
  test('Connect Four (7×6, 4-in-a-row) → 69 lines', () => {
    expect(generateWinLines(7, 6, 4)).toHaveLength(69);
  });

  test('Tic-Tac-Toe (3×3, 3-in-a-row) → 8 lines', () => {
    expect(generateWinLines(3, 3, 3)).toHaveLength(8);
  });

  test('Gomoku (15×15, 5-in-a-row) → 572 lines', () => {
    expect(generateWinLines(15, 15, 5)).toHaveLength(572);
  });

  test('every line has exactly count cells', () => {
    const lines = generateWinLines(7, 6, 4);
    for (const line of lines) {
      expect(line).toHaveLength(4);
    }
  });

  test('no duplicate lines', () => {
    const lines = generateWinLines(7, 6, 4);
    const serialized = lines.map(l => l.join(','));
    const unique = new Set(serialized);
    expect(unique.size).toBe(lines.length);
  });
});

describe('emptyBoard', () => {
  test('3×3 board has 9 cells', () => {
    const board = emptyBoard({ cols: 3, rows: 3, cellName: defaultCellName });
    expect(Object.keys(board)).toHaveLength(9);
  });

  test('all cells are empty strings', () => {
    const board = emptyBoard({ cols: 3, rows: 3, cellName: defaultCellName });
    for (const val of Object.values(board)) {
      expect(val).toBe('');
    }
  });
});

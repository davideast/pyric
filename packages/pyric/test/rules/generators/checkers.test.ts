/**
 * Checkers rules generator — permanent tests from bug bash.
 *
 * Captures findings about movement game rules in Firestore:
 * - Board geometry (dark squares, adjacency, jumps)
 * - Piece counter pattern (replaces 64-expression cell enumeration)
 * - Gate pattern (cheap short-circuit for cross-rule budget)
 * - Generated rules structure and syntax
 */
import { describe, test, expect } from 'bun:test';
import {
  darkSquares,
  initialBoard,
  getSimpleMoves,
  getJumpMoves,
  buildCheckersRules,
} from '../../fixtures/firestore-game-rules/generator-hardcoded.js';

describe('darkSquares', () => {
  test('8×8 board has 32 dark squares', () => {
    expect(darkSquares()).toHaveLength(32);
  });

  test('all squares satisfy (col + row) % 2 === 1', () => {
    for (const sq of darkSquares()) {
      const col = parseInt(sq[1]);
      const row = parseInt(sq.slice(sq.indexOf('r') + 1));
      expect((col + row) % 2).toBe(1);
    }
  });

  test('no duplicate squares', () => {
    const unique = new Set(darkSquares());
    expect(unique.size).toBe(32);
  });
});

describe('initialBoard', () => {
  const board = initialBoard();

  test('has 32 cells', () => {
    expect(Object.keys(board)).toHaveLength(32);
  });

  test('12 guest pieces in rows 0-2', () => {
    const guestPieces = Object.entries(board).filter(([_, v]) => v === 'g');
    expect(guestPieces).toHaveLength(12);
    for (const [sq] of guestPieces) {
      const row = parseInt(sq.slice(sq.indexOf('r') + 1));
      expect(row).toBeLessThanOrEqual(2);
    }
  });

  test('12 host pieces in rows 5-7', () => {
    const hostPieces = Object.entries(board).filter(([_, v]) => v === 'h');
    expect(hostPieces).toHaveLength(12);
    for (const [sq] of hostPieces) {
      const row = parseInt(sq.slice(sq.indexOf('r') + 1));
      expect(row).toBeGreaterThanOrEqual(5);
    }
  });

  test('8 empty cells in rows 3-4', () => {
    const empty = Object.entries(board).filter(([_, v]) => v === '');
    expect(empty).toHaveLength(8);
  });
});

describe('getSimpleMoves', () => {
  test('49 up-moves (7 per source row, 7 rows)', () => {
    expect(getSimpleMoves('up')).toHaveLength(49);
  });

  test('49 down-moves', () => {
    expect(getSimpleMoves('down')).toHaveLength(49);
  });

  test('all moves land on dark squares', () => {
    const dark = new Set(darkSquares());
    for (const m of getSimpleMoves('up')) {
      expect(dark.has(m.from)).toBe(true);
      expect(dark.has(m.to)).toBe(true);
    }
  });

  test('up-moves decrease row by 1', () => {
    for (const m of getSimpleMoves('up')) {
      const fromRow = parseInt(m.from.slice(m.from.indexOf('r') + 1));
      const toRow = parseInt(m.to.slice(m.to.indexOf('r') + 1));
      expect(toRow).toBe(fromRow - 1);
    }
  });

  test('down-moves increase row by 1', () => {
    for (const m of getSimpleMoves('down')) {
      const fromRow = parseInt(m.from.slice(m.from.indexOf('r') + 1));
      const toRow = parseInt(m.to.slice(m.to.indexOf('r') + 1));
      expect(toRow).toBe(fromRow + 1);
    }
  });
});

describe('getJumpMoves', () => {
  test('36 up-jumps', () => {
    expect(getJumpMoves('up')).toHaveLength(36);
  });

  test('36 down-jumps', () => {
    expect(getJumpMoves('down')).toHaveLength(36);
  });

  test('jump lands 2 rows away, over cell is in between', () => {
    for (const j of getJumpMoves('up')) {
      const fromRow = parseInt(j.from.slice(j.from.indexOf('r') + 1));
      const toRow = parseInt(j.to.slice(j.to.indexOf('r') + 1));
      const overRow = parseInt(j.over.slice(j.over.indexOf('r') + 1));
      expect(toRow).toBe(fromRow - 2);
      expect(overRow).toBe(fromRow - 1);
    }
  });

  test('all jump cells are dark squares', () => {
    const dark = new Set(darkSquares());
    for (const j of getJumpMoves('up')) {
      expect(dark.has(j.from)).toBe(true);
      expect(dark.has(j.to)).toBe(true);
      expect(dark.has(j.over)).toBe(true);
    }
  });
});

describe('buildCheckersRules', () => {
  const rules = buildCheckersRules('checkers');

  test('generates valid rules source', () => {
    expect(rules).toContain("rules_version = '2'");
    expect(rules).toContain('match /checkers/{gameId}');
  });

  test('under 35KB practical size limit', () => {
    expect(rules.length).toBeLessThan(35000);
  });

  // BUG BASH FINDING: Gate pattern for cross-rule budget
  test('simple move rules gate on captured=="" for cheap rejection', () => {
    // Each simple move allow rule has captured=='' BEFORE the geometry function
    const pattern = /captured == ''\s*\n\s*&& normalMoveChecks\(\) && (hostFwd|hostBack|guestFwd|guestBack)\(\)/g;
    const matches = rules.match(pattern);
    expect(matches).toHaveLength(4);
  });

  test('jump rules gate on captured!="" for cheap rejection', () => {
    // Each jump allow rule has captured!='' as first condition
    const pattern = /captured != ''\s*\n\s*&& request\.resource\.data\.status/g;
    const matches = rules.match(pattern);
    expect(matches).toHaveLength(8); // 4 normal + 4 winning
  });

  // BUG BASH FINDING: moveIntegrity must include 'status' for win transitions
  test('moveIntegrity includes status in hasOnly set', () => {
    expect(rules).toContain("'moveCount', 'status',");
  });

  // BUG BASH FINDING: Piece counters replace 64-expression noGuestPieces
  test('uses piece counter for win detection instead of cell enumeration', () => {
    expect(rules).toContain('guestCount == 0');
    expect(rules).toContain('hostCount == 0');
    expect(rules).not.toContain('noGuestPieces');
    expect(rules).not.toContain('noHostPieces');
  });

  test('includes captureDecrement function', () => {
    expect(rules).toContain('function captureDecrement()');
    expect(rules).toContain('guestCount == resource.data.guestCount - 1');
  });

  test('includes countsUnchanged function for simple moves', () => {
    expect(rules).toContain('function countsUnchanged()');
  });

  test('create rule validates initial piece counts', () => {
    expect(rules).toContain('hostCount == 12');
    expect(rules).toContain('guestCount == 12');
  });

  // BUG BASH FINDING: moveIntegrity includes counter fields
  test('moveIntegrity allows counter fields to change', () => {
    expect(rules).toContain("'hostCount', 'guestCount'");
  });

  // Structure: 16 allow rules
  test('has 16 allow rules (read + create + join + delete + 4 simple + 4 jump + 4 win)', () => {
    const allowLines = rules.split('\n').filter(l => l.trim().startsWith('allow'));
    expect(allowLines).toHaveLength(16);
  });

  // Movement-specific: direction enforcement
  test('host forward uses hostFwd (up-moves)', () => {
    expect(rules).toContain('function hostFwd()');
  });

  test('host backward restricted to kings only', () => {
    // hostBack geometry requires resource.data[mf] == 'H' (king only)
    const hostBackFn = rules.slice(
      rules.indexOf('function hostBack()'),
      rules.indexOf('function hostBack()') + 500
    );
    expect(hostBackFn).toContain("resource.data[mf] == 'H'");
    expect(hostBackFn).not.toContain("resource.data[mf] == 'h'");
  });

  // Kinging validation
  test('piecePlaced enforces kinging at row boundaries', () => {
    expect(rules).toContain("mt == 'c1r0'"); // host kinging row
    expect(rules).toContain("mt == 'c0r7'"); // guest kinging row
  });
});

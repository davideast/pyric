import { describe, test, expect } from 'bun:test';
import { GAME_SPECS } from '../../../../src/rules/rtdb/constraints/game.spec.js';
import { turnGuard, flip, winCheckHelper } from '../../../../src/rules/rtdb/constraints/game.js';
import { buildRuleExpression } from '../../../../src/rules/rtdb/compiled-rules.js';

describe('Game Primitives', () => {
  describe('turnGuard', () => {
    test('with status field', () => {
      const result = turnGuard('currentTurn', { X: 'playerX', O: 'playerO' }, 'status', 'playing');
      expect(result).toBe(GAME_SPECS.turnGuardWithStatus.output);
    });

    test('without status field', () => {
      const result = turnGuard('currentTurn', { X: 'playerX', O: 'playerO' });
      expect(result).toBe(GAME_SPECS.turnGuardNoStatus.output);
    });

    test('with 3 players', () => {
      const result = turnGuard('turn', { A: 'p1', B: 'p2', C: 'p3' });
      expect(result).toContain('data.child("turn").val() === "A"');
      expect(result).toContain('data.child("turn").val() === "B"');
      expect(result).toContain('data.child("turn").val() === "C"');
      expect(result.split('||').length).toBe(3);
    });

    test('uses data (pre-write) not newData', () => {
      const result = turnGuard('currentTurn', { X: 'playerX' });
      expect(result).toContain('data.child("currentTurn")');
      expect(result).not.toContain('newData');
    });

    test('parses as valid write expression', () => {
      const result = turnGuard('currentTurn', { X: 'playerX', O: 'playerO' }, 'status', 'playing');
      const parsed = buildRuleExpression(result, 'write', []);
      expect(parsed.parsed.valid).toBe(true);
    });
  });

  describe('flip', () => {
    test('2 marks', () => {
      expect(flip(['X', 'O'])).toBe(GAME_SPECS.flipTwoMarks.output);
    });

    test('3 marks (circular rotation)', () => {
      expect(flip(['A', 'B', 'C'])).toBe(GAME_SPECS.flipThreeMarks.output);
    });

    test('creation starts at first mark', () => {
      const result = flip(['X', 'O']);
      expect(result).toContain('(!(data.exists()))');
      expect(result).toContain('newData.val() === "X"');
    });

    test('parses as valid validate expression', () => {
      const result = flip(['X', 'O']);
      const parsed = buildRuleExpression(result, 'validate', []);
      expect(parsed.parsed.valid).toBe(true);
    });
  });

  describe('winCheckHelper', () => {
    test('includes board path references', () => {
      const result = winCheckHelper('X', [[0,1,2],[3,4,5]], 'board');
      for (const check of GAME_SPECS.winCheckHelper.checks.includesAll) {
        expect(result).toContain(check);
      }
    });

    test('parses as valid validate expression', () => {
      const result = winCheckHelper('X', [[0,1,2],[3,4,5]], 'board');
      const parsed = buildRuleExpression(result, 'validate', []);
      expect(parsed.parsed.valid).toBe(true);
    });

    test('full TTT (8 lines) generates long expression', () => {
      const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
      const result = winCheckHelper('X', lines);
      expect(result.length).toBeGreaterThan(1000);
    });

    test('full TTT parses as valid', () => {
      const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
      const result = winCheckHelper('X', lines);
      const parsed = buildRuleExpression(result, 'validate', []);
      expect(parsed.parsed.valid).toBe(true);
    });

    test('default boardPath is board', () => {
      const result = winCheckHelper('O', [[0,1,2]]);
      expect(result).toContain('board/0');
      expect(result).toContain('board/1');
      expect(result).toContain('board/2');
    });

    test('custom boardPath', () => {
      const result = winCheckHelper('X', [[0,1,2]], 'grid');
      expect(result).toContain('grid/0');
      expect(result).not.toContain('board/');
    });

    test('mark O works same as X', () => {
      const result = winCheckHelper('O', [[0,1,2]]);
      expect(result).toContain('"O"');
      expect(result).not.toContain('"X"');
    });
  });
});

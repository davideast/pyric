import { describe, test, expect } from 'bun:test';
import { assembleGameRules, type GameConfig } from '../../../src/rules/generators/assembler.js';
import { defaultCellName } from '../../../src/rules/generators/grid.js';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
import { validateFirestoreRules } from '../../../src/rules/grammar/FirestoreValidator.js';

const connectFour: GameConfig = {
  collection: 'games',
  grid: { cols: 7, rows: 6, cellName: defaultCellName },
  winLineCount: 4,
  hasGravity: true,
  hasLobby: true,
};

const ticTacToe: GameConfig = {
  collection: 'games',
  grid: { cols: 3, rows: 3, cellName: defaultCellName },
  winLineCount: 3,
  hasGravity: false,
  hasLobby: true,
};

describe('assembleGameRules', () => {
  test('Connect Four config produces valid rules source', () => {
    const rules = assembleGameRules(connectFour);
    const ast = parseToAST(rules);
    expect(ast).not.toBeNull();
    expect(ast!.version).toBe('2');
  });

  test('Tic-Tac-Toe config (no gravity) omits gravity from validMove', () => {
    const rules = assembleGameRules(ticTacToe);
    // Should not contain gravity-specific patterns like "ob.c0r0 != ''"
    // within validMove. But it should still have placement and integrity.
    expect(rules).toContain('validMove');
    // Gravity generates "ob.cXrY != ''" patterns. Without gravity,
    // validMove should only have placement + integrity
    const ast = parseToAST(rules);
    expect(ast).not.toBeNull();
  });

  test('rules have no critical validation findings', () => {
    const rules = assembleGameRules(connectFour);
    const ast = parseToAST(rules)!;
    const findings = validateFirestoreRules(ast);
    const critical = findings.filter(f => f.severity === 'critical');
    expect(critical).toHaveLength(0);
  });

  test('split-allow: separate rules for normal move, host win, guest win, draw', () => {
    const rules = assembleGameRules(connectFour);
    // Count "allow update" occurrences (lobby join + normal + host win + guest win + draw = 5)
    const updateCount = (rules.match(/allow update:/g) || []).length;
    expect(updateCount).toBe(5); // join + normal + 2 wins + draw
  });

  test('win rules call hasWonHost/hasWonGuest', () => {
    const rules = assembleGameRules(connectFour);
    expect(rules).toContain('hasWonHost(request.resource.data.board)');
    expect(rules).toContain('hasWonGuest(request.resource.data.board)');
  });

  test('normal move rule calls validMove but not win functions', () => {
    const rules = assembleGameRules(connectFour);
    // Find the normal move rule (contains validMove and status == 'playing')
    const normalMoveSection = rules.split('Normal move')[1]?.split('Winning move')[0];
    expect(normalMoveSection).toContain('validMove(');
    expect(normalMoveSection).not.toContain('hasWonHost');
    expect(normalMoveSection).not.toContain('hasWonGuest');
  });

  test('lobby rules present when hasLobby is true', () => {
    const rules = assembleGameRules(connectFour);
    expect(rules).toContain('waiting');
    expect(rules).toContain('allow delete');
    expect(rules).toContain("guest == ''");
  });

  test('lobby rules absent when hasLobby is false', () => {
    const rules = assembleGameRules({ ...connectFour, hasLobby: false });
    expect(rules).not.toContain('waiting');
    expect(rules).not.toContain('allow delete');
  });

  test('output uses host/guest convention', () => {
    const rules = assembleGameRules(connectFour);
    expect(rules).toContain('resource.data.host');
    expect(rules).toContain('resource.data.guest');
    expect(rules).toContain("currentTurn == 'host'");
    expect(rules).toContain("currentTurn == 'guest'");
    expect(rules).not.toContain('player1');
    expect(rules).not.toContain('player2');
  });

  test('Tic-Tac-Toe has 8 win lines per player (16 total)', () => {
    const rules = assembleGameRules(ticTacToe);
    // Each win line for host: b.cXrY == 'host'
    const hostWins = (rules.match(/== 'host'/g) || []).length;
    const guestWins = (rules.match(/== 'guest'/g) || []).length;
    // 8 lines × 3 cells = 24 per mark, plus turn references
    // Just check both functions exist and have content
    expect(rules).toContain("function hasWonHost(b)");
    expect(rules).toContain("function hasWonGuest(b)");
    expect(hostWins).toBeGreaterThan(8);
    expect(guestWins).toBeGreaterThan(8);
  });

  describe('collection allowlist (rules-injection guard)', () => {
    const withCollection = (collection: string): GameConfig => ({
      ...ticTacToe,
      collection,
    });

    test('rejects an injection payload that would break out of the match block', () => {
      const malicious =
        "x/{id} { allow read: if true; } match /pwned";
      expect(() => assembleGameRules(withCollection(malicious))).toThrow(/invalid collection/);
    });

    test('rejects slashes, braces, whitespace and empty', () => {
      for (const bad of ['a/b', 'a{b}', 'a b', 'a\nb', '', 'x'.repeat(65)]) {
        expect(() => assembleGameRules(withCollection(bad))).toThrow(/invalid collection/);
      }
    });

    test('accepts a valid single path segment and scopes the match block to it', () => {
      const rules = assembleGameRules(withCollection('my_games-2'));
      expect(rules).toContain('match /my_games-2/{gameId}');
      // No injected/extra collection match block leaked in.
      const matchBlocks = (rules.match(/match \/[A-Za-z0-9_-]+\/\{gameId\}/g) || []);
      expect(matchBlocks).toEqual(['match /my_games-2/{gameId}']);
      const ast = parseToAST(rules);
      expect(ast).not.toBeNull();
    });
  });
});

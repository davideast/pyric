import { describe, expect, test } from 'bun:test';
import { CHESS_SCENARIOS } from '../../../src/examples/chess/scenarios';
import { createChessSession } from '../../../src/examples/chess/session';

describe('chess showcase session', () => {
  test('commits moves for White and Black', async () => {
    const session = createChessSession();
    expect(session.lint.errors).toBe(0);
    const allowed = await session.move('white', 'e2', 'e4');

    expect(allowed.allowed).toBe(true);
    expect(session.game().e2).toBe('');
    expect(session.game().e4).toBe('P');

    const black = await session.move('black', 'e7', 'e5');
    expect(black.allowed).toBe(true);
    expect(session.game().e7).toBe('');
    expect(session.game().e5).toBe('p');
  });

  test('leaves the board untouched after an illegal move', async () => {
    const session = createChessSession();
    const before = session.game();
    const denied = await session.move('white', 'e2', 'e5');
    expect(denied.allowed).toBe(false);
    expect(session.game()).toEqual(before);
  });

  test('reset returns a fresh initial board', async () => {
    const session = createChessSession();
    await session.move('white', 'e2', 'e4');

    const reset = session.reset();
    expect(reset.game().e2).toBe('P');
    expect(reset.game().e4).toBe('');
    expect(reset.game().moveCount).toBe(0);
  });

  for (const scenario of CHESS_SCENARIOS) {
    test(`runs the ${scenario.label} scenario through Security Rules`, async () => {
      const session = createChessSession();
      let allowed = true;
      let winner: 'white' | 'black' | null = null;

      for (const { player, from, to } of scenario.moves) {
        const verdict = await session.move(player, from, to);
        allowed = verdict.allowed;
        winner = verdict.checkmate;
        if (!allowed) break;
      }

      expect(allowed).toBe(scenario.expected.allowed);
      expect(winner).toBe(scenario.expected.winner);
    });
  }
});

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { resolveModulesBrowser, SimulateFirestoreRulesHandler, type TestCase } from 'pyric/rules/internal';
import {
  checkmateWinner,
  createChessGame,
  createEmptyChessGame,
  isCheckmate,
  proposeMove,
  type ChessGame,
} from '../../../src/examples/chess/run';

const RULES_URL = new URL('../../../src/examples/chess/chess-v2.rules', import.meta.url);
const CONFIG_URL = new URL('../../../src/examples/chess/chess-v2-config.json', import.meta.url);
const AUTHORED_RULES = readFileSync(RULES_URL, 'utf8');
const RESOLUTION = resolveModulesBrowser(AUTHORED_RULES);
if (!RESOLUTION.success) throw new Error(RESOLUTION.error.message);
const RULES = RESOLUTION.data.resolved;
const CONFIG = JSON.parse(readFileSync(CONFIG_URL, 'utf8'));
const handler = new SimulateFirestoreRulesHandler();

function game(overrides: ChessGame): ChessGame {
  return { ...createEmptyChessGame(), ...overrides };
}

function scenario(
  description: string,
  expectation: 'ALLOW' | 'DENY',
  resource: ChessGame,
  data: ChessGame,
  uid: 'white' | 'black' = 'white',
): TestCase {
  return {
    description,
    expectation,
    method: 'update',
    path: 'chess-v2/demo',
    auth: { uid },
    resource,
    data,
    functionMocks: [{ function: 'get', path: 'gameConfig/chessv2', result: CONFIG }],
  };
}

const SCENARIOS: TestCase[] = [
  scenario('knight b1 → c3', 'ALLOW',
    game({ e1: 'K', hp_K: 'e1', b1: 'N', hp_N1: 'b1', e8: 'k', gp_k: 'e8' }),
    game({ e1: 'K', hp_K: 'e1', b1: '', c3: 'N', hp_N1: 'c3', e8: 'k', gp_k: 'e8', moveFrom: 'b1', moveTo: 'c3', movedPiece: 'hp_N1', moveType: 'normal', moveCount: 1, currentTurn: 'guest' })),
  scenario('invalid knight b1 → b3', 'DENY',
    game({ e1: 'K', hp_K: 'e1', b1: 'N', hp_N1: 'b1', e8: 'k', gp_k: 'e8' }),
    game({ e1: 'K', hp_K: 'e1', b1: '', b3: 'N', hp_N1: 'b3', e8: 'k', gp_k: 'e8', moveFrom: 'b1', moveTo: 'b3', movedPiece: 'hp_N1', moveType: 'normal', moveCount: 1, currentTurn: 'guest' })),
  scenario('bishop c1 → f4 on a clear path', 'ALLOW',
    game({ e1: 'K', hp_K: 'e1', c1: 'B', hp_B1: 'c1', e8: 'k', gp_k: 'e8' }),
    game({ e1: 'K', hp_K: 'e1', c1: '', f4: 'B', hp_B1: 'f4', e8: 'k', gp_k: 'e8', moveFrom: 'c1', moveTo: 'f4', movedPiece: 'hp_B1', moveType: 'normal', moveCount: 1, currentTurn: 'guest' })),
  scenario('bishop c1 → f4 through d2', 'DENY',
    game({ e1: 'K', hp_K: 'e1', c1: 'B', hp_B1: 'c1', d2: 'P', hp_P4: 'd2', e8: 'k', gp_k: 'e8' }),
    game({ e1: 'K', hp_K: 'e1', c1: '', f4: 'B', hp_B1: 'f4', d2: 'P', hp_P4: 'd2', e8: 'k', gp_k: 'e8', moveFrom: 'c1', moveTo: 'f4', movedPiece: 'hp_B1', moveType: 'normal', moveCount: 1, currentTurn: 'guest' })),
  scenario('pawn e2 → e3', 'ALLOW',
    game({ e1: 'K', hp_K: 'e1', e2: 'P', hp_P5: 'e2', e8: 'k', gp_k: 'e8' }),
    game({ e1: 'K', hp_K: 'e1', e2: '', e3: 'P', hp_P5: 'e3', e8: 'k', gp_k: 'e8', moveFrom: 'e2', moveTo: 'e3', movedPiece: 'hp_P5', moveType: 'pawn_forward', moveCount: 1, currentTurn: 'guest' })),
  scenario('pawn e2 → e4', 'ALLOW',
    game({ e1: 'K', hp_K: 'e1', e2: 'P', hp_P5: 'e2', e8: 'k', gp_k: 'e8' }),
    game({ e1: 'K', hp_K: 'e1', e2: '', e4: 'P', hp_P5: 'e4', e8: 'k', gp_k: 'e8', moveFrom: 'e2', moveTo: 'e4', movedPiece: 'hp_P5', moveType: 'double_pawn', lastDoublePawn: 'e3', moveCount: 1, currentTurn: 'guest' })),
  scenario('knight captures a pawn', 'ALLOW',
    game({ e1: 'K', hp_K: 'e1', d4: 'N', hp_N1: 'd4', e6: 'p', gp_p5: 'e6', e8: 'k', gp_k: 'e8' }),
    game({ e1: 'K', hp_K: 'e1', d4: '', e6: 'N', hp_N1: 'e6', gp_p5: '', e8: 'k', gp_k: 'e8', moveFrom: 'd4', moveTo: 'e6', movedPiece: 'hp_N1', capturedPiece: 'gp_p5', moveType: 'capture', moveCount: 1, currentTurn: 'guest' })),
  scenario('pinned bishop e4 → d5 exposes its king', 'DENY',
    game({ e1: 'K', hp_K: 'e1', e4: 'B', hp_B1: 'e4', e8: 'r', gp_r1: 'e8', a8: 'k', gp_k: 'a8' }),
    game({ e1: 'K', hp_K: 'e1', e4: '', d5: 'B', hp_B1: 'd5', e8: 'r', gp_r1: 'e8', a8: 'k', gp_k: 'a8', moveFrom: 'e4', moveTo: 'd5', movedPiece: 'hp_B1', moveType: 'normal', moveCount: 1, currentTurn: 'guest' })),
  scenario('pinned bishop e4 → d3 exposes its king', 'DENY',
    game({ e1: 'K', hp_K: 'e1', e4: 'B', hp_B1: 'e4', e8: 'r', gp_r1: 'e8', a8: 'k', gp_k: 'a8' }),
    game({ e1: 'K', hp_K: 'e1', e4: '', d3: 'B', hp_B1: 'd3', e8: 'r', gp_r1: 'e8', a8: 'k', gp_k: 'a8', moveFrom: 'e4', moveTo: 'd3', movedPiece: 'hp_B1', moveType: 'normal', moveCount: 1, currentTurn: 'guest' })),
  scenario('king e1 → d1 escapes check', 'ALLOW',
    game({ e1: 'K', hp_K: 'e1', d3: 'n', gp_n1: 'd3', e8: 'k', gp_k: 'e8' }),
    game({ e1: '', d1: 'K', hp_K: 'd1', d3: 'n', gp_n1: 'd3', e8: 'k', gp_k: 'e8', moveFrom: 'e1', moveTo: 'd1', movedPiece: 'hp_K', moveType: 'normal', moveCount: 1, currentTurn: 'guest', hp_K_moved: true })),
  scenario('king e1 → f2 remains in check', 'DENY',
    game({ e1: 'K', hp_K: 'e1', d3: 'n', gp_n1: 'd3', e8: 'k', gp_k: 'e8' }),
    game({ e1: '', f2: 'K', hp_K: 'f2', d3: 'n', gp_n1: 'd3', e8: 'k', gp_k: 'e8', moveFrom: 'e1', moveTo: 'f2', movedPiece: 'hp_K', moveType: 'normal', moveCount: 1, currentTurn: 'guest', hp_K_moved: true })),
  scenario('pawn d4 captures e5', 'ALLOW',
    game({ e1: 'K', hp_K: 'e1', d4: 'P', hp_P4: 'd4', e5: 'p', gp_p5: 'e5', e8: 'k', gp_k: 'e8' }),
    game({ e1: 'K', hp_K: 'e1', d4: '', e5: 'P', hp_P4: 'e5', gp_p5: '', e8: 'k', gp_k: 'e8', moveFrom: 'd4', moveTo: 'e5', movedPiece: 'hp_P4', capturedPiece: 'gp_p5', moveType: 'pawn_capture', moveCount: 1, currentTurn: 'guest' })),
  scenario('pawn d4 → e5 without capture metadata', 'DENY',
    game({ e1: 'K', hp_K: 'e1', d4: 'P', hp_P4: 'd4', e5: 'p', gp_p5: 'e5', e8: 'k', gp_k: 'e8' }),
    game({ e1: 'K', hp_K: 'e1', d4: '', e5: 'P', hp_P4: 'e5', gp_p5: 'e5', e8: 'k', gp_k: 'e8', moveFrom: 'd4', moveTo: 'e5', movedPiece: 'hp_P4', moveType: 'pawn_forward', moveCount: 1, currentTurn: 'guest' })),
  scenario('Black moves during White turn', 'DENY',
    game({ e1: 'K', hp_K: 'e1', b1: 'N', hp_N1: 'b1', e8: 'k', gp_k: 'e8' }),
    game({ e1: 'K', hp_K: 'e1', b1: '', c3: 'N', hp_N1: 'c3', e8: 'k', gp_k: 'e8', moveFrom: 'b1', moveTo: 'c3', movedPiece: 'hp_N1', moveType: 'normal', moveCount: 1, currentTurn: 'guest' }), 'black'),
  scenario('White resigns', 'ALLOW',
    game({ e1: 'K', hp_K: 'e1', e8: 'k', gp_k: 'e8' }),
    game({ e1: 'K', hp_K: 'e1', e8: 'k', gp_k: 'e8', status: 'resigned', moveType: 'resign' })),
];

describe('chess v2 production scenarios', () => {
  for (const candidate of SCENARIOS) {
    test(candidate.description, () => {
      const result = handler.simulate(RULES, [candidate]);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.results[0]?.state).toBe('PASSED');
    });
  }

  test('authors the chess rules with standard-library modules', () => {
    expect(AUTHORED_RULES).toContain("rules_version = '2+modules'");
    expect(AUTHORED_RULES).toContain("from 'auth'");
    expect(AUTHORED_RULES).toContain("from 'geometry'");
    expect(AUTHORED_RULES).toContain("from 'state'");
    expect(AUTHORED_RULES).toContain("from 'turns'");
    expect(RULES).toContain("rules_version = '2'");
    expect(RULES).not.toContain('import {');
  });

  test('ports the production-observed v2 geometry artifact', () => {
    const digest = createHash('sha256')
      .update(readFileSync(CONFIG_URL, 'utf8').trimEnd())
      .digest('hex');
    expect(digest).toBe('d142ae08855591a539899bc6c649f83d22cb7f20cd58d25ef61f1b92fd82f5bf');
  });
});

describe('chess end conditions', () => {
  test('detects Fool\'s Mate only after the checking move is committed', () => {
    let game = createChessGame();
    for (const [from, to] of [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4']] as const) {
      game = proposeMove(game, from, to);
      expect(checkmateWinner(game)).toBeNull();
    }
    game = proposeMove(game, 'd8', 'h4');
    expect(isCheckmate(game, 'white')).toBe(true);
    expect(checkmateWinner(game)).toBe('black');
  });

  test('does not confuse check with checkmate when the king can escape', () => {
    const game = createEmptyChessGame();
    Object.assign(game, { e1: 'K', hp_K: 'e1', h5: 'q', gp_q: 'h5', e8: 'k', gp_k: 'e8', currentTurn: 'host' });
    expect(isCheckmate(game, 'white')).toBe(false);
    expect(checkmateWinner(game)).toBeNull();
  });
});

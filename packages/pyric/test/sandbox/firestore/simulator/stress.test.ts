/**
 * Stress test: Run production-verified game scenarios through the simulator.
 *
 * These are the EXACT same test cases that passed against real Firestore.
 * Every mismatch between the simulator and production is a simulator bug.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SimulateFirestoreRulesHandler } from 'pyric/rules/internal';
import type { TestCase } from 'pyric/rules/internal';

const __dirname = dirname(fileURLToPath(import.meta.url));
const handler = new SimulateFirestoreRulesHandler();
const GAME_RULE_FIXTURES = join(__dirname, '../../../fixtures/firestore-game-rules');

// ═══ Load real rules ═══

const CHESS_RULES = readFileSync(join(GAME_RULE_FIXTURES, 'chess.rules'), 'utf-8');
const CHECKERS_RULES = readFileSync(join(GAME_RULE_FIXTURES, 'checkers-lookup.rules'), 'utf-8');

// ═══ Chess config (mock for get()) ═══

const CHESS_CONFIG = JSON.parse(readFileSync(join(GAME_RULE_FIXTURES, 'chess-config.json'), 'utf-8'));
const CHECKERS_CONFIG = JSON.parse(readFileSync(join(GAME_RULE_FIXTURES, 'chess-v2-config.json'), 'utf-8'));
// Checkers config — build minimal from the lookup generator
const CHECKERS_CONFIG_REAL = (() => {
  try {
    return JSON.parse(readFileSync(join(GAME_RULE_FIXTURES, 'checkers-config.json'), 'utf-8'));
  } catch {
    return null;
  }
})();

function chessMock() {
  return [{ function: 'get' as const, path: 'gameConfig/chess', result: CHESS_CONFIG }];
}

function checkersMock() {
  if (!CHECKERS_CONFIG_REAL) return [];
  return [{ function: 'get' as const, path: 'gameConfig/checkers', result: CHECKERS_CONFIG_REAL }];
}

// ═══ Chess board helpers ═══

function emptyBoard(): Record<string, string> {
  const b: Record<string, string> = {};
  for (const f of 'abcdefgh') for (const r of '12345678') b[f + r] = '';
  return b;
}

const EMPTY_POS: Record<string, string> = {};
for (const p of ['hp_K','hp_Q','hp_R1','hp_R2','hp_B1','hp_B2','hp_N1','hp_N2',
  'hp_P1','hp_P2','hp_P3','hp_P4','hp_P5','hp_P6','hp_P7','hp_P8',
  'gp_k','gp_q','gp_r1','gp_r2','gp_b1','gp_b2','gp_n1','gp_n2',
  'gp_p1','gp_p2','gp_p3','gp_p4','gp_p5','gp_p6','gp_p7','gp_p8']) {
  EMPTY_POS[p] = '';
}

function chessGame(ov: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...emptyBoard(), ...EMPTY_POS,
    host: 'white', guest: 'black',
    status: 'playing', currentTurn: 'host',
    moveCount: 0, moveFrom: '', moveTo: '',
    movedPiece: '', capturedPiece: '', moveType: '', promotedTo: '',
    lastDoublePawn: '',
    hp_K_moved: false, hp_R1_moved: false, hp_R2_moved: false,
    gp_k_moved: false, gp_r1_moved: false, gp_r2_moved: false,
    ...ov,
  };
}

// ═══ Checkers board helpers ═══

function checkersDarkSquares(): string[] {
  const sq: string[] = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if ((c+r) % 2 === 1) sq.push(`c${c}r${r}`);
  return sq;
}

function checkersEmptyBoard(): Record<string, string> {
  const b: Record<string, string> = {};
  for (const s of checkersDarkSquares()) b[s] = '';
  return b;
}

function checkersGame(ov: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...checkersEmptyBoard(),
    host: 'white', guest: 'black',
    status: 'playing', currentTurn: 'host',
    moveCount: 0, moveFrom: '', moveTo: '', captured: '',
    hostCount: 0, guestCount: 0,
    ...ov,
  };
}

// ═══ Chess stress tests ═══

describe('Stress: Chess rules via simulator', () => {

  test('1. knight b1->c3 allowed', () => {
    const r = handler.simulate(CHESS_RULES, [{
      description: 'knight move',
      expectation: 'ALLOW',
      method: 'update',
      path: 'chess/t1',
      auth: { uid: 'white' },
      resource: chessGame({ e1: 'K', hp_K: 'e1', b1: 'N', hp_N1: 'b1', e8: 'k', gp_k: 'e8' }),
      data: chessGame({ e1: 'K', hp_K: 'e1', b1: '', c3: 'N', hp_N1: 'c3', e8: 'k', gp_k: 'e8', moveFrom: 'b1', moveTo: 'c3', movedPiece: 'hp_N1', moveType: 'normal', moveCount: 1, currentTurn: 'guest' }),
      functionMocks: chessMock(),
    }]);
    expect(r.success).toBe(true);
    if (r.success) {
      if (r.data.results[0].state === 'FAILED') console.log('Chess 1:', r.data.results[0].debugMessages);
      expect(r.data.results[0].state).toBe('PASSED');
    }
  });

  test('2. knight b1->b3 denied (invalid geometry)', () => {
    const r = handler.simulate(CHESS_RULES, [{
      description: 'invalid knight',
      expectation: 'DENY',
      method: 'update',
      path: 'chess/t1',
      auth: { uid: 'white' },
      resource: chessGame({ e1: 'K', hp_K: 'e1', b1: 'N', hp_N1: 'b1', e8: 'k', gp_k: 'e8' }),
      data: chessGame({ e1: 'K', hp_K: 'e1', b1: '', b3: 'N', hp_N1: 'b3', e8: 'k', gp_k: 'e8', moveFrom: 'b1', moveTo: 'b3', movedPiece: 'hp_N1', moveType: 'normal', moveCount: 1, currentTurn: 'guest' }),
      functionMocks: chessMock(),
    }]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.results[0].state).toBe('PASSED');
  });

  test('3. bishop c1->f4 clear path allowed', () => {
    const r = handler.simulate(CHESS_RULES, [{
      description: 'bishop move',
      expectation: 'ALLOW',
      method: 'update',
      path: 'chess/t2',
      auth: { uid: 'white' },
      resource: chessGame({ e1: 'K', hp_K: 'e1', c1: 'B', hp_B1: 'c1', e8: 'k', gp_k: 'e8' }),
      data: chessGame({ e1: 'K', hp_K: 'e1', c1: '', f4: 'B', hp_B1: 'f4', e8: 'k', gp_k: 'e8', moveFrom: 'c1', moveTo: 'f4', movedPiece: 'hp_B1', moveType: 'normal', moveCount: 1, currentTurn: 'guest' }),
      functionMocks: chessMock(),
    }]);
    expect(r.success).toBe(true);
    if (r.success) {
      if (r.data.results[0].state === 'FAILED') console.log('Chess 3:', r.data.results[0].debugMessages);
      expect(r.data.results[0].state).toBe('PASSED');
    }
  });

  test('4. bishop blocked by pawn — denied', () => {
    const r = handler.simulate(CHESS_RULES, [{
      description: 'bishop blocked',
      expectation: 'DENY',
      method: 'update',
      path: 'chess/t2b',
      auth: { uid: 'white' },
      resource: chessGame({ e1: 'K', hp_K: 'e1', c1: 'B', hp_B1: 'c1', d2: 'P', hp_P4: 'd2', e8: 'k', gp_k: 'e8' }),
      data: chessGame({ e1: 'K', hp_K: 'e1', c1: '', f4: 'B', hp_B1: 'f4', d2: 'P', hp_P4: 'd2', e8: 'k', gp_k: 'e8', moveFrom: 'c1', moveTo: 'f4', movedPiece: 'hp_B1', moveType: 'normal', moveCount: 1, currentTurn: 'guest' }),
      functionMocks: chessMock(),
    }]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.results[0].state).toBe('PASSED');
  });

  test('5. pawn e2->e3 forward allowed', () => {
    const r = handler.simulate(CHESS_RULES, [{
      description: 'pawn forward',
      expectation: 'ALLOW',
      method: 'update',
      path: 'chess/t3',
      auth: { uid: 'white' },
      resource: chessGame({ e1: 'K', hp_K: 'e1', e2: 'P', hp_P5: 'e2', e8: 'k', gp_k: 'e8' }),
      data: chessGame({ e1: 'K', hp_K: 'e1', e2: '', e3: 'P', hp_P5: 'e3', e8: 'k', gp_k: 'e8', moveFrom: 'e2', moveTo: 'e3', movedPiece: 'hp_P5', moveType: 'pawn_forward', moveCount: 1, currentTurn: 'guest' }),
      functionMocks: chessMock(),
    }]);
    expect(r.success).toBe(true);
    if (r.success) {
      if (r.data.results[0].state === 'FAILED') console.log('Chess 5:', r.data.results[0].debugMessages);
      expect(r.data.results[0].state).toBe('PASSED');
    }
  });

  test('6. pawn e2->e4 double move allowed', () => {
    const r = handler.simulate(CHESS_RULES, [{
      description: 'pawn double',
      expectation: 'ALLOW',
      method: 'update',
      path: 'chess/t3b',
      auth: { uid: 'white' },
      resource: chessGame({ e1: 'K', hp_K: 'e1', e2: 'P', hp_P5: 'e2', e8: 'k', gp_k: 'e8' }),
      data: chessGame({ e1: 'K', hp_K: 'e1', e2: '', e4: 'P', hp_P5: 'e4', e8: 'k', gp_k: 'e8', moveFrom: 'e2', moveTo: 'e4', movedPiece: 'hp_P5', moveType: 'double_pawn', lastDoublePawn: 'e3', moveCount: 1, currentTurn: 'guest' }),
      functionMocks: chessMock(),
    }]);
    expect(r.success).toBe(true);
    if (r.success) {
      if (r.data.results[0].state === 'FAILED') console.log('Chess 6:', r.data.results[0].debugMessages);
      expect(r.data.results[0].state).toBe('PASSED');
    }
  });

  test('7. knight captures pawn', () => {
    const r = handler.simulate(CHESS_RULES, [{
      description: 'capture',
      expectation: 'ALLOW',
      method: 'update',
      path: 'chess/t4',
      auth: { uid: 'white' },
      resource: chessGame({ e1: 'K', hp_K: 'e1', d4: 'N', hp_N1: 'd4', e6: 'p', gp_p5: 'e6', e8: 'k', gp_k: 'e8' }),
      data: chessGame({ e1: 'K', hp_K: 'e1', d4: '', e6: 'N', hp_N1: 'e6', gp_p5: '', e8: 'k', gp_k: 'e8', moveFrom: 'd4', moveTo: 'e6', movedPiece: 'hp_N1', capturedPiece: 'gp_p5', moveType: 'capture', moveCount: 1, currentTurn: 'guest' }),
      functionMocks: chessMock(),
    }]);
    expect(r.success).toBe(true);
    if (r.success) {
      if (r.data.results[0].state === 'FAILED') console.log('Chess 7:', r.data.results[0].debugMessages);
      expect(r.data.results[0].state).toBe('PASSED');
    }
  });

  test('8. pin: bishop move exposes king to rook — DENIED', () => {
    const r = handler.simulate(CHESS_RULES, [{
      description: 'pin detection',
      expectation: 'DENY',
      method: 'update',
      path: 'chess/t5',
      auth: { uid: 'white' },
      resource: chessGame({ e1: 'K', hp_K: 'e1', e4: 'B', hp_B1: 'e4', e8: 'r', gp_r1: 'e8', a8: 'k', gp_k: 'a8' }),
      data: chessGame({ e1: 'K', hp_K: 'e1', e4: '', d5: 'B', hp_B1: 'd5', e8: 'r', gp_r1: 'e8', a8: 'k', gp_k: 'a8', moveFrom: 'e4', moveTo: 'd5', movedPiece: 'hp_B1', moveType: 'normal', moveCount: 1, currentTurn: 'guest' }),
      functionMocks: chessMock(),
    }]);
    expect(r.success).toBe(true);
    if (r.success) {
      if (r.data.results[0].state === 'FAILED') console.log('Chess 8:', r.data.results[0].debugMessages);
      expect(r.data.results[0].state).toBe('PASSED');
    }
  });

  test('9. king escapes knight check', () => {
    const r = handler.simulate(CHESS_RULES, [{
      description: 'king escape',
      expectation: 'ALLOW',
      method: 'update',
      path: 'chess/t6',
      auth: { uid: 'white' },
      resource: chessGame({ e1: 'K', hp_K: 'e1', d3: 'n', gp_n1: 'd3', e8: 'k', gp_k: 'e8' }),
      data: chessGame({ e1: '', d1: 'K', hp_K: 'd1', d3: 'n', gp_n1: 'd3', e8: 'k', gp_k: 'e8', moveFrom: 'e1', moveTo: 'd1', movedPiece: 'hp_K', moveType: 'normal', moveCount: 1, currentTurn: 'guest', hp_K_moved: true }),
      functionMocks: chessMock(),
    }]);
    expect(r.success).toBe(true);
    if (r.success) {
      if (r.data.results[0].state === 'FAILED') console.log('Chess 9:', r.data.results[0].debugMessages);
      expect(r.data.results[0].state).toBe('PASSED');
    }
  });

  test('10. king moves INTO knight check — DENIED', () => {
    const r = handler.simulate(CHESS_RULES, [{
      description: 'into check denied',
      expectation: 'DENY',
      method: 'update',
      path: 'chess/t6',
      auth: { uid: 'white' },
      resource: chessGame({ e1: 'K', hp_K: 'e1', d3: 'n', gp_n1: 'd3', e8: 'k', gp_k: 'e8' }),
      data: chessGame({ e1: '', f2: 'K', hp_K: 'f2', d3: 'n', gp_n1: 'd3', e8: 'k', gp_k: 'e8', moveFrom: 'e1', moveTo: 'f2', movedPiece: 'hp_K', moveType: 'normal', moveCount: 1, currentTurn: 'guest', hp_K_moved: true }),
      functionMocks: chessMock(),
    }]);
    expect(r.success).toBe(true);
    if (r.success) {
      if (r.data.results[0].state === 'FAILED') console.log('Chess 10:', r.data.results[0].debugMessages);
      expect(r.data.results[0].state).toBe('PASSED');
    }
  });

  test('11. wrong player denied', () => {
    const r = handler.simulate(CHESS_RULES, [{
      description: 'wrong player',
      expectation: 'DENY',
      method: 'update',
      path: 'chess/t8',
      auth: { uid: 'black' },
      resource: chessGame({ e1: 'K', hp_K: 'e1', b1: 'N', hp_N1: 'b1', e8: 'k', gp_k: 'e8' }),
      data: chessGame({ e1: 'K', hp_K: 'e1', b1: '', c3: 'N', hp_N1: 'c3', e8: 'k', gp_k: 'e8', moveFrom: 'b1', moveTo: 'c3', movedPiece: 'hp_N1', moveType: 'normal', moveCount: 1, currentTurn: 'guest' }),
      functionMocks: chessMock(),
    }]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.results[0].state).toBe('PASSED');
  });

  test('12. checkmate claim (queen checks king)', () => {
    const r = handler.simulate(CHESS_RULES, [{
      description: 'checkmate',
      expectation: 'ALLOW',
      method: 'update',
      path: 'chess/t9',
      auth: { uid: 'white' },
      resource: chessGame({ e1: 'K', hp_K: 'e1', h5: 'Q', hp_Q: 'h5', e8: 'k', gp_k: 'e8' }),
      data: chessGame({ e1: 'K', hp_K: 'e1', h5: 'Q', hp_Q: 'h5', e8: 'k', gp_k: 'e8', status: 'won', moveCount: 1, currentTurn: 'guest', moveType: 'checkmate' }),
      functionMocks: chessMock(),
    }]);
    expect(r.success).toBe(true);
    if (r.success) {
      if (r.data.results[0].state === 'FAILED') console.log('Chess 12:', r.data.results[0].debugMessages);
      expect(r.data.results[0].state).toBe('PASSED');
    }
  });

  test('13. false checkmate denied', () => {
    const r = handler.simulate(CHESS_RULES, [{
      description: 'false checkmate',
      expectation: 'DENY',
      method: 'update',
      path: 'chess/t9b',
      auth: { uid: 'white' },
      resource: chessGame({ e1: 'K', hp_K: 'e1', a1: 'Q', hp_Q: 'a1', e8: 'k', gp_k: 'e8' }),
      data: chessGame({ e1: 'K', hp_K: 'e1', a1: 'Q', hp_Q: 'a1', e8: 'k', gp_k: 'e8', status: 'won', moveCount: 1, currentTurn: 'guest', moveType: 'checkmate' }),
      functionMocks: chessMock(),
    }]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.results[0].state).toBe('PASSED');
  });

  test('14. resign', () => {
    const r = handler.simulate(CHESS_RULES, [{
      description: 'resign',
      expectation: 'ALLOW',
      method: 'update',
      path: 'chess/t10',
      auth: { uid: 'white' },
      resource: chessGame({ e1: 'K', hp_K: 'e1', e8: 'k', gp_k: 'e8' }),
      data: chessGame({ e1: 'K', hp_K: 'e1', e8: 'k', gp_k: 'e8', status: 'resigned', moveType: 'resign' }),
      functionMocks: chessMock(),
    }]);
    expect(r.success).toBe(true);
    if (r.success) {
      if (r.data.results[0].state === 'FAILED') console.log('Chess 14:', r.data.results[0].debugMessages);
      expect(r.data.results[0].state).toBe('PASSED');
    }
  });
});

// ═══ Checkers stress tests ═══

describe('Stress: Checkers rules via simulator', () => {

  test('1. valid simple move (host forward)', () => {
    if (!CHECKERS_CONFIG_REAL) return; // skip if no config
    const r = handler.simulate(CHECKERS_RULES, [{
      description: 'host forward c0r5→c1r4',
      expectation: 'ALLOW',
      method: 'update',
      path: 'checkers/g1',
      auth: { uid: 'white' },
      resource: checkersGame({ host: 'white', guest: 'black', c0r5: 'h', c1r4: '', c1r0: 'g', hostCount: 1, guestCount: 1 }),
      data: checkersGame({ host: 'white', guest: 'black', c0r5: '', c1r4: 'h', c1r0: 'g', hostCount: 1, guestCount: 1, moveFrom: 'c0r5', moveTo: 'c1r4', captured: '', currentTurn: 'guest', moveCount: 1 }),
      functionMocks: checkersMock(),
    }]);
    expect(r.success).toBe(true);
    if (r.success) {
      if (r.data.results[0].state === 'FAILED') console.log('Checkers 1:', r.data.results[0].debugMessages);
      expect(r.data.results[0].state).toBe('PASSED');
    }
  });

  test('2. invalid move denied', () => {
    if (!CHECKERS_CONFIG_REAL) return;
    const r = handler.simulate(CHECKERS_RULES, [{
      description: 'invalid c0r5→c3r2',
      expectation: 'DENY',
      method: 'update',
      path: 'checkers/g1',
      auth: { uid: 'white' },
      resource: checkersGame({ host: 'white', guest: 'black', c0r5: 'h', c3r2: '', c1r0: 'g', hostCount: 1, guestCount: 1 }),
      data: checkersGame({ host: 'white', guest: 'black', c0r5: '', c3r2: 'h', c1r0: 'g', hostCount: 1, guestCount: 1, moveFrom: 'c0r5', moveTo: 'c3r2', captured: '', currentTurn: 'guest', moveCount: 1 }),
      functionMocks: checkersMock(),
    }]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.results[0].state).toBe('PASSED');
  });

  test('3. wrong player denied', () => {
    if (!CHECKERS_CONFIG_REAL) return;
    const r = handler.simulate(CHECKERS_RULES, [{
      description: 'guest tries host turn',
      expectation: 'DENY',
      method: 'update',
      path: 'checkers/g1',
      auth: { uid: 'black' },
      resource: checkersGame({ host: 'white', guest: 'black', c0r5: 'h', c1r4: '', c1r0: 'g', hostCount: 1, guestCount: 1 }),
      data: checkersGame({ host: 'white', guest: 'black', c0r5: '', c1r4: 'h', c1r0: 'g', hostCount: 1, guestCount: 1, moveFrom: 'c0r5', moveTo: 'c1r4', captured: '', currentTurn: 'guest', moveCount: 1 }),
      functionMocks: checkersMock(),
    }]);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.results[0].state).toBe('PASSED');
  });
});

/**
 * Scenario 9: Rook + King Chess Subset
 *
 * 4x4 board with rook and king per side, config doc for move geometry,
 * path blocking for rook slides, check detection.
 * Stdlib: geometry, auth, lifecycle
 *
 * Rules: inline
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { resolveModules } from 'pyric/rules/node';

// ═══ Build config data programmatically for 4x4 grid ═══

const FILES = ['a', 'b', 'c', 'd'];
const RANKS = ['1', '2', '3', '4'];
const ALL_CELLS: string[] = [];
for (const f of FILES) for (const r of RANKS) ALL_CELLS.push(f + r);

function cellIndex(cell: string): [number, number] {
  return [FILES.indexOf(cell[0]), RANKS.indexOf(cell[1])];
}

function buildMoves(): Record<string, Record<string, Record<string, boolean>>> {
  const moves: Record<string, Record<string, Record<string, boolean>>> = {};

  // King (K/k): one square in any direction
  for (const piece of ['K', 'k']) {
    moves[piece] = {};
    for (const from of ALL_CELLS) {
      const [fx, fy] = cellIndex(from);
      const targets: Record<string, boolean> = {};
      for (const to of ALL_CELLS) {
        const [tx, ty] = cellIndex(to);
        const dx = Math.abs(fx - tx);
        const dy = Math.abs(fy - ty);
        if (dx <= 1 && dy <= 1 && (dx + dy > 0)) {
          targets[to] = true;
        }
      }
      if (Object.keys(targets).length > 0) moves[piece][from] = targets;
    }
  }

  // Rook (R/r): horizontal and vertical slides
  for (const piece of ['R', 'r']) {
    moves[piece] = {};
    for (const from of ALL_CELLS) {
      const [fx, fy] = cellIndex(from);
      const targets: Record<string, boolean> = {};
      for (const to of ALL_CELLS) {
        const [tx, ty] = cellIndex(to);
        if (from !== to && (fx === tx || fy === ty)) {
          targets[to] = true;
        }
      }
      if (Object.keys(targets).length > 0) moves[piece][from] = targets;
    }
  }

  return moves;
}

function buildPaths(): Record<string, Record<string, { len: number; c0: string; c1: string }>> {
  const paths: Record<string, Record<string, { len: number; c0: string; c1: string }>> = {};

  for (const from of ALL_CELLS) {
    paths[from] = {};
    const [fx, fy] = cellIndex(from);

    for (const to of ALL_CELLS) {
      const [tx, ty] = cellIndex(to);
      if (from === to) continue;
      if (fx !== tx && fy !== ty) continue; // only rook lines

      // Collect intermediate cells
      const intermediates: string[] = [];
      if (fx === tx) {
        const step = ty > fy ? 1 : -1;
        for (let r = fy + step; r !== ty; r += step) {
          intermediates.push(FILES[fx] + RANKS[r]);
        }
      } else {
        const step = tx > fx ? 1 : -1;
        for (let f = fx + step; f !== tx; f += step) {
          intermediates.push(FILES[f] + RANKS[fy]);
        }
      }

      paths[from][to] = {
        len: intermediates.length,
        c0: intermediates[0] || '',
        c1: intermediates[1] || '',
      };
    }
  }

  return paths;
}

const GAME_CONFIG = {
  moves: buildMoves(),
  paths: buildPaths(),
  pieceCategory: { K: 'step', k: 'step', R: 'slide', r: 'slide' },
};

const SOURCE = `import { validSimpleMove } from 'geometry';
import { isAuthenticated } from 'auth';
import { fieldUnchanged } from 'lifecycle';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /gameConfig/{id} { allow read: if true; allow write: if false; }
    match /games/{gameId} {
      function cfg() { return get(/databases/$(database)/documents/gameConfig/rookchess).data; }

      function isMyTurn() {
        return isAuthenticated()
            && ((resource.data.currentTurn == 'host' && request.auth.uid == resource.data.host)
                || (resource.data.currentTurn == 'guest' && request.auth.uid == resource.data.guest));
      }
      function turnFlipped() {
        return (resource.data.currentTurn == 'host' && request.resource.data.currentTurn == 'guest')
            || (resource.data.currentTurn == 'guest' && request.resource.data.currentTurn == 'host');
      }
      function isOwnPiece() {
        let piece = resource.data[request.resource.data.moveFrom];
        return (resource.data.currentTurn == 'host' && (piece == 'K' || piece == 'R'))
            || (resource.data.currentTurn == 'guest' && (piece == 'k' || piece == 'r'));
      }
      function moveCountIncremented() {
        return request.resource.data.moveCount == resource.data.moveCount + 1;
      }
      function pathClear() {
        let mf = request.resource.data.moveFrom;
        let mt = request.resource.data.moveTo;
        let piece = resource.data[mf];
        let p = cfg().paths[mf][mt];
        return cfg().pieceCategory[piece] == 'step'
            || ((p.len < 1 || resource.data[p.c0] == '')
                && (p.len < 2 || resource.data[p.c1] == ''));
      }
      function noSelfCapture() {
        let mt = request.resource.data.moveTo;
        let target = resource.data[mt];
        return target == ''
            || (resource.data.currentTurn == 'host' && target != 'K' && target != 'R')
            || (resource.data.currentTurn == 'guest' && target != 'k' && target != 'r');
      }

      // Check detection: after the move, is the moving side's king attacked by opponent rook?
      // We check the POST-write board: opponent rook must not have a clear line to our king.
      function notInCheck() {
        let b = request.resource.data;
        return resource.data.currentTurn == 'host'
            ? (!(b.hp_K in cfg().moves.r[b.gp_r])
                || (cfg().paths[b.gp_r][b.hp_K].len >= 1 && b[cfg().paths[b.gp_r][b.hp_K].c0] != '')
                || (cfg().paths[b.gp_r][b.hp_K].len >= 2 && b[cfg().paths[b.gp_r][b.hp_K].c1] != ''))
            : (!(b.gp_k in cfg().moves.R[b.hp_R])
                || (cfg().paths[b.hp_R][b.gp_k].len >= 1 && b[cfg().paths[b.hp_R][b.gp_k].c0] != '')
                || (cfg().paths[b.hp_R][b.gp_k].len >= 2 && b[cfg().paths[b.hp_R][b.gp_k].c1] != ''));
      }

      allow read: if true;
      allow update: if isMyTurn() && turnFlipped() && isOwnPiece()
          && moveCountIncremented()
          && fieldUnchanged('host') && fieldUnchanged('guest')
          && validSimpleMove(cfg())
          && pathClear()
          && noSelfCapture()
          && notInCheck();
    }
  }
}`;

const resolved = resolveModules(SOURCE);
if (!resolved.success) throw new Error(resolved.error.message);
const RULES = resolved.data.resolved;

describe('Scenario 9: Rook + King Chess Subset', () => {
  // 4x4 board: a1-d4
  // Initial: White King=a1, White Rook=d1, Black king=a4, Black rook=d4
  // Piece position tracking: hp_K, hp_R for host; gp_k, gp_r for guest

  function emptyBoard(): Record<string, string> {
    const b: Record<string, string> = {};
    for (const f of FILES) for (const r of RANKS) b[f + r] = '';
    return b;
  }

  function game(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...emptyBoard(),
      a1: 'K', d1: 'R', a4: 'k', d4: 'r',
      hp_K: 'a1', hp_R: 'd1', gp_k: 'a4', gp_r: 'd4',
      host: 'white', guest: 'black',
      status: 'playing', currentTurn: 'host',
      moveCount: 0, moveFrom: '', moveTo: '',
      ...overrides,
    };
  }

  function makeEnv(overrides: Record<string, unknown> = {}) {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES,
      documents: {
        'gameConfig/rookchess': GAME_CONFIG,
        'games/g1': game(overrides),
      },
    });
    return env;
  }

  test('king adjacent move', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'games/g1', auth: { uid: 'white' }, data: game({
      a1: '', b1: 'K', hp_K: 'b1',
      moveFrom: 'a1', moveTo: 'b1', moveCount: 1, currentTurn: 'guest',
    }) });
    expect(r.allowed).toBe(true);
  });

  test('rook vertical slide', () => {
    // Move rook d1 -> d3 (clear path, d2 is empty)
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'games/g1', auth: { uid: 'white' }, data: game({
      d1: '', d3: 'R', hp_R: 'd3',
      moveFrom: 'd1', moveTo: 'd3', moveCount: 1, currentTurn: 'guest',
    }) });
    expect(r.allowed).toBe(true);
  });

  test('rook horizontal slide', () => {
    // Move rook d1 -> b1 (clear path, c1 is empty)
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'games/g1', auth: { uid: 'white' }, data: game({
      d1: '', b1: 'R', hp_R: 'b1',
      // King moves off a1 first — set up a board where king is at b2
      a1: '', b2: 'K', hp_K: 'b2',
      moveFrom: 'd1', moveTo: 'b1', moveCount: 1, currentTurn: 'guest',
    }) });
    // Need king already moved — use overrides on initial state
    const env2 = makeEnv({ a1: '', b2: 'K', hp_K: 'b2' });
    const r2 = env2.execute({ method: 'update', path: 'games/g1', auth: { uid: 'white' }, data: game({
      b2: 'K', hp_K: 'b2',
      d1: '', b1: 'R', hp_R: 'b1',
      a1: '',
      moveFrom: 'd1', moveTo: 'b1', moveCount: 1, currentTurn: 'guest',
    }) });
    expect(r2.allowed).toBe(true);
  });

  test('king into rook check denied', () => {
    // Move white king from a1 to a2, but black rook on d4 can't reach a2 diagonally,
    // so we set up a scenario where the king moves into a rook's line.
    // Black rook at a4, king moves to a2 — rook has clear line a4->a2 (a3 empty)
    const env = makeEnv({ d4: '', a4: 'r', gp_r: 'a4', d3: 'k', gp_k: 'd3' });
    const r = env.execute({ method: 'update', path: 'games/g1', auth: { uid: 'white' }, data: game({
      a1: '', a2: 'K', hp_K: 'a2',
      d4: '', a4: 'r', gp_r: 'a4', d3: 'k', gp_k: 'd3',
      moveFrom: 'a1', moveTo: 'a2', moveCount: 1, currentTurn: 'guest',
    }) });
    expect(r.allowed).toBe(false);
  });

  test('rook diagonal denied (invalid geometry)', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'games/g1', auth: { uid: 'white' }, data: game({
      d1: '', c2: 'R', hp_R: 'c2',
      moveFrom: 'd1', moveTo: 'c2', moveCount: 1, currentTurn: 'guest',
    }) });
    expect(r.allowed).toBe(false);
  });

  test('wrong player denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'games/g1', auth: { uid: 'black' }, data: game({
      a4: '', a3: 'k', gp_k: 'a3',
      moveFrom: 'a4', moveTo: 'a3', moveCount: 1, currentTurn: 'host',
    }) });
    expect(r.allowed).toBe(false);
  });

  test('king teleport denied', () => {
    // King tries to move from a1 to c3 (2 squares diagonal — not adjacent)
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'games/g1', auth: { uid: 'white' }, data: game({
      a1: '', c3: 'K', hp_K: 'c3',
      moveFrom: 'a1', moveTo: 'c3', moveCount: 1, currentTurn: 'guest',
    }) });
    expect(r.allowed).toBe(false);
  });

  test('unauthenticated denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'games/g1', auth: null, data: game({
      a1: '', b1: 'K', hp_K: 'b1',
      moveFrom: 'a1', moveTo: 'b1', moveCount: 1, currentTurn: 'guest',
    }) });
    expect(r.allowed).toBe(false);
  });
});

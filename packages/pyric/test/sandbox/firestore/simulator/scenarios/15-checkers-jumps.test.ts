/**
 * Scenario 15: Checkers with Jump Captures (4x4)
 *
 * Minimal 4x4 checkers board using geometry stdlib for move validation,
 * turns stdlib for turn enforcement, state stdlib for game state.
 * Config doc built programmatically for the 4x4 board.
 * Stdlib: geometry, turns, state, auth
 */
import { describe, test, expect } from 'bun:test';
import { LocalEnvironment } from 'pyric/sandbox/internal';
import { resolveModules } from 'pyric/rules/node';

// ═══ Build 4x4 config document programmatically ═══
// Dark squares on a 4x4 board: (col+row) % 2 === 1
// Cells: c0r1, c1r0, c1r2, c2r1, c2r3, c3r0, c3r2
// Host (h): rows 2-3 (bottom), moves up (row decreases)
// Guest (g): rows 0-1 (top), moves down (row increases)

const BOARD_SIZE = 4;
function cell(c: number, r: number): string { return `c${c}r${r}`; }

function darkSquares(): string[] {
  const squares: string[] = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if ((c + r) % 2 === 1) squares.push(cell(c, r));
    }
  }
  return squares;
}

interface SimpleMove { from: string; to: string }
interface JumpMove { from: string; to: string; over: string }

function getSimpleMoves(dir: 'up' | 'down'): SimpleMove[] {
  const dr = dir === 'up' ? -1 : 1;
  const moves: SimpleMove[] = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if ((c + r) % 2 !== 1) continue;
      const nr = r + dr;
      if (nr < 0 || nr >= BOARD_SIZE) continue;
      if (c - 1 >= 0) moves.push({ from: cell(c, r), to: cell(c - 1, nr) });
      if (c + 1 < BOARD_SIZE) moves.push({ from: cell(c, r), to: cell(c + 1, nr) });
    }
  }
  return moves;
}

function getJumpMoves(dir: 'up' | 'down'): JumpMove[] {
  const dr = dir === 'up' ? -1 : 1;
  const jumps: JumpMove[] = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if ((c + r) % 2 !== 1) continue;
      const mr = r + dr;
      const nr = r + 2 * dr;
      if (nr < 0 || nr >= BOARD_SIZE) continue;
      if (c - 2 >= 0) jumps.push({ from: cell(c, r), to: cell(c - 2, nr), over: cell(c - 1, mr) });
      if (c + 2 < BOARD_SIZE) jumps.push({ from: cell(c, r), to: cell(c + 2, nr), over: cell(c + 1, mr) });
    }
  }
  return jumps;
}

function buildMoveMap(moves: SimpleMove[]): Record<string, Record<string, boolean>> {
  const map: Record<string, Record<string, boolean>> = {};
  for (const m of moves) {
    if (!map[m.from]) map[m.from] = {};
    map[m.from][m.to] = true;
  }
  return map;
}

function buildJumpMap(jumps: JumpMove[]): Record<string, Record<string, string>> {
  const map: Record<string, Record<string, string>> = {};
  for (const j of jumps) {
    if (!map[j.from]) map[j.from] = {};
    map[j.from][j.to] = j.over;
  }
  return map;
}

const upMoves = buildMoveMap(getSimpleMoves('up'));
const downMoves = buildMoveMap(getSimpleMoves('down'));
const upJumps = buildJumpMap(getJumpMoves('up'));
const downJumps = buildJumpMap(getJumpMoves('down'));

function mergeMaps<T>(a: Record<string, Record<string, T>>, b: Record<string, Record<string, T>>): Record<string, Record<string, T>> {
  const result: Record<string, Record<string, T>> = {};
  for (const [from, tos] of Object.entries(a)) result[from] = { ...tos };
  for (const [from, tos] of Object.entries(b)) {
    if (!result[from]) result[from] = {};
    Object.assign(result[from], tos);
  }
  return result;
}

const CONFIG_DATA = {
  moves: {
    h: upMoves,
    H: mergeMaps(upMoves, downMoves),
    g: downMoves,
    G: mergeMaps(upMoves, downMoves),
  },
  jumps: {
    h: upJumps,
    H: mergeMaps(upJumps, downJumps),
    g: downJumps,
    G: mergeMaps(upJumps, downJumps),
  },
};

// ═══ Rules ═══
const SOURCE = `import { validSimpleMove, validJumpMove } from 'geometry';
import { isMyTurn, turnFlipped } from 'turns';
import { isPlaying, moveIncremented, participantsUnchanged } from 'state';
import { isAuthenticated } from 'auth';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {

    match /gameConfig/{configId} {
      allow read: if true;
      allow write: if false;
    }

    match /jumpgames/{gameId} {

      function config() {
        return get(/databases/$(database)/documents/gameConfig/jumpgame).data;
      }

      // Piece placed: source cleared, destination filled
      function piecePlaced() {
        let mf = request.resource.data.moveFrom;
        let mt = request.resource.data.moveTo;
        let piece = resource.data[mf];
        return resource.data[mt] == ''
            && request.resource.data[mf] == ''
            && request.resource.data[mt] == piece;
      }

      // Capture: captured cell cleared, must be opponent
      function captureValid() {
        let cap = request.resource.data.captured;
        let turn = resource.data.currentTurn;
        return cap != ''
            && request.resource.data[cap] == ''
            && ((turn == 'host' && resource.data[cap] == 'g')
                || (turn == 'guest' && resource.data[cap] == 'h'));
      }

      // Piece counters unchanged (simple moves)
      function countsUnchanged() {
        return request.resource.data.hostCount == resource.data.hostCount
            && request.resource.data.guestCount == resource.data.guestCount;
      }

      // Piece counter decrements on capture
      function captureDecrement() {
        let turn = resource.data.currentTurn;
        return (turn == 'host'
              && request.resource.data.guestCount == resource.data.guestCount - 1
              && request.resource.data.hostCount == resource.data.hostCount)
            || (turn == 'guest'
              && request.resource.data.hostCount == resource.data.hostCount - 1
              && request.resource.data.guestCount == resource.data.guestCount);
      }

      // MapDiff integrity: only expected fields change
      function moveIntegrity() {
        return request.resource.data.diff(resource.data).affectedKeys().hasOnly([
          'moveFrom', 'moveTo', 'captured', 'currentTurn', 'moveCount', 'status',
          'hostCount', 'guestCount',
          request.resource.data.moveFrom,
          request.resource.data.moveTo,
          request.resource.data.captured
        ]);
      }

      allow read: if isAuthenticated();

      // Simple moves
      allow update: if isAuthenticated()
          && request.resource.data.captured == ''
          && isPlaying() && isMyTurn() && turnFlipped() && moveIncremented()
          && participantsUnchanged() && request.resource.data.status == 'playing'
          && validSimpleMove(config()) && piecePlaced() && countsUnchanged() && moveIntegrity();

      // Jump captures (playing continues)
      allow update: if isAuthenticated()
          && request.resource.data.captured != ''
          && request.resource.data.status == 'playing'
          && isPlaying() && isMyTurn() && turnFlipped() && moveIncremented()
          && participantsUnchanged()
          && validJumpMove(config()) && piecePlaced() && captureValid() && captureDecrement() && moveIntegrity();

      // Winning jump captures (opponent count reaches 0)
      allow update: if isAuthenticated()
          && request.resource.data.captured != ''
          && request.resource.data.status == 'won'
          && isPlaying() && isMyTurn() && turnFlipped() && moveIncremented()
          && participantsUnchanged()
          && validJumpMove(config()) && piecePlaced() && captureValid() && captureDecrement() && moveIntegrity()
          && (request.resource.data.guestCount == 0 || request.resource.data.hostCount == 0);
    }
  }
}`;

const resolved = resolveModules(SOURCE);
if (!resolved.success) throw new Error(resolved.error.message);
const RULES = resolved.data.resolved;

// ═══ Board helpers ═══
// 4x4 dark squares: c1r0, c3r0, c0r1, c2r1, c1r2, c3r2, c0r3, c2r3
// Initial: guest (g) on rows 0-1, host (h) on rows 2-3
// g1: standard start for simple move testing
// g2: set up for jump capture (host piece at c2r1 can jump guest at c1r2 to c0r3... but let's pick a good position)

function emptyBoard(): Record<string, string> {
  const b: Record<string, string> = {};
  for (const sq of darkSquares()) b[sq] = '';
  return b;
}

function gameDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...emptyBoard(),
    host: 'alice', guest: 'bob',
    status: 'playing', currentTurn: 'host',
    moveCount: 0,
    moveFrom: '', moveTo: '', captured: '',
    hostCount: 2, guestCount: 2,
    ...overrides,
  };
}

describe('Scenario 15: Checkers with Jump Captures', () => {
  function makeEnv() {
    const env = new LocalEnvironment();
    env.seed({
      rules: RULES,
      documents: {
        'gameConfig/jumpgame': CONFIG_DATA,
        // g1: simple move game. Host h at c1r2, can move up to c0r1 or c2r1.
        // Guest g at c0r3, c2r3 (won't interfere).
        'jumpgames/g1': gameDoc({
          c1r2: 'h', c3r2: 'h',
          c0r1: '', c2r1: '',
          c1r0: 'g', c3r0: 'g',
          hostCount: 2, guestCount: 2,
        }),
        // g2: jump game. Host h at c2r3, guest g at c1r2 (jumpable).
        // Host can jump from c2r3 over c1r2 to c0r1.
        // Also a guest at c3r0 (second guest piece so guestCount=2).
        'jumpgames/g2': gameDoc({
          c2r3: 'h', c0r3: 'h',
          c1r2: 'g', c3r0: 'g',
          hostCount: 2, guestCount: 2,
        }),
      },
    });
    return env;
  }

  // ═══ ALLOW ═══

  test('simple move', () => {
    const env = makeEnv();
    // Host moves h from c1r2 to c0r1 (up-left)
    const r = env.execute({ method: 'update', path: 'jumpgames/g1', auth: { uid: 'alice' }, data: {
      moveFrom: 'c1r2', moveTo: 'c0r1', captured: '',
      c1r2: '', c0r1: 'h',
      currentTurn: 'guest', moveCount: 1, status: 'playing',
      hostCount: 2, guestCount: 2,
    } });
    expect(r.allowed).toBe(true);
  });

  test('jump capture', () => {
    const env = makeEnv();
    // Host jumps from c2r3 over c1r2 (guest g) to c0r1
    const r = env.execute({ method: 'update', path: 'jumpgames/g2', auth: { uid: 'alice' }, data: {
      moveFrom: 'c2r3', moveTo: 'c0r1', captured: 'c1r2',
      c2r3: '', c0r1: 'h', c1r2: '',
      currentTurn: 'guest', moveCount: 1, status: 'playing',
      hostCount: 2, guestCount: 1,
    } });
    expect(r.allowed).toBe(true);
  });

  test('winning jump (guestCount goes to 0)', () => {
    const env = makeEnv();
    // Set up: only 1 guest piece left, host jumps it
    env.seed({
      rules: RULES,
      documents: {
        'gameConfig/jumpgame': CONFIG_DATA,
        'jumpgames/g3': gameDoc({
          c2r3: 'h', c0r3: 'h',
          c1r2: 'g',
          hostCount: 2, guestCount: 1,
        }),
      },
    });
    const r = env.execute({ method: 'update', path: 'jumpgames/g3', auth: { uid: 'alice' }, data: {
      moveFrom: 'c2r3', moveTo: 'c0r1', captured: 'c1r2',
      c2r3: '', c0r1: 'h', c1r2: '',
      currentTurn: 'guest', moveCount: 1, status: 'won',
      hostCount: 2, guestCount: 0,
    } });
    expect(r.allowed).toBe(true);
  });

  // ═══ DENY ═══

  test('invalid geometry denied', () => {
    const env = makeEnv();
    // Try to move h from c1r2 to c3r0 (not a valid simple move)
    const r = env.execute({ method: 'update', path: 'jumpgames/g1', auth: { uid: 'alice' }, data: {
      moveFrom: 'c1r2', moveTo: 'c3r0', captured: '',
      c1r2: '', c3r0: 'h',
      currentTurn: 'guest', moveCount: 1, status: 'playing',
      hostCount: 2, guestCount: 2,
    } });
    expect(r.allowed).toBe(false);
  });

  test('wrong player denied', () => {
    const env = makeEnv();
    // Bob (guest) tries to move on host's turn
    const r = env.execute({ method: 'update', path: 'jumpgames/g1', auth: { uid: 'bob' }, data: {
      moveFrom: 'c1r2', moveTo: 'c0r1', captured: '',
      c1r2: '', c0r1: 'h',
      currentTurn: 'host', moveCount: 1, status: 'playing',
      hostCount: 2, guestCount: 2,
    } });
    expect(r.allowed).toBe(false);
  });

  test('jump without capture denied', () => {
    const env = makeEnv();
    // Attempt jump geometry but claim captured is empty (contradicts jump rule)
    const r = env.execute({ method: 'update', path: 'jumpgames/g2', auth: { uid: 'alice' }, data: {
      moveFrom: 'c2r3', moveTo: 'c0r1', captured: '',
      c2r3: '', c0r1: 'h',
      currentTurn: 'guest', moveCount: 1, status: 'playing',
      hostCount: 2, guestCount: 2,
    } });
    expect(r.allowed).toBe(false);
  });

  test('capture own piece denied', () => {
    const env = makeEnv();
    // Set up board where the "captured" cell has own piece
    env.seed({
      rules: RULES,
      documents: {
        'gameConfig/jumpgame': CONFIG_DATA,
        'jumpgames/g4': gameDoc({
          c2r3: 'h', c1r2: 'h', // both host pieces
          c0r1: '', c3r0: 'g',
          hostCount: 2, guestCount: 1,
        }),
      },
    });
    const r = env.execute({ method: 'update', path: 'jumpgames/g4', auth: { uid: 'alice' }, data: {
      moveFrom: 'c2r3', moveTo: 'c0r1', captured: 'c1r2',
      c2r3: '', c0r1: 'h', c1r2: '',
      currentTurn: 'guest', moveCount: 1, status: 'playing',
      hostCount: 2, guestCount: 0,
    } });
    expect(r.allowed).toBe(false);
  });

  test('wrong count denied', () => {
    const env = makeEnv();
    // Jump capture but don't decrement guestCount
    const r = env.execute({ method: 'update', path: 'jumpgames/g2', auth: { uid: 'alice' }, data: {
      moveFrom: 'c2r3', moveTo: 'c0r1', captured: 'c1r2',
      c2r3: '', c0r1: 'h', c1r2: '',
      currentTurn: 'guest', moveCount: 1, status: 'playing',
      hostCount: 2, guestCount: 2, // should be 1
    } });
    expect(r.allowed).toBe(false);
  });

  test('unauthenticated denied', () => {
    const env = makeEnv();
    const r = env.execute({ method: 'update', path: 'jumpgames/g1', auth: null, data: {
      moveFrom: 'c1r2', moveTo: 'c0r1', captured: '',
      c1r2: '', c0r1: 'h',
      currentTurn: 'guest', moveCount: 1, status: 'playing',
      hostCount: 2, guestCount: 2,
    } });
    expect(r.allowed).toBe(false);
  });
});

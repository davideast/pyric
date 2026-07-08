/**
 * Scenario 15: Checkers with Jump Captures (4x4)
 *
 * Minimal 4x4 checkers board using geometry stdlib for move validation,
 * turns stdlib for turn enforcement, state stdlib for game state.
 * Config doc built programmatically for the 4x4 board.
 * Stdlib: geometry, turns, state, auth
 *
 * Migrated through `pyric/sandbox` — operations dispatch through
 * `getFirestore(sandbox)` instead of `LocalEnvironment.execute`.
 */
import { describe, test, expect } from 'bun:test';
import { resolveModules } from 'pyric/rules/node';
import { makeRoot, runOp } from './_helpers.js';

// ═══ Build 4x4 config document programmatically ═══

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

      function piecePlaced() {
        let mf = request.resource.data.moveFrom;
        let mt = request.resource.data.moveTo;
        let piece = resource.data[mf];
        return resource.data[mt] == ''
            && request.resource.data[mf] == ''
            && request.resource.data[mt] == piece;
      }

      function captureValid() {
        let cap = request.resource.data.captured;
        let turn = resource.data.currentTurn;
        return cap != ''
            && request.resource.data[cap] == ''
            && ((turn == 'host' && resource.data[cap] == 'g')
                || (turn == 'guest' && resource.data[cap] == 'h'));
      }

      function countsUnchanged() {
        return request.resource.data.hostCount == resource.data.hostCount
            && request.resource.data.guestCount == resource.data.guestCount;
      }

      function captureDecrement() {
        let turn = resource.data.currentTurn;
        return (turn == 'host'
              && request.resource.data.guestCount == resource.data.guestCount - 1
              && request.resource.data.hostCount == resource.data.hostCount)
            || (turn == 'guest'
              && request.resource.data.hostCount == resource.data.hostCount - 1
              && request.resource.data.guestCount == resource.data.guestCount);
      }

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

      allow update: if isAuthenticated()
          && request.resource.data.captured == ''
          && isPlaying() && isMyTurn() && turnFlipped() && moveIncremented()
          && participantsUnchanged() && request.resource.data.status == 'playing'
          && validSimpleMove(config()) && piecePlaced() && countsUnchanged() && moveIntegrity();

      allow update: if isAuthenticated()
          && request.resource.data.captured != ''
          && request.resource.data.status == 'playing'
          && isPlaying() && isMyTurn() && turnFlipped() && moveIncremented()
          && participantsUnchanged()
          && validJumpMove(config()) && piecePlaced() && captureValid() && captureDecrement() && moveIntegrity();

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

const BASE_SEED = {
  'gameConfig/jumpgame': CONFIG_DATA,
  'jumpgames/g1': gameDoc({
    c1r2: 'h', c3r2: 'h',
    c0r1: '', c2r1: '',
    c1r0: 'g', c3r0: 'g',
    hostCount: 2, guestCount: 2,
  }),
  'jumpgames/g2': gameDoc({
    c2r3: 'h', c0r3: 'h',
    c1r2: 'g', c3r0: 'g',
    hostCount: 2, guestCount: 2,
  }),
};

describe('Scenario 15: Checkers with Jump Captures', () => {
  // ═══ ALLOW ═══

  test('simple move', async () => {
    const root = makeRoot(RULES, BASE_SEED);
    const r = await runOp(root, { method: 'update', path: 'jumpgames/g1', auth: { uid: 'alice' }, data: {
      moveFrom: 'c1r2', moveTo: 'c0r1', captured: '',
      c1r2: '', c0r1: 'h',
      currentTurn: 'guest', moveCount: 1, status: 'playing',
      hostCount: 2, guestCount: 2,
    } });
    expect(r.allowed).toBe(true);
  });

  test('jump capture', async () => {
    const root = makeRoot(RULES, BASE_SEED);
    const r = await runOp(root, { method: 'update', path: 'jumpgames/g2', auth: { uid: 'alice' }, data: {
      moveFrom: 'c2r3', moveTo: 'c0r1', captured: 'c1r2',
      c2r3: '', c0r1: 'h', c1r2: '',
      currentTurn: 'guest', moveCount: 1, status: 'playing',
      hostCount: 2, guestCount: 1,
    } });
    expect(r.allowed).toBe(true);
  });

  test('winning jump (guestCount goes to 0)', async () => {
    const root = makeRoot(RULES, {
      'gameConfig/jumpgame': CONFIG_DATA,
      'jumpgames/g3': gameDoc({
        c2r3: 'h', c0r3: 'h',
        c1r2: 'g',
        hostCount: 2, guestCount: 1,
      }),
    });
    const r = await runOp(root, { method: 'update', path: 'jumpgames/g3', auth: { uid: 'alice' }, data: {
      moveFrom: 'c2r3', moveTo: 'c0r1', captured: 'c1r2',
      c2r3: '', c0r1: 'h', c1r2: '',
      currentTurn: 'guest', moveCount: 1, status: 'won',
      hostCount: 2, guestCount: 0,
    } });
    expect(r.allowed).toBe(true);
  });

  // ═══ DENY ═══

  test('invalid geometry denied', async () => {
    const root = makeRoot(RULES, BASE_SEED);
    const r = await runOp(root, { method: 'update', path: 'jumpgames/g1', auth: { uid: 'alice' }, data: {
      moveFrom: 'c1r2', moveTo: 'c3r0', captured: '',
      c1r2: '', c3r0: 'h',
      currentTurn: 'guest', moveCount: 1, status: 'playing',
      hostCount: 2, guestCount: 2,
    } });
    expect(r.allowed).toBe(false);
  });

  test('wrong player denied', async () => {
    const root = makeRoot(RULES, BASE_SEED);
    const r = await runOp(root, { method: 'update', path: 'jumpgames/g1', auth: { uid: 'bob' }, data: {
      moveFrom: 'c1r2', moveTo: 'c0r1', captured: '',
      c1r2: '', c0r1: 'h',
      currentTurn: 'host', moveCount: 1, status: 'playing',
      hostCount: 2, guestCount: 2,
    } });
    expect(r.allowed).toBe(false);
  });

  test('jump without capture denied', async () => {
    const root = makeRoot(RULES, BASE_SEED);
    const r = await runOp(root, { method: 'update', path: 'jumpgames/g2', auth: { uid: 'alice' }, data: {
      moveFrom: 'c2r3', moveTo: 'c0r1', captured: '',
      c2r3: '', c0r1: 'h',
      currentTurn: 'guest', moveCount: 1, status: 'playing',
      hostCount: 2, guestCount: 2,
    } });
    expect(r.allowed).toBe(false);
  });

  test('capture own piece denied', async () => {
    const root = makeRoot(RULES, {
      'gameConfig/jumpgame': CONFIG_DATA,
      'jumpgames/g4': gameDoc({
        c2r3: 'h', c1r2: 'h',
        c0r1: '', c3r0: 'g',
        hostCount: 2, guestCount: 1,
      }),
    });
    const r = await runOp(root, { method: 'update', path: 'jumpgames/g4', auth: { uid: 'alice' }, data: {
      moveFrom: 'c2r3', moveTo: 'c0r1', captured: 'c1r2',
      c2r3: '', c0r1: 'h', c1r2: '',
      currentTurn: 'guest', moveCount: 1, status: 'playing',
      hostCount: 2, guestCount: 0,
    } });
    expect(r.allowed).toBe(false);
  });

  test('wrong count denied', async () => {
    const root = makeRoot(RULES, BASE_SEED);
    const r = await runOp(root, { method: 'update', path: 'jumpgames/g2', auth: { uid: 'alice' }, data: {
      moveFrom: 'c2r3', moveTo: 'c0r1', captured: 'c1r2',
      c2r3: '', c0r1: 'h', c1r2: '',
      currentTurn: 'guest', moveCount: 1, status: 'playing',
      hostCount: 2, guestCount: 2,
    } });
    expect(r.allowed).toBe(false);
  });

  test('unauthenticated denied', async () => {
    const root = makeRoot(RULES, BASE_SEED);
    const r = await runOp(root, { method: 'update', path: 'jumpgames/g1', auth: null, data: {
      moveFrom: 'c1r2', moveTo: 'c0r1', captured: '',
      c1r2: '', c0r1: 'h',
      currentTurn: 'guest', moveCount: 1, status: 'playing',
      hostCount: 2, guestCount: 2,
    } });
    expect(r.allowed).toBe(false);
  });
});

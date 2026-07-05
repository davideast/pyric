/**
 * Checkers — thick Firestore security rules generator fixture.
 *
 * Board: 8×8 grid, 32 dark squares only (where (col+row) % 2 === 1)
 * Pieces: 'h' (host), 'H' (host king), 'g' (guest), 'G' (guest king), '' (empty)
 *
 * Host: rows 5-7 (bottom), moves up (decreasing row), kings at row 0
 * Guest: rows 0-2 (top), moves down (increasing row), kings at row 7
 * Host moves first.
 *
 * Document schema (flat, all top-level — enables MapDiff):
 *   host, guest, status, currentTurn, moveCount, moveFrom, moveTo, captured,
 *   c1r0, c3r0, ..., c6r7 (32 cell fields)
 *
 * Simplifications (v1):
 *   - One move or jump per write (no multi-jump chains)
 *   - No mandatory capture rule
 *   - Win = opponent has 0 pieces remaining
 */

const BOARD_SIZE = 8;

function cell(c: number, r: number): string {
  return `c${c}r${r}`;
}

export function darkSquares(): string[] {
  const squares: string[] = [];
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if ((c + r) % 2 === 1) squares.push(cell(c, r));
    }
  }
  return squares;
}

export function initialBoard(): Record<string, string> {
  const board: Record<string, string> = {};
  for (const sq of darkSquares()) {
    const row = parseInt(sq.slice(sq.indexOf('r') + 1));
    if (row <= 2) board[sq] = 'g';
    else if (row >= 5) board[sq] = 'h';
    else board[sq] = '';
  }
  return board;
}

interface SimpleMove { from: string; to: string }
interface JumpMove { from: string; to: string; over: string }

export function getSimpleMoves(dir: 'up' | 'down'): SimpleMove[] {
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

export function getJumpMoves(dir: 'up' | 'down'): JumpMove[] {
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

// --- Rules expression builders ---

function buildAdjFn(name: string, moves: SimpleMove[], turnVal: string, pieceCheck: string): string {
  const pairs = moves.map(m => `(mf == '${m.from}' && mt == '${m.to}')`);
  const indent = '            ';
  return `      function ${name}() {
        let mf = request.resource.data.moveFrom;
        let mt = request.resource.data.moveTo;
        return resource.data.currentTurn == '${turnVal}'
            && (${pieceCheck})
            && (${pairs.join(`\n${indent}|| `)});
      }`;
}

function buildJumpFn(name: string, jumps: JumpMove[], turnVal: string, pieceCheck: string): string {
  const triples = jumps.map(j => `(mf == '${j.from}' && mt == '${j.to}' && cap == '${j.over}')`);
  const indent = '            ';
  return `      function ${name}() {
        let mf = request.resource.data.moveFrom;
        let mt = request.resource.data.moveTo;
        let cap = request.resource.data.captured;
        return resource.data.currentTurn == '${turnVal}'
            && (${pieceCheck})
            && (${triples.join(`\n${indent}|| `)});
      }`;
}

export function buildCheckersRules(collection: string): string {
  const squares = darkSquares();
  const init = initialBoard();

  const upMoves = getSimpleMoves('up');
  const downMoves = getSimpleMoves('down');
  const upJumps = getJumpMoves('up');
  const downJumps = getJumpMoves('down');

  // Kinging row cells
  const hostKingRow = squares.filter(s => s.endsWith('r0'));
  const guestKingRow = squares.filter(s => s.endsWith('r7'));
  const hostKingCheck = hostKingRow.map(s => `mt == '${s}'`).join(' || ');
  const guestKingCheck = guestKingRow.map(s => `mt == '${s}'`).join(' || ');

  // Create: verify initial board
  const createBoardChecks = squares
    .map(sq => `            && request.resource.data.${sq} == '${init[sq]}'`)
    .join('\n');

  // Win detection: piece counter approach (1 expression instead of 64)

  // Geometry functions
  const hostFwd = buildAdjFn('hostFwd', upMoves, 'host',
    "resource.data[mf] == 'h' || resource.data[mf] == 'H'");
  const hostBack = buildAdjFn('hostBack', downMoves, 'host',
    "resource.data[mf] == 'H'");
  const guestFwd = buildAdjFn('guestFwd', downMoves, 'guest',
    "resource.data[mf] == 'g' || resource.data[mf] == 'G'");
  const guestBack = buildAdjFn('guestBack', upMoves, 'guest',
    "resource.data[mf] == 'G'");

  const hostJumpFwd = buildJumpFn('hostJumpFwd', upJumps, 'host',
    "resource.data[mf] == 'h' || resource.data[mf] == 'H'");
  const hostJumpBack = buildJumpFn('hostJumpBack', downJumps, 'host',
    "resource.data[mf] == 'H'");
  const guestJumpFwd = buildJumpFn('guestJumpFwd', downJumps, 'guest',
    "resource.data[mf] == 'g' || resource.data[mf] == 'G'");
  const guestJumpBack = buildJumpFn('guestJumpBack', upJumps, 'guest',
    "resource.data[mf] == 'G'");

  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /${collection}/{gameId} {

      // ═══ Authentication ═══
      function isAuth() {
        return request.auth != null;
      }
      function isHost() {
        return request.auth.uid == resource.data.host;
      }
      function isGuest() {
        return request.auth.uid == resource.data.guest;
      }

      // ═══ Turn & State ═══
      function isPlaying() {
        return resource.data.status == 'playing';
      }
      function isMyTurn() {
        return (resource.data.currentTurn == 'host' && isHost())
            || (resource.data.currentTurn == 'guest' && isGuest());
      }
      function turnFlipped() {
        return (resource.data.currentTurn == 'host' && request.resource.data.currentTurn == 'guest')
            || (resource.data.currentTurn == 'guest' && request.resource.data.currentTurn == 'host');
      }
      function moveIncremented() {
        return request.resource.data.moveCount == resource.data.moveCount + 1;
      }
      function participantsUnchanged() {
        return request.resource.data.host == resource.data.host
            && request.resource.data.guest == resource.data.guest;
      }

      // ═══ Piece Movement ═══
      function piecePlaced() {
        let mf = request.resource.data.moveFrom;
        let mt = request.resource.data.moveTo;
        let piece = resource.data[mf];
        let placed = request.resource.data[mt];
        return resource.data[mt] == ''
            && request.resource.data[mf] == ''
            && (
              (piece == 'h' && placed == 'h' && !(${hostKingCheck}))
              || (piece == 'h' && placed == 'H' && (${hostKingCheck}))
              || (piece == 'H' && placed == 'H')
              || (piece == 'g' && placed == 'g' && !(${guestKingCheck}))
              || (piece == 'g' && placed == 'G' && (${guestKingCheck}))
              || (piece == 'G' && placed == 'G')
            );
      }

      // ═══ Capture ═══
      function captureValid() {
        let cap = request.resource.data.captured;
        let turn = resource.data.currentTurn;
        return cap != ''
            && request.resource.data[cap] == ''
            && (
              (turn == 'host' && (resource.data[cap] == 'g' || resource.data[cap] == 'G'))
              || (turn == 'guest' && (resource.data[cap] == 'h' || resource.data[cap] == 'H'))
            );
      }

      // ═══ Board Integrity (MapDiff) ═══
      // Unified: works for both simple moves (captured='') and jumps (captured=cellName)
      function moveIntegrity() {
        return request.resource.data.diff(resource.data).affectedKeys().hasOnly([
          'moveFrom', 'moveTo', 'captured', 'currentTurn', 'moveCount', 'status', 'hostCount', 'guestCount',
          request.resource.data.moveFrom,
          request.resource.data.moveTo,
          request.resource.data.captured
        ]);
      }

      // ═══ Geometry: Simple Moves ═══
${hostFwd}

${hostBack}

${guestFwd}

${guestBack}

      // ═══ Geometry: Jumps ═══
${hostJumpFwd}

${hostJumpBack}

${guestJumpFwd}

${guestJumpBack}

      // ═══ Piece Counters ═══
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

      // ═══ Common Checks ═══
      function normalMoveChecks() {
        return isPlaying() && isMyTurn() && turnFlipped() && moveIncremented()
            && participantsUnchanged() && request.resource.data.status == 'playing';
      }
      function winMoveChecks() {
        return isPlaying() && isMyTurn() && turnFlipped() && moveIncremented()
            && participantsUnchanged() && request.resource.data.status == 'won';
      }

      // ═══ Lobby ═══
      allow read: if isAuth();

      allow create: if isAuth()
            && request.resource.data.host == request.auth.uid
            && request.resource.data.guest == ''
            && request.resource.data.status == 'waiting'
            && request.resource.data.currentTurn == 'host'
            && request.resource.data.moveCount == 0
            && request.resource.data.moveFrom == ''
            && request.resource.data.moveTo == ''
            && request.resource.data.captured == ''
            && request.resource.data.hostCount == 12
            && request.resource.data.guestCount == 12
${createBoardChecks};

      allow update: if isAuth()
            && resource.data.status == 'waiting'
            && resource.data.guest == ''
            && request.resource.data.guest == request.auth.uid
            && request.auth.uid != resource.data.host
            && request.resource.data.status == 'playing'
            && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['guest', 'status']);

      allow delete: if isAuth()
            && resource.data.status == 'waiting'
            && request.auth.uid == resource.data.host;

      // ═══ Simple Moves — gate on captured=='' for cheap rejection by jump writes ═══
      allow update: if request.resource.data.captured == ''
            && normalMoveChecks() && hostFwd() && piecePlaced() && countsUnchanged() && moveIntegrity();
      allow update: if request.resource.data.captured == ''
            && normalMoveChecks() && hostBack() && piecePlaced() && countsUnchanged() && moveIntegrity();
      allow update: if request.resource.data.captured == ''
            && normalMoveChecks() && guestFwd() && piecePlaced() && countsUnchanged() && moveIntegrity();
      allow update: if request.resource.data.captured == ''
            && normalMoveChecks() && guestBack() && piecePlaced() && countsUnchanged() && moveIntegrity();

      // ═══ Jumps — double gate: captured + status for cheap cross-rejection ═══
      allow update: if request.resource.data.captured != ''
            && request.resource.data.status == 'playing'
            && normalMoveChecks() && hostJumpFwd() && piecePlaced() && captureValid() && captureDecrement() && moveIntegrity();
      allow update: if request.resource.data.captured != ''
            && request.resource.data.status == 'playing'
            && normalMoveChecks() && hostJumpBack() && piecePlaced() && captureValid() && captureDecrement() && moveIntegrity();
      allow update: if request.resource.data.captured != ''
            && request.resource.data.status == 'playing'
            && normalMoveChecks() && guestJumpFwd() && piecePlaced() && captureValid() && captureDecrement() && moveIntegrity();
      allow update: if request.resource.data.captured != ''
            && request.resource.data.status == 'playing'
            && normalMoveChecks() && guestJumpBack() && piecePlaced() && captureValid() && captureDecrement() && moveIntegrity();

      // ═══ Winning Jumps — counter-based win (1 expr vs 64) ═══
      allow update: if request.resource.data.captured != ''
            && request.resource.data.status == 'won'
            && winMoveChecks() && hostJumpFwd() && piecePlaced()
            && captureValid() && captureDecrement() && moveIntegrity()
            && request.resource.data.guestCount == 0;
      allow update: if request.resource.data.captured != ''
            && request.resource.data.status == 'won'
            && winMoveChecks() && hostJumpBack() && piecePlaced()
            && captureValid() && captureDecrement() && moveIntegrity()
            && request.resource.data.guestCount == 0;
      allow update: if request.resource.data.captured != ''
            && request.resource.data.status == 'won'
            && winMoveChecks() && guestJumpFwd() && piecePlaced()
            && captureValid() && captureDecrement() && moveIntegrity()
            && request.resource.data.hostCount == 0;
      allow update: if request.resource.data.captured != ''
            && request.resource.data.status == 'won'
            && winMoveChecks() && guestJumpBack() && piecePlaced()
            && captureValid() && captureDecrement() && moveIntegrity()
            && request.resource.data.hostCount == 0;
    }
  }
}`;
}

// --- Generate ---
const rules = buildCheckersRules('checkers');
console.log(`Board: 8x8 (${darkSquares().length} dark squares)`);
console.log(`Simple moves per direction: up=${getSimpleMoves('up').length}, down=${getSimpleMoves('down').length}`);
console.log(`Jump moves per direction: up=${getJumpMoves('up').length}, down=${getJumpMoves('down').length}`);
console.log(`Rules size: ${rules.length} chars, ${rules.split('\n').length} lines`);
console.log(`Functions: 20 (auth:3, state:5, piece:1, integrity:1, geometry:8, win:2)`);
console.log(`Allow rules: 16 (read:1, create:1, join:1, delete:1, simple:4, jump:4, win:4)`);

await Bun.write(import.meta.dir + '/checkers.rules', rules);
console.log('\nWrote checkers.rules');

/**
 * Assembles a complete Firestore security rules file for a grid-based game.
 *
 * Optimization levels (applied automatically based on board size):
 * - Small boards (≤42 cells): nested board map, static enumeration, single win function
 * - Medium boards (43-121 cells): flat layout, dynamic access, MapDiff, directional win split
 *
 * Uses the stdlib convention: host/guest/currentTurn/status.
 */

import type { GridConfig } from './grid.js';
import { generateWinLines } from './grid.js';
import {
  winCheckExpr,
  splitWinLinesByDirection,
  gravityExpr,
  cellEmptyExpr,
  boardIntegrityExpr,
  placementExpr,
} from './expressions.js';

export interface GameConfig {
  collection: string;
  grid: GridConfig;
  winLineCount: number;       // N-in-a-row (3 for TTT, 4 for C4, 5 for Gomoku)
  hasGravity: boolean;
  hasLobby: boolean;
}

const SMALL_BOARD_THRESHOLD = 42;

/** A single Firestore path segment we are willing to interpolate into a
 *  `match /<collection>/{gameId}` block. Deliberately stricter than
 *  Firestore's own collection-id rules: alphanumerics, dash, underscore,
 *  1–64 chars. Anything else (slashes, braces, whitespace, newlines) could
 *  break out of the match block and inject arbitrary rules, so we reject it
 *  rather than escape it. */
const COLLECTION_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/** Validate a caller-supplied collection name before it is interpolated into
 *  generated rules source. Throws on anything that isn't a plain path
 *  segment — every caller of the public `pyric/rules` generator is safe by
 *  default, no escaping required at the call site. */
function assertSafeCollection(collection: string): void {
  if (typeof collection !== 'string' || !COLLECTION_SEGMENT.test(collection)) {
    throw new Error(
      `assembleGameRules: invalid collection ${JSON.stringify(collection)} — ` +
        `must match ${COLLECTION_SEGMENT} (a single Firestore path segment: ` +
        `letters, digits, "-" or "_", 1–64 chars). Rejected to prevent rules injection.`,
    );
  }
}

export function assembleGameRules(config: GameConfig): string {
  const { grid, winLineCount, hasGravity, hasLobby, collection } = config;
  assertSafeCollection(collection);
  const totalCells = grid.cols * grid.rows;
  const lines = generateWinLines(grid.cols, grid.rows, winLineCount);
  const useOptimized = totalCells > SMALL_BOARD_THRESHOLD;

  if (useOptimized) {
    return assembleOptimized(config, lines);
  }
  return assembleClassic(config, lines);
}

// ---- Classic: nested board map, static enumeration ----
function assembleClassic(config: GameConfig, lines: number[][]): string {
  const { grid, hasGravity, hasLobby, collection } = config;
  const totalCells = grid.cols * grid.rows;

  const placementChecks = [`(${placementExpr(grid)})`];
  if (hasGravity) {
    placementChecks.unshift(`(${gravityExpr(grid)})`);
  } else {
    placementChecks.unshift(`(${cellEmptyExpr(grid)})`);
  }
  const validMoveBody = placementChecks.join('\n          && ');
  const integrityBody = boardIntegrityExpr(grid);

  const commonMove = `request.auth != null
        && resource.data.status == 'playing'
        && (
          (resource.data.currentTurn == 'host' && request.auth.uid == resource.data.host)
          || (resource.data.currentTurn == 'guest' && request.auth.uid == resource.data.guest)
        )
        && (
          (resource.data.currentTurn == 'host' && request.resource.data.currentTurn == 'guest')
          || (resource.data.currentTurn == 'guest' && request.resource.data.currentTurn == 'host')
        )
        && request.resource.data.moveCount == resource.data.moveCount + 1
        && request.resource.data.host == resource.data.host
        && request.resource.data.guest == resource.data.guest`;

  const locChecks = `&& request.resource.data.lastCol >= 0 && request.resource.data.lastCol <= ${grid.cols - 1}
        && request.resource.data.lastRow >= 0 && request.resource.data.lastRow <= ${grid.rows - 1}`;

  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function hasWonHost(b) {
      return ${winCheckExpr('host', lines, grid)};
    }

    function hasWonGuest(b) {
      return ${winCheckExpr('guest', lines, grid)};
    }

    function validMove(nc, nr, mark, b, ob) {
      return ${validMoveBody};
    }

    function boardOk(nc, nr, b, ob) {
      return ${integrityBody};
    }

    match /${collection}/{gameId} {
      allow read: if request.auth != null;
${lobbyRules(hasLobby)}
      // --- Normal move (game continues) ---
      allow update: if ${commonMove}
        ${locChecks}
        && request.resource.data.status == 'playing'
        && request.resource.data.winner == ''
        && validMove(
            request.resource.data.lastCol,
            request.resource.data.lastRow,
            resource.data.currentTurn,
            request.resource.data.board,
            resource.data.board
          )${totalCells <= SMALL_BOARD_THRESHOLD ? `
        && boardOk(
            request.resource.data.lastCol,
            request.resource.data.lastRow,
            request.resource.data.board,
            resource.data.board
          )` : ''};

      // --- Winning move (host) ---
      allow update: if ${commonMove}
        ${locChecks}
        && request.resource.data.status == 'won'
        && request.resource.data.winner == 'host'
        && hasWonHost(request.resource.data.board);

      // --- Winning move (guest) ---
      allow update: if ${commonMove}
        ${locChecks}
        && request.resource.data.status == 'won'
        && request.resource.data.winner == 'guest'
        && hasWonGuest(request.resource.data.board);

      // --- Draw ---
      allow update: if ${commonMove}
        && request.resource.data.moveCount == ${totalCells}
        && request.resource.data.status == 'draw'
        && request.resource.data.winner == '';
    }
  }
}
`;
}

// ---- Optimized: flat layout, dynamic access, MapDiff, directional win split ----
function assembleOptimized(config: GameConfig, lines: number[][]): string {
  const { grid, hasGravity, hasLobby, collection } = config;
  const totalCells = grid.cols * grid.rows;
  const dirs = splitWinLinesByDirection(lines, grid.cols);

  function dirWinFn(name: string, mark: string, dirLines: number[][]): string {
    if (dirLines.length === 0) return `    function ${name}(b) { return false; }`;
    return `    function ${name}(b) {
      return ${winCheckExpr(mark, dirLines, grid)};
    }`;
  }

  const winFunctions = [
    dirWinFn('wonHH', 'host', dirs.horizontal),
    dirWinFn('wonHV', 'host', dirs.vertical),
    dirWinFn('wonHD1', 'host', dirs.diagUp),
    dirWinFn('wonHD2', 'host', dirs.diagDown),
    dirWinFn('wonGH', 'guest', dirs.horizontal),
    dirWinFn('wonGV', 'guest', dirs.vertical),
    dirWinFn('wonGD1', 'guest', dirs.diagUp),
    dirWinFn('wonGD2', 'guest', dirs.diagDown),
  ].join('\n\n');

  const commonMove = `request.auth != null
        && resource.data.status == 'playing'
        && (
          (resource.data.currentTurn == 'host' && request.auth.uid == resource.data.host)
          || (resource.data.currentTurn == 'guest' && request.auth.uid == resource.data.guest)
        )
        && (
          (resource.data.currentTurn == 'host' && request.resource.data.currentTurn == 'guest')
          || (resource.data.currentTurn == 'guest' && request.resource.data.currentTurn == 'host')
        )
        && request.resource.data.moveCount == resource.data.moveCount + 1
        && request.resource.data.host == resource.data.host
        && request.resource.data.guest == resource.data.guest`;

  // Dynamic cell validation + MapDiff integrity
  const dynamicPlacement = `&& resource.data[request.resource.data.lastMove] == ''
        && request.resource.data[request.resource.data.lastMove] == resource.data.currentTurn
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(
            ['lastMove', 'currentTurn', 'moveCount', request.resource.data.lastMove]
          )`;

  const dynamicWinPlacement = `&& resource.data[request.resource.data.lastMove] == ''
        && request.resource.data[request.resource.data.lastMove] == resource.data.currentTurn`;

  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

${winFunctions}

    match /${collection}/{gameId} {
      allow read: if request.auth != null;
${lobbyRulesOptimized(hasLobby)}
      // --- Normal move (flat layout + MapDiff integrity) ---
      allow update: if ${commonMove}
        ${dynamicPlacement}
        && request.resource.data.status == 'playing'
        && request.resource.data.winner == '';

      // --- Winning move (host) ---
      allow update: if ${commonMove}
        ${dynamicWinPlacement}
        && request.resource.data.status == 'won'
        && request.resource.data.winner == 'host'
        && (wonHH(request.resource.data) || wonHV(request.resource.data) || wonHD1(request.resource.data) || wonHD2(request.resource.data));

      // --- Winning move (guest) ---
      allow update: if ${commonMove}
        ${dynamicWinPlacement}
        && request.resource.data.status == 'won'
        && request.resource.data.winner == 'guest'
        && (wonGH(request.resource.data) || wonGV(request.resource.data) || wonGD1(request.resource.data) || wonGD2(request.resource.data));

      // --- Draw ---
      allow update: if ${commonMove}
        && request.resource.data.moveCount == ${totalCells}
        && request.resource.data.status == 'draw'
        && request.resource.data.winner == '';
    }
  }
}
`;
}

// ---- Lobby rules ----
function lobbyRules(hasLobby: boolean): string {
  if (!hasLobby) return `
      allow create: if request.auth != null
        && request.resource.data.host == request.auth.uid
        && request.resource.data.currentTurn == 'host'
        && request.resource.data.status == 'playing'
        && request.resource.data.winner == ''
        && request.resource.data.moveCount == 0;
`;
  return `
      allow create: if request.auth != null
        && request.resource.data.host == request.auth.uid
        && request.resource.data.guest == ''
        && request.resource.data.currentTurn == 'host'
        && request.resource.data.status == 'waiting'
        && request.resource.data.winner == ''
        && request.resource.data.moveCount == 0
        && request.resource.data.lastCol == -1
        && request.resource.data.lastRow == -1;

      allow update: if request.auth != null
        && resource.data.status == 'waiting'
        && request.resource.data.status == 'playing'
        && resource.data.guest == ''
        && request.resource.data.guest == request.auth.uid
        && request.auth.uid != resource.data.host
        && request.resource.data.host == resource.data.host
        && request.resource.data.currentTurn == resource.data.currentTurn
        && request.resource.data.winner == resource.data.winner
        && request.resource.data.moveCount == resource.data.moveCount
        && request.resource.data.lastCol == resource.data.lastCol
        && request.resource.data.lastRow == resource.data.lastRow
        && request.resource.data.board == resource.data.board;

      allow delete: if request.auth != null
        && resource.data.status == 'waiting'
        && request.auth.uid == resource.data.host;
`;
}

function lobbyRulesOptimized(hasLobby: boolean): string {
  if (!hasLobby) return `
      allow create: if request.auth != null
        && request.resource.data.host == request.auth.uid
        && request.resource.data.currentTurn == 'host'
        && request.resource.data.status == 'playing'
        && request.resource.data.winner == ''
        && request.resource.data.moveCount == 0;
`;
  return `
      allow create: if request.auth != null
        && request.resource.data.host == request.auth.uid
        && request.resource.data.guest == ''
        && request.resource.data.currentTurn == 'host'
        && request.resource.data.status == 'waiting'
        && request.resource.data.winner == ''
        && request.resource.data.moveCount == 0
        && request.resource.data.lastMove == '';

      allow update: if request.auth != null
        && resource.data.status == 'waiting'
        && request.resource.data.status == 'playing'
        && resource.data.guest == ''
        && request.resource.data.guest == request.auth.uid
        && request.auth.uid != resource.data.host
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['guest', 'status']);

      allow delete: if request.auth != null
        && resource.data.status == 'waiting'
        && request.auth.uid == resource.data.host;
`;
}

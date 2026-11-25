/**
 * Assembles a complete Firestore security rules file for a grid-based game.
 *
 * Optimization levels (applied automatically based on board size):
 * - Small boards (<= 42 cells): nested board map, static enumeration, coordinate-bisected win check
 * - Medium boards (43-121 cells): flat layout, dynamic access, MapDiff, cell-key-bisected win check
 *
 * Uses the stdlib convention: host/guest/currentTurn/status.
 */

import type { GridConfig } from './grid.js';
import {
  classicWinAtCellExpr,
  flatWinAtMoveExpr,
  gravityExpr,
  cellEmptyExpr,
  boardIntegrityExpr,
  placementExpr,
} from './expressions.js';
import { checkRulesSource } from '../grammar/source-compile-limits.js';

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
 *  1-64 chars. Anything else (slashes, braces, whitespace, newlines) could
 *  break out of the match block and inject arbitrary rules, so we reject it
 *  rather than escape it. */
const COLLECTION_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/** Validate a caller-supplied collection name before it is interpolated into
 *  generated rules source. Throws on anything that isn't a plain path
 *  segment -- every caller of the public `pyric/rules` generator is safe by
 *  default, no escaping required at the call site. */
function assertSafeCollection(collection: string): void {
  if (typeof collection !== 'string' || !COLLECTION_SEGMENT.test(collection)) {
    throw new Error(
      `assembleGameRules: invalid collection ${JSON.stringify(collection)} -- ` +
        `must match ${COLLECTION_SEGMENT} (a single Firestore path segment: ` +
        `letters, digits, "-" or "_", 1-64 chars). Rejected to prevent rules injection.`,
    );
  }
}

/** Generate the rules for `config`. Checks only win lines passing through the
 *  move cell (`lastCol`/`lastRow` on the classic nested board, `lastMove` on
 *  the flat layout) via binary search so legitimate wins stay well under
 *  production's 1,000-expression per-request budget. Throws, naming the limit,
 *  if the generated rules would not load in production. */
export function assembleGameRules(config: GameConfig): string {
  const { grid, winLineCount, collection } = config;
  assertSafeCollection(collection);
  const usesFlatLayout = grid.cols * grid.rows > SMALL_BOARD_THRESHOLD;
  let rules: string;
  if (usesFlatLayout) {
    rules = assembleOptimized(config);
  } else {
    rules = assembleClassic(config);
  }
  const checked = checkRulesSource(rules);
  if (checked.ok) return rules;
  const { cols, rows } = grid;
  throw new Error(
    `assembleGameRules: the rules generated for a ${cols}x${rows} board with ` +
      `${winLineCount} in a row would not load in production: ${checked.rejection.message}`,
  );
}

// ---- Classic: nested board map, static enumeration ----
function assembleClassic(config: GameConfig): string {
  const { grid, winLineCount, hasGravity, hasLobby, collection } = config;
  const totalCells = grid.cols * grid.rows;

  const placementChecks = [`(${placementExpr(grid)})`];
  if (hasGravity) {
    placementChecks.unshift(`(${gravityExpr(grid)})`);
  } else {
    placementChecks.unshift(`(${cellEmptyExpr(grid)})`);
  }
  const validMoveBody = placementChecks.join('\n          && ');
  const integrityBody = boardIntegrityExpr(grid);
  const winAtCellBody = classicWinAtCellExpr(grid, winLineCount);

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

  let boardOkClause = '';
  if (totalCells <= SMALL_BOARD_THRESHOLD) {
    boardOkClause = `
        && boardOk(
            request.resource.data.lastCol,
            request.resource.data.lastRow,
            request.resource.data.board,
            resource.data.board
          )`;
  }

  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function wonAtCell(b, mark, nc, nr) {
      return ${winAtCellBody};
    }

    function hasWonHost(b) {
      return wonAtCell(b, 'host', request.resource.data.lastCol, request.resource.data.lastRow);
    }

    function hasWonGuest(b) {
      return wonAtCell(b, 'guest', request.resource.data.lastCol, request.resource.data.lastRow);
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
      allow update: if request.resource.data.status == 'playing'
        && request.resource.data.winner == ''
        && ${commonMove}
        ${locChecks}
        && validMove(
            request.resource.data.lastCol,
            request.resource.data.lastRow,
            resource.data.currentTurn,
            request.resource.data.board,
            resource.data.board
          )${boardOkClause};

      // --- Winning move (host) ---
      allow update: if request.resource.data.status == 'won'
        && request.resource.data.winner == 'host'
        && ${commonMove}
        ${locChecks}
        && hasWonHost(request.resource.data.board);

      // --- Winning move (guest) ---
      allow update: if request.resource.data.status == 'won'
        && request.resource.data.winner == 'guest'
        && ${commonMove}
        ${locChecks}
        && hasWonGuest(request.resource.data.board);

      // --- Draw ---
      allow update: if request.resource.data.status == 'draw'
        && request.resource.data.winner == ''
        && request.resource.data.moveCount == ${totalCells}
        && ${commonMove};
    }
  }
}
`;
}

// ---- Optimized: flat layout, dynamic access, MapDiff, cell-key-bisected win check ----
function assembleOptimized(config: GameConfig): string {
  const { grid, winLineCount, hasLobby, collection } = config;
  const totalCells = grid.cols * grid.rows;
  const winAtMoveBody = flatWinAtMoveExpr(grid, winLineCount);

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

    function wonAtMove(d, mark, lm) {
      return ${winAtMoveBody};
    }

    function hasWonHost(d) {
      return wonAtMove(d, 'host', d.lastMove);
    }

    function hasWonGuest(d) {
      return wonAtMove(d, 'guest', d.lastMove);
    }

    match /${collection}/{gameId} {
      allow read: if request.auth != null;
${lobbyRulesOptimized(hasLobby)}
      // --- Normal move (flat layout + MapDiff integrity) ---
      allow update: if request.resource.data.status == 'playing'
        && request.resource.data.winner == ''
        && ${commonMove}
        ${dynamicPlacement};

      // --- Winning move (host) ---
      allow update: if request.resource.data.status == 'won'
        && request.resource.data.winner == 'host'
        && ${commonMove}
        ${dynamicWinPlacement}
        && hasWonHost(request.resource.data);

      // --- Winning move (guest) ---
      allow update: if request.resource.data.status == 'won'
        && request.resource.data.winner == 'guest'
        && ${commonMove}
        ${dynamicWinPlacement}
        && hasWonGuest(request.resource.data);

      // --- Draw ---
      allow update: if request.resource.data.status == 'draw'
        && request.resource.data.winner == ''
        && request.resource.data.moveCount == ${totalCells}
        && ${commonMove};
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

      allow update: if resource.data.status == 'waiting'
        && request.resource.data.status == 'playing'
        && request.auth != null
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

      allow update: if resource.data.status == 'waiting'
        && request.resource.data.status == 'playing'
        && request.auth != null
        && resource.data.guest == ''
        && request.resource.data.guest == request.auth.uid
        && request.auth.uid != resource.data.host
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['guest', 'status']);

      allow delete: if request.auth != null
        && resource.data.status == 'waiting'
        && request.auth.uid == resource.data.host;
`;
}

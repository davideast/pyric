import type { Expr } from './types.js';
import { all, any, not, expr } from './compose.js';
import { dataVal, newDataVal, newDataParentVal, newDataIs, eq, neq, AUTH_UID } from './data.js';

/**
 * Turn enforcement: only the current turn's player can write.
 * Uses data (pre-write) for the turn check — NOT newData.
 *
 * @param turnField - the field that stores whose turn it is (e.g., "currentTurn")
 * @param players - map of mark → player field (e.g., { X: "playerX", O: "playerO" })
 * @param statusField - optional field that must equal playingValue for moves to be allowed
 * @param playingValue - the value of statusField during active play (e.g., "playing")
 */
export function turnGuard(
  turnField: string,
  players: Record<string, string>,
  statusField?: string,
  playingValue?: string,
): Expr {
  const branches = Object.entries(players).map(([mark, playerField]) =>
    `${eq(dataVal(turnField), mark)} && ${eq(dataVal(playerField), AUTH_UID)}`,
  );
  const playerCheck = branches.join(' || ') as Expr;

  if (statusField && playingValue) {
    return all(eq(dataVal(statusField), playingValue), playerCheck);
  }
  return playerCheck;
}

/**
 * Turn flip: validates a turn field alternates between marks.
 * First mark is the initial value on creation.
 * Supports 2+ players with circular rotation.
 *
 * @param marks - ordered list of marks (e.g., ["X", "O"])
 */
export function flip(marks: string[]): Expr {
  const creation = all(not(expr('data.exists()')), eq(newDataVal(), marks[0]));
  const transitions = marks.map((mark, i) => {
    const next = marks[(i + 1) % marks.length];
    return all(eq(dataVal(), mark), eq(newDataVal(), next));
  });
  return any(creation, ...transitions);
}

/**
 * Win check helper: validates a boolean field against winning lines on a board.
 * If true, at least one winning line must exist. If false, no winning line can exist.
 * Uses the "client claims, rules verify" pattern.
 *
 * @param mark - the player mark to check (e.g., "X")
 * @param lines - array of winning line coordinates (e.g., [[0,1,2], [3,4,5], ...])
 * @param boardPath - the path to the board relative to the parent (default "board")
 */
export function winCheckHelper(
  mark: string,
  lines: number[][],
  boardPath: string = 'board',
): Expr {
  const lineCheck = (line: number[]) =>
    all(...line.map(n => eq(newDataParentVal(1, `${boardPath}/${n}`), mark)));
  const anyLine = any(...lines.map(lineCheck));

  return all(
    newDataIs('Boolean'),
    any(neq(newDataVal(), true), anyLine),
    any(neq(newDataVal(), false), not(anyLine)),
  );
}

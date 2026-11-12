/**
 * `results`: how a two-player match ends, and that other writes leave the
 * result alone.
 *
 * Convention (the `lobby` match): `status` is 'playing' while in play and
 * 'won', 'draw' or 'resigned' once finished; `winner` is 'host' or 'guest'
 * for 'won' and 'resigned', and '' while playing and for 'draw'.
 *
 * Placement: the match node's `.write`. `fields` is the match's leaf field
 * list for the changed-field check and defaults to `MATCH_FIELDS`.
 */
import type { Expr } from '../constraints/types.js';
import { all, any } from '../constraints/compose.js';
import { AUTH_UID, dataVal, eq, newDataVal } from '../constraints/data.js';
import { authenticated } from '../constraints/atoms.js';
import { onlyFieldsChanged, unchanged } from './lifecycle.js';
import { MATCH_FIELDS } from './lobby.js';

/**
 * A seated player resigns: status goes from 'playing' to 'resigned', the
 * other seat becomes the winner, and only status and winner change.
 */
export function resignedBy(fields: readonly string[] = MATCH_FIELDS): Expr {
  return all(
    authenticated(),
    any(
      all(eq(dataVal('host'), AUTH_UID), eq(newDataVal('winner'), 'guest')),
      all(eq(dataVal('guest'), AUTH_UID), eq(newDataVal('winner'), 'host')),
    ),
    eq(dataVal('status'), 'playing'),
    eq(newDataVal('status'), 'resigned'),
    onlyFieldsChanged(['status', 'winner'], [...fields]),
  );
}

export type Seat = 'host' | 'guest';

/**
 * The match in play finishes: status goes from 'playing' to `reason` and
 * `winner` becomes `winner`, which is a seat for 'won' and '' for 'draw'.
 * Only status and winner change. It does not check the writer; combine it
 * with `turns.isMyTurn()` or an ownership check.
 */
export function finishedWithWinner(
  winner: Seat | '',
  reason: 'won' | 'draw',
  fields: readonly string[] = MATCH_FIELDS,
): Expr {
  if (reason !== 'won' && reason !== 'draw') {
    throw new Error(`finishedWithWinner: reason must be 'won' or 'draw', got '${String(reason)}'; a resignation is resignedBy.`);
  }
  if (reason === 'won' && winner !== 'host' && winner !== 'guest') {
    throw new Error(`finishedWithWinner: a 'won' result names 'host' or 'guest' as winner, got '${String(winner)}'.`);
  }
  if (reason === 'draw' && winner !== '') {
    throw new Error(`finishedWithWinner: a 'draw' result has winner '', got '${String(winner)}'.`);
  }
  return all(
    eq(dataVal('status'), 'playing'),
    eq(newDataVal('status'), reason),
    eq(newDataVal('winner'), winner),
    onlyFieldsChanged(['status', 'winner'], [...fields]),
  );
}

/** status and winner keep their values. Combine with every write that is not a finish. */
export const resultUnchanged = (): Expr => unchanged('status', 'winner');

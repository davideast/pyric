/**
 * `turns`: the seat on turn and the next turn, for two named seats and for a
 * seat list.
 *
 * Two-seat convention (the `lobby` match): `host` and `guest` hold uids and
 * `currentTurn` is 'host' or 'guest'.
 *
 * Seat-list convention: `players` holds one uid per seat under the keys '0'
 * to 'n - 1' (an array written from a client is stored this way), and `turn`
 * is the number of the seat on turn. RTDB rules have no loops or list
 * indexing, so the seat count is a build-time argument and the builders
 * write one comparison per seat.
 *
 * Placement: the match node's `.write`. The turn checks read the stored match
 * (`data`), never the written one, so a player cannot hand themself the turn.
 */
import type { Expr } from '../constraints/types.js';
import { and, eq, lit, or, raw, sameAsBefore, val } from './expr.js';

/** The writer holds the seat named by the stored `currentTurn`. */
export function isMyTurn(): Expr {
  return and(
    raw('auth != null'),
    or(
      and(eq(val('data', 'currentTurn'), lit('host')), eq(val('data', 'host'), 'auth.uid')),
      and(eq(val('data', 'currentTurn'), lit('guest')), eq(val('data', 'guest'), 'auth.uid')),
    ),
  );
}

/** `currentTurn` passes to the other seat. */
export function turnFlipped(): Expr {
  return or(
    and(eq(val('data', 'currentTurn'), lit('host')), eq(val('newData', 'currentTurn'), lit('guest'))),
    and(eq(val('data', 'currentTurn'), lit('guest')), eq(val('newData', 'currentTurn'), lit('host'))),
  );
}

function seats(builder: string, seatCount: number): number[] {
  if (!Number.isInteger(seatCount) || seatCount < 1) {
    throw new Error(`${builder}: seatCount must be an integer of at least 1, got ${String(seatCount)}.`);
  }
  return Array.from({ length: seatCount }, (_, i) => i);
}

/** The writer's uid is in the seat whose number the stored `turn` holds, for `seatCount` seats. */
export function isSeatTurn(seatCount: number): Expr {
  return and(
    raw('auth != null'),
    or(...seats('isSeatTurn', seatCount).map((i) =>
      and(eq(val('data', 'turn'), lit(i)), eq(val('data', `players/${i}`), 'auth.uid')))),
  );
}

/**
 * The stored `turn` is a number, `turn` moves to the next seat, wrapping
 * from the last seat to seat 0, and every seat in `players` keeps its uid.
 */
export function turnAdvanced(seatCount: number): Expr {
  const all = seats('turnAdvanced', seatCount);
  return and(
    // Adding to a missing or non-number turn is an evaluation error that
    // fails the whole rule in production, so the stored turn is checked first.
    raw("data.child('turn').isNumber()"),
    raw(`${val('newData', 'turn')} == (${val('data', 'turn')} + 1) % ${seatCount}`),
    ...all.map((i) => sameAsBefore(`players/${i}`)),
  );
}

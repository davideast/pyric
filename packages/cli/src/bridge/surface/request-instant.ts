/**
 * The instant one simulated request evaluates at.
 *
 * Three engines ask the same question and used to answer it three times, each
 * in its own return type: Firestore wanted an ISO string, the Realtime Database
 * wanted epoch milliseconds, and Storage wanted a `Date`. The question is one
 * question, so it is answered once, in the type the clock itself speaks, and
 * each engine converts at its own call site.
 *
 * The guard belongs here rather than at the argument boundary. `checkRequestTime`
 * refuses an unparsable `requestTime` before a handler runs, but a helper that
 * returns `NaN` when that check is skipped, reordered, or reached from a caller
 * that has none is a silent wrong answer rather than a loud one. So an instant
 * that does not parse falls back to the clock, which is the same answer the call
 * would have got by naming no instant at all.
 */
import { getClock } from 'pyric/sandbox';
import type { SurfaceContext } from './types.js';

/**
 * The instant `request.time` (Firestore, Storage) or `now` (database) reads,
 * in epoch milliseconds: the caller's `requestTime` when it names a parsable
 * one, and the sandbox clock's own instant otherwise.
 */
export function requestInstant(ctx: SurfaceContext, requestTime: string | undefined): number {
  if (requestTime === undefined) return getClock(ctx.sandbox).now();
  const named = Date.parse(requestTime);
  if (Number.isNaN(named)) return getClock(ctx.sandbox).now();
  return named;
}

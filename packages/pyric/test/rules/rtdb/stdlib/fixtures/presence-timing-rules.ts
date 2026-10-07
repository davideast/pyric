/**
 * The presence, timing and collections patterns in one ruleset. The
 * production capture `rules-rtdb-r28-stdlib-presence-timing` deploys the JSON
 * this compiles to; `corpus-lock.test.ts` fails when the two differ.
 */
import { all, authenticated, ownPath, rtdbStdlib, type PathDef } from 'pyric/rules';

const { presence, timing, collections, lifecycle } = rtdbStdlib;

export const PRESENCE_TIMING_PATHS: Record<string, PathDef> = {
  '/status/$uid': presence.record(),
  '/online/$uid': presence.flag(),
  '/posts/$postId': {
    read: authenticated(),
    write: authenticated(),
    validate: timing.stampedInSameWrite(2, ['lastPost', { $: 'auth.uid' }]),
  },
  '/lastPost/$uid': {
    write: all(ownPath('$uid'), lifecycle.noDelete()),
    validate: timing.throttled(60_000),
  },
  '/events/$id': {
    write: authenticated(),
    children: {
      '/at': { validate: timing.notInFuture() },
      '/createdAt': { validate: timing.isServerTimestamp() },
    },
  },
  '/tables/$tableId': {
    write: authenticated(),
    children: {
      '/seats/$slot': { validate: collections.slotKey('$slot', 4) },
      '/flags/$flag': { validate: collections.keyIn('$flag', ['red', 'blue']) },
    },
  },
};

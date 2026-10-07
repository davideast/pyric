/**
 * The standard library's main patterns in one ruleset: the match from the
 * RTDB standard library guide, plus a seat-list table, an owned note, a
 * validated player, counters, and a two-sided score.
 *
 * The production capture `rules-rtdb-r27-stdlib-core-patterns` deploys the
 * JSON this compiles to; `corpus-lock.test.ts` fails when the two differ, so
 * a change to a builder's output needs a new capture.
 */
import { all, any, authenticated, newDataExists, not, pathOwnerOnly, rtdbStdlib, type PathDef } from 'pyric/rules';

const { lobby, turns, results, lifecycle, validation, counters } = rtdbStdlib;

/** The match from the guide, verbatim. */
export const MATCH_PATH_DEF: PathDef = {
  read: authenticated(),
  write: any(
    all(lobby.validCreate(), not(newDataExists('rematchOf'))),
    lobby.validRematch(),
    lobby.validJoin(),
    lobby.canCancel(),
    results.resignedBy(),
    all(turns.isMyTurn(), results.finishedWithWinner('host', 'won')),
    all(turns.isMyTurn(), results.finishedWithWinner('guest', 'won')),
    all(turns.isMyTurn(), results.finishedWithWinner('', 'draw')),
    all(
      turns.isMyTurn(),
      turns.turnFlipped(),
      lifecycle.onlyFieldsChanged(['currentTurn', 'moveCount'], lobby.MATCH_FIELDS),
    ),
  ),
  ...validation.shape(
    {
      host: 'string',
      guest: 'string',
      status: validation.oneOf('waiting', 'playing', 'won', 'draw', 'resigned'),
      currentTurn: validation.oneOf('host', 'guest'),
      winner: validation.oneOf('', 'host', 'guest'),
      moveCount: { validate: counters.incrementedBy(1, { start: 0 }) },
      rematchOf: 'string',
    },
    { required: ['host', 'guest', 'status'] },
  ),
};

export const CORE_PATTERN_PATHS: Record<string, PathDef> = {
  '/matches/$matchId': MATCH_PATH_DEF,
  '/tables/$tableId': {
    read: authenticated(),
    write: all(turns.isSeatTurn(3), turns.turnAdvanced(3)),
  },
  // turnAdvanced runs first, so a create with no stored turn reaches it.
  '/boards/$boardId': {
    write: any(all(turns.turnAdvanced(3), turns.isSeatTurn(3)), all(authenticated(), lifecycle.createOnly())),
  },
  '/notes/$noteId': {
    read: authenticated(),
    write: lifecycle.ownedBy('owner'),
    validate: lifecycle.immutableFields('createdAt'),
  },
  '/players/$uid': {
    read: authenticated(),
    write: pathOwnerOnly('$uid'),
    ...validation.shape(
      {
        name: validation.stringLength(1, 12),
        level: validation.numberBetween(1, 10),
        handle: validation.matches('^[a-z0-9_]+$'),
      },
      { required: ['name', 'level'] },
    ),
  },
  '/stats/$id': {
    write: authenticated(),
    children: {
      '/likes': { validate: counters.changedBy(-1, 1) },
      '/moves': { validate: counters.incrementedBy(1) },
      '/best': { validate: counters.improved('up') },
    },
  },
  '/scores/$id': {
    write: authenticated(),
    validate: counters.oneIncremented(['host', 'guest'], 1, { start: 0 }),
  },
};

/**
 * `lobby`: create, join, cancel and rematch a two-player match.
 *
 * Convention, shared with `turns` and `results` and with the Firestore
 * `lobby` module: a match is a node under a collection node, such as
 * `/matches/$matchId`, with these children:
 *   host: string, the creator's uid
 *   guest: string, '' while the seat is open, then the joiner's uid
 *   status: 'waiting' while open, 'playing' once joined, and
 *           'won' | 'draw' | 'resigned' once finished
 *   currentTurn: 'host' | 'guest'
 *   winner: 'host' | 'guest' | ''
 *   moveCount: number
 * `MATCH_FIELDS` lists them for the changed-field checks.
 *
 * Placement: the match node's `.write`. The builders read the stored match
 * (`data`) and the match after the write (`newData`), so a join written as an
 * update of `guest` and `status` and a create written as a set of the whole
 * match both reach them. A `.write` that grants on an ancestor, such as
 * `/matches` or the root, grants every write below it, so keep ancestors
 * without a granting `.write`.
 *
 * Typical rule:
 *   write: any(
 *     all(lobby.validCreate(), not(newDataExists('rematchOf'))),
 *     lobby.validRematch(),
 *     lobby.validJoin(),
 *     lobby.canCancel(),
 *   )
 */
import type { Expr } from '../constraints/types.js';
import { and, eq, exists, lit, negate, or, raw, val } from './expr.js';
import { onlyFieldsChanged } from './lifecycle.js';

/** The leaf fields of a match, in the convention above. */
export const MATCH_FIELDS: readonly string[] = Object.freeze(['host', 'guest', 'status', 'currentTurn', 'winner', 'moveCount']);

const signedIn = raw('auth != null');

/** The write creates the match with the writer as host, the guest seat open, and status 'waiting'. */
export function validCreate(): Expr {
  return and(
    signedIn,
    negate(exists('data')),
    eq(val('newData', 'host'), 'auth.uid'),
    eq(val('newData', 'guest'), lit('')),
    eq(val('newData', 'status'), lit('waiting')),
  );
}

/**
 * The writer takes the open seat of a waiting match hosted by someone else:
 * `guest` becomes the writer's uid, `status` becomes 'playing', and every
 * other field in `fields` keeps its value.
 */
export function validJoin(fields: readonly string[] = MATCH_FIELDS): Expr {
  return and(
    signedIn,
    eq(val('data', 'status'), lit('waiting')),
    eq(val('data', 'guest'), lit('')),
    eq(val('newData', 'guest'), 'auth.uid'),
    raw(`auth.uid != ${val('data', 'host')}`),
    eq(val('newData', 'status'), lit('playing')),
    onlyFieldsChanged(['guest', 'status'], [...fields]),
  );
}

/** The host deletes the match while it is still waiting for a guest. */
export function canCancel(): Expr {
  return and(
    signedIn,
    negate(exists('newData')),
    eq(val('data', 'status'), lit('waiting')),
    eq(val('data', 'host'), 'auth.uid'),
  );
}

/**
 * The write creates a match as {@link validCreate} does, and its `rematchOf`
 * child names a finished sibling match ('won', 'draw' or 'resigned') in which
 * the writer held either seat. Either player of the finished match can open
 * the rematch and becomes its host. The previous match is read through
 * `data.parent()`, so the rule works at any depth. A missing previous match
 * reads as null and is refused.
 */
export function validRematch(): Expr {
  const previous = `data.parent().child(${val('newData', 'rematchOf')})`;
  return and(
    validCreate(),
    raw("newData.child('rematchOf').isString()"),
    or(
      eq(`${previous}.child('status').val()`, lit('won')),
      eq(`${previous}.child('status').val()`, lit('draw')),
      eq(`${previous}.child('status').val()`, lit('resigned')),
    ),
    or(eq(`${previous}.child('host').val()`, 'auth.uid'), eq(`${previous}.child('guest').val()`, 'auth.uid')),
  );
}

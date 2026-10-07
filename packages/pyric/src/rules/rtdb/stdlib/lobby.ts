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
 *   rematchOf: string, the finished match a rematch follows; absent otherwise
 * `MATCH_FIELDS` lists them for the changed-field checks, so a join, move,
 * resignation or finish leaves every one it does not name unchanged.
 *
 * A create should write `currentTurn`, `winner` and `moveCount` along with
 * `host`, `guest` and `status`: `validJoin` keeps them unchanged, so a match
 * created without `currentTurn` never has a seat on turn and `turns.isMyTurn`
 * never allows a move.
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
import { all, any, expr, not } from '../constraints/compose.js';
import { AUTH_UID, dataVal, eq, newDataExists, newDataVal } from '../constraints/data.js';
import { authenticated, isNew } from '../constraints/atoms.js';
import { onlyFieldsChanged } from './lifecycle.js';

/** The leaf fields of a match, in the convention above. */
export const MATCH_FIELDS: readonly string[] = Object.freeze(['host', 'guest', 'status', 'currentTurn', 'winner', 'moveCount', 'rematchOf']);

const signedIn = authenticated();

/** The write creates the match with the writer as host, the guest seat open, and status 'waiting'. */
export function validCreate(): Expr {
  return all(
    signedIn,
    isNew(),
    eq(newDataVal('host'), AUTH_UID),
    eq(newDataVal('guest'), ''),
    eq(newDataVal('status'), 'waiting'),
  );
}

/**
 * The writer takes the open seat of a waiting match hosted by someone else:
 * `guest` becomes the writer's uid, `status` becomes 'playing', and every
 * other field in `fields` keeps its value.
 */
export function validJoin(fields: readonly string[] = MATCH_FIELDS): Expr {
  return all(
    signedIn,
    eq(dataVal('status'), 'waiting'),
    eq(dataVal('guest'), ''),
    eq(newDataVal('guest'), AUTH_UID),
    expr(`auth.uid != ${dataVal('host')}`),
    eq(newDataVal('status'), 'playing'),
    onlyFieldsChanged(['guest', 'status'], [...fields]),
  );
}

/** The host deletes the match while it is still waiting for a guest. */
export function canCancel(): Expr {
  return all(
    signedIn,
    not(newDataExists()),
    eq(dataVal('status'), 'waiting'),
    eq(dataVal('host'), AUTH_UID),
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
  const previous = `data.parent().child(${newDataVal('rematchOf')})`;
  return all(
    validCreate(),
    expr("newData.child('rematchOf').isString()"),
    any(
      eq(`${previous}.child('status').val()`, 'won'),
      eq(`${previous}.child('status').val()`, 'draw'),
      eq(`${previous}.child('status').val()`, 'resigned'),
    ),
    any(eq(`${previous}.child('host').val()`, AUTH_UID), eq(`${previous}.child('guest').val()`, AUTH_UID)),
  );
}

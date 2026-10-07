/**
 * `membership`: a member list stored in the database, such as
 * `/rooms/$roomId/members/$uid: true`, and the rules that read it.
 *
 * A member is a key in the list whose value is `true`: `false`, a string, or
 * a missing key is not a member. `memberOf` reads the stored data, so a
 * write that adds the writer to the list cannot use that same write to pass
 * a membership check.
 *
 * Placement: `memberOf` in any `.read` or `.write`; `selfMembership` in the
 * member node's `.write` and `memberFlag` in its `.validate`.
 */
import type { Expr, Segment } from '../constraints/types.js';
import { pathOwnerOnly } from '../constraints/policies.js';
import { and, childPath, climb, or, pathVariable, raw } from './expr.js';

/**
 * The signed-in user is a member: the stored value at `segments` is `true`.
 * The segments end with the member key, usually `{ $: 'auth.uid' }`. Without
 * `levelsUp`, they start at `root`; with it, `levelsUp` levels above the node
 * the rule is placed on.
 */
export function memberOf(segments: Segment[], options: { levelsUp?: number } = {}): Expr {
  const path = `${climb('memberOf', 'data', options.levelsUp)}${childPath('memberOf', segments)}`;
  return and(raw('auth != null'), raw(`${path}.val() == true`));
}

/**
 * The writer adds or removes only their own key: the member node's key is
 * the writer's uid, and the write sets `true` or deletes it.
 */
export function selfMembership(pathVar = '$uid'): Expr {
  return and(
    pathOwnerOnly(pathVariable('selfMembership', pathVar)),
    or(raw('newData.val() == true'), raw('!newData.exists()')),
  );
}

/** A member node holds `true`. Member node `.validate`. */
export const memberFlag = (): Expr => raw('newData.val() == true');

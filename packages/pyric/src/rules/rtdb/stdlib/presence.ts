/**
 * `presence`: who is online, written by each user for themself and cleared
 * by an onDisconnect write when the connection drops.
 *
 * Convention: one node per user, keyed by uid, under a presence collection
 * such as `/status/$uid`. `record()` stores `{ state: 'online' | 'offline',
 * lastChanged: <server timestamp> }`; `flag()` stores `true` or `false`.
 *
 * The client registers the offline write when it connects:
 *   onDisconnect(statusRef).set({ state: 'offline', lastChanged: serverTimestamp() });
 *   set(statusRef, { state: 'online', lastChanged: serverTimestamp() });
 * The server checks the rules for an onDisconnect write when the client
 * registers it and again when it runs, so the offline value must pass the
 * same rules as the online one. `onDisconnect(statusRef).remove()` is a
 * delete, which `.validate` does not check and `.write` allows for the
 * owner.
 *
 * In a match, read a player's presence from the match's rules through
 * `data.parent()`, for example
 * `data.parent().child('presence').child(data.child('guest').val()).child('state').val() == 'offline'`,
 * to let the other player claim a forfeit.
 */
import type { Expr, PathDef } from '../constraints/types.js';
import { and, raw } from './expr.js';
import { isServerTimestamp } from './timing.js';
import { oneOf, requiredFields } from './validation.js';

function pathVariable(builder: string, name: string): string {
  if (!/^\$[A-Za-z_][\w]*$/.test(name)) {
    throw new Error(`${builder}: '${name}' is not a path variable such as '$uid'.`);
  }
  return name;
}

/** The signed-in user writes the node keyed by their own uid. `.write` on `/status/$uid`. */
export function ownPresence(pathVar = '$uid'): Expr {
  return and(raw('auth != null'), raw(`auth.uid == ${pathVariable('ownPresence', pathVar)}`));
}

/**
 * The presence node for `/status/$uid`: the owner writes it, and the value
 * is `{ state: 'online' | 'offline', lastChanged }` with `lastChanged` the
 * server timestamp and no other child. Use it as that path's definition.
 */
export function record(pathVar = '$uid'): PathDef {
  return {
    read: raw('auth != null'),
    write: ownPresence(pathVar),
    validate: requiredFields('state', 'lastChanged'),
    children: {
      '/state': { validate: oneOf('online', 'offline') },
      '/lastChanged': { validate: isServerTimestamp() },
      '/$other': { validate: raw('false') },
    },
  };
}

/** The presence node for `/online/$uid` as a boolean: the owner writes `true` or `false`. */
export function flag(pathVar = '$uid'): PathDef {
  return {
    read: raw('auth != null'),
    write: ownPresence(pathVar),
    validate: raw('newData.isBoolean()'),
  };
}

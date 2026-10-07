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
 * Production checks the rules for an onDisconnect write when the client
 * registers it and again when it runs (the `rtdb-modular-ondisconnect-rules`
 * observation), so the offline value must pass the same rules as the online
 * one. Production's verdict for a server timestamp inside an onDisconnect
 * value is not captured; the sandbox resolves it when the write runs.
 * `onDisconnect(statusRef).remove()` is a delete, which `.validate` does not
 * check and `.write` allows for the owner.
 *
 * In a match, read a player's presence from the match's rules through
 * `data.parent()`, for example
 * `data.parent().child('presence').child(data.child('guest').val()).child('state').val() == 'offline'`,
 * to let the other player claim a forfeit.
 */
import type { PathDef } from '../constraints/types.js';
import { pathOwnerOnly } from '../constraints/policies.js';
import { pathVariable, raw } from './expr.js';
import { isServerTimestamp } from './timing.js';
import { oneOf, requiredFields } from './validation.js';

/**
 * The presence node for `/status/$uid`: the owner writes it
 * (`pathOwnerOnly`), and the value is `{ state: 'online' | 'offline',
 * lastChanged }` with `lastChanged` the server timestamp and no other child.
 * Use it as that path's definition.
 */
export function record(pathVar = '$uid'): PathDef {
  return {
    read: raw('auth != null'),
    write: pathOwnerOnly(pathVariable('record', pathVar)),
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
    write: pathOwnerOnly(pathVariable('flag', pathVar)),
    validate: raw('newData.isBoolean()'),
  };
}

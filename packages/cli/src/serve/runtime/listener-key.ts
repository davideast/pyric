/**
 * The one id the page uses for a listener or read.
 *
 * It is the SDK activity id for a call the page made, on every transport, or
 * the sandbox listener id for a listener only the sandbox reported.
 * Deliveries, delivered regions, observed renders, visibility, and paint all
 * name a listener by this key. The sandbox's own listener id and the transport
 * id never stand in for it; the outline model joins a sandbox listener to the
 * page's record of the call in one place.
 *
 * This module imports nothing, so the served SDK client can name listeners by
 * the same type without pulling in the runtime chip.
 */
declare const listenerKeyBrand: unique symbol;

export type ListenerKey = string & { readonly [listenerKeyBrand]: true };

/** Name a listener by an id the page already holds for it. */
export function listenerKey(id: string): ListenerKey {
  return id as ListenerKey;
}

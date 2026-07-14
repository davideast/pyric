/**
 * Sandbox routing for `pyric/ai`: every {@link AI} handle carries its broker
 * and sandbox behind {@link TARGET_SYMBOL}. Production selection belongs to
 * package resolution and never enters this module.
 */

import type { Sandbox } from '../sandbox/types/service.js';
import type { AI, AITarget } from './types.js';

export const TARGET_SYMBOL: unique symbol = Symbol('pyric/ai/target');

/**
 * Recover the dispatch target for an {@link AI} handle. Throws if the handle
 * wasn't produced by this package — the brand is the only way in.
 */
export function targetOf(ai: AI): AITarget {
  const target = (ai as { [TARGET_SYMBOL]?: AITarget })[TARGET_SYMBOL];
  if (!target) {
    throw new TypeError('pyric/ai: unrecognized AI handle — was it produced by getAI(...)?');
  }
  return target;
}

/**
 * Brand-based discriminator for `getAI`: a {@link Sandbox} carries
 * `onCurrentUserChanged` and `withAuth`, which a Firebase-shaped app container
 * never has.
 */
export function isSandbox(target: unknown): target is Sandbox {
  return (
    typeof target === 'object'
    && target !== null
    && typeof (target as Sandbox).onCurrentUserChanged === 'function'
    && typeof (target as Sandbox).withAuth === 'function'
  );
}

/**
 * Sign-in results a served test staged with `sandbox.mockSignInResult`
 * (`auth.mockSignInResult`), kept per port (#1466).
 *
 * Each port has one slot per provider id: the last result staged wins, and a
 * sign-in uses it up. That is in-page's rule (`AuthFlowRegistry.setMockResult`
 * and `consumeMockResult`). Keying by port means one tab, or one register
 * process, can't stage a sign-in for another, as in-page where each tab has
 * its own Auth. The slots live in a `WeakMap`, so they go away with the port,
 * and they are never persisted.
 */

import type { PortLike } from '../host-context.js';
import type { ResolvedIdentity } from '../protocol.js';

export interface StagedSignInResults {
  /** Stage `identity` for the port's next sign-in with `identity.providerId`. */
  stage(port: PortLike, identity: ResolvedIdentity): void;
  /** Use up the port's staged result for `providerId`, or `null` when none. */
  take(port: PortLike, providerId: string): ResolvedIdentity | null;
}

export function createStagedSignInResults(): StagedSignInResults {
  const slotsByPort = new WeakMap<PortLike, Map<string, ResolvedIdentity>>();

  function slotsFor(port: PortLike): Map<string, ResolvedIdentity> {
    let slots = slotsByPort.get(port);
    if (slots === undefined) {
      slots = new Map();
      slotsByPort.set(port, slots);
    }
    return slots;
  }

  return {
    stage(port, identity) {
      slotsFor(port).set(identity.providerId, identity);
    },
    take(port, providerId) {
      const slots = slotsByPort.get(port);
      const staged = slots?.get(providerId);
      if (staged === undefined) return null;
      slots?.delete(providerId);
      return staged;
    },
  };
}

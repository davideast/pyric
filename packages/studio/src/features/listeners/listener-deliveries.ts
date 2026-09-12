/**
 * Which events are deliveries (feature: Listeners).
 *
 * PURE. The two services report a delivery differently — Firestore emits its
 * own `snapshot_delivery`, the Realtime Database a `listener` event in the
 * `delivery` phase — and every surface that counts, buckets, or folds
 * deliveries needs the same answer, so the test lives here once.
 */

import type { SandboxEvent } from 'pyric/sandbox';

/** Every delivery event kind the sandbox emits, across both services. */
export function isDeliveryEvent(event: SandboxEvent): boolean {
  if (event.kind === 'snapshot_delivery') return true;
  return event.kind === 'listener' && (event as { phase?: string }).phase === 'delivery';
}

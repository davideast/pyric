/**
 * Which events are deliveries (feature: Listeners).
 *
 * PURE. Sandbox Firestore emits `snapshot_delivery`, sandbox Realtime Database
 * emits a `listener` event in the `delivery` phase, and live-mode client SDK
 * listeners emit a successful `operation` event carrying the host-scoped
 * `detail.listenerId` (`isLiveListenerDeliveryEvent` / `liveListenerIdOf`).
 * Every surface that counts, buckets, or folds deliveries reads the same
 * predicate and id projection here.
 */

import type { SandboxEvent } from 'pyric/sandbox';
import { isLiveListenerDeliveryEvent, liveListenerIdOf } from 'pyric/sandbox/internal';

/** The listener id a delivery event belongs to, across sandbox and live events. */
export function deliveryListenerId(event: SandboxEvent): string | undefined {
  if (event.kind === 'snapshot_delivery') return event.listenerId;
  if (event.kind === 'listener' && event.phase === 'delivery') {
    return event.listenerId;
  }
  return liveListenerIdOf(event);
}

/** Every delivery event kind the sandbox or live observer emits, across both services. */
export function isDeliveryEvent(event: SandboxEvent): boolean {
  if (event.kind === 'snapshot_delivery') return true;
  if (event.kind === 'listener' && event.phase === 'delivery') return true;
  return isLiveListenerDeliveryEvent(event);
}

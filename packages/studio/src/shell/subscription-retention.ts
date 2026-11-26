/**
 * Pre-cap stateful retention for Studio's subscription concurrency gauges (#284).
 *
 * `useStudioEvents` truncates its retained event array at `STUDIO_EVENT_CAP = 500`.
 * Replaying only that capped suffix would lose attach events that arrived more
 * than 500 operations ago and undercount active or peak gauges.
 *
 * This module folds every incoming `SandboxEvent` (and any explicit connection
 * lifecycle event on the stream) into a `SubscriptionGaugeSnapshot` BEFORE the
 * 500-event cap:
 * - Unrelated request, write, commit, delivery, and service-mutation events are
 *   ignored in O(1) without evicting lifecycle transitions.
 * - Lifecycle transitions themselves are bounded at
 *   `DEFAULT_SUBSCRIPTION_TRANSITION_CAP` by advancing an exact rolling
 *   baseline (`baselineListeners` / `baselineConnections`) as older transitions
 *   age out, preserving exact concurrency gauges across arbitrary session length.
 */

import {
  DEFAULT_SUBSCRIPTION_TRANSITION_CAP,
  EMPTY_SUBSCRIPTION_GAUGE_SNAPSHOT,
  foldSubscriptionGauge,
  retainSubscriptionGauge,
  type SubscriptionBaselineInit,
  type SubscriptionGaugeSnapshot,
  type SubscriptionLifecycleInput,
} from '@pyric/ui/traffic';
import type { SandboxEvent } from 'pyric/sandbox';

export const EMPTY_STUDIO_SUBSCRIPTION_SNAPSHOT: SubscriptionGaugeSnapshot =
  EMPTY_SUBSCRIPTION_GAUGE_SNAPSHOT;

export function retainStudioSubscriptions(
  events: readonly (SandboxEvent | SubscriptionLifecycleInput)[],
  options: {
    readonly maxTransitions?: number;
    readonly baseline?: SubscriptionBaselineInit;
  } = {},
): SubscriptionGaugeSnapshot {
  return retainSubscriptionGauge(events, options);
}

export function foldStudioSubscriptionSnapshot(
  prev: SubscriptionGaugeSnapshot,
  event: SandboxEvent | SubscriptionLifecycleInput,
  maxTransitions: number = DEFAULT_SUBSCRIPTION_TRANSITION_CAP,
): SubscriptionGaugeSnapshot {
  return foldSubscriptionGauge(prev, event, maxTransitions);
}

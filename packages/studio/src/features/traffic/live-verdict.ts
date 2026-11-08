/**
 * Live-mode advisory Rules aggregation over observed `StudioTrafficEvent`s.
 *
 * Separates per-request local rules decisions (`allow`, `deny`, `unevaluated`)
 * and production drift counts from sandbox `verdict.ts`.
 *
 * Service symmetry & listener deduplication:
 * - Observed Firestore `onSnapshot` listeners (and client transactions) carry no
 *   `production.local` verdict because single-path host evaluation lacks full
 *   query-proof and uncaptured stored-document state (`observe-local-verdict.ts`).
 * - Realtime Database `.read` rules evaluate at the watched node path, so each
 *   `onValue` / `onChild*` delivery carries `production.local`. Deduplicating by
 *   `(listenerId, local.result, Boolean(local.drift))` counts steady-state pushes
 *   once per subscription while preserving any later transition to `deny` or
 *   `drift` when local rules or auth change mid-subscription.
 */
import type { TimeWindow } from '@pyric/ui/traffic';
import type { ObservedProduction } from 'pyric/sandbox';
import { observedDetailListenerId, productionVerdict } from 'pyric/sandbox/internal';
import {
  localDrift,
  verdictFor,
  type StudioTrafficEvent,
} from './verdict.js';

type WindowedTrafficEvent = {
  readonly id?: string;
  readonly at: number;
  readonly detail?: unknown;
  readonly production?: ObservedProduction;
};

/**
 * For events tied to a live listener subscription (`detail.listenerId`),
 * selects the earliest event for each distinct `(result, drift)` state so
 * steady-state push deliveries do not inflate counts while mid-subscription
 * transitions to `deny` or `drift` still register.
 */
function distinctListenerEvaluations<T extends WindowedTrafficEvent>(
  events: readonly T[],
): ReadonlySet<T> {
  const earliestByVerdict = new Map<string, T>();
  for (const event of events) {
    const local = event.production?.local;
    if (local === undefined) continue;
    const listenerId = observedDetailListenerId(event.detail);
    if (listenerId === undefined) continue;
    const drifted = localDrift(event) !== undefined;
    const key = `${listenerId}:${local.result}:${drifted}`;
    const existing = earliestByVerdict.get(key);
    if (existing === undefined || event.at < existing.at) {
      earliestByVerdict.set(key, event);
    }
  }
  return new Set(earliestByVerdict.values());
}

function isCountedEvaluation<T extends WindowedTrafficEvent>(
  event: T,
  countedListeners: ReadonlySet<T>,
): boolean {
  const listenerId = observedDetailListenerId(event.detail);
  if (listenerId === undefined) return true;
  return countedListeners.has(event);
}

function countInWindow<T extends { readonly at: number }>(
  events: readonly T[],
  window: TimeWindow,
  predicate: (event: T) => boolean,
): number {
  let count = 0;
  for (const event of events) {
    if (event.at >= window.start && event.at < window.end && predicate(event)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Live-mode advisory Rules evaluations: observed requests whose local rules
 * produced a decided `allow` or `deny` verdict (plus any sandbox-evaluated
 * events in a mixed stream), projected onto `result` for `useRulesMetrics`.
 */
export function liveRulesDecisionEvents(
  events: readonly StudioTrafficEvent[],
): StudioTrafficEvent[] {
  const countedListeners = distinctListenerEvaluations(events);
  const decided: StudioTrafficEvent[] = [];
  for (const event of events) {
    if (event.production !== undefined) {
      if (!isCountedEvaluation(event, countedListeners)) continue;
      const local = event.production.local;
      if (local !== undefined && (local.result === 'allow' || local.result === 'deny')) {
        decided.push({ ...event, origin: 'user', result: local.result });
      }
      continue;
    }
    const verdict = verdictFor(event);
    if (verdict === 'allow' || verdict === 'deny') {
      decided.push(event);
    }
  }
  return decided;
}

export function localDriftCount(
  events: readonly WindowedTrafficEvent[],
  window: TimeWindow,
): number {
  const countedListeners = distinctListenerEvaluations(events);
  return countInWindow(
    events,
    window,
    (event) => isCountedEvaluation(event, countedListeners) && localDrift(event) !== undefined,
  );
}

export function localUnevaluatedCount(
  events: readonly WindowedTrafficEvent[],
  window: TimeWindow,
): number {
  const countedListeners = distinctListenerEvaluations(events);
  return countInWindow(
    events,
    window,
    (event) =>
      isCountedEvaluation(event, countedListeners) &&
      event.production?.local?.result === 'unevaluated',
  );
}

export function productionDeniedCount(
  events: readonly { readonly at: number; readonly production?: ObservedProduction }[],
  window: TimeWindow,
): number {
  return countInWindow(
    events,
    window,
    (event) =>
      event.production !== undefined && productionVerdict(event.production.outcome) === 'denied',
  );
}

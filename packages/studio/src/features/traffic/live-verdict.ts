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
 *   `onValue` / `onChild*` delivery carries `production.local`. Filtering to
 *   `[window.start, window.end)` FIRST and then deduplicating by
 *   {@link observedListenerVerdictKey} counts steady-state pushes once per
 *   subscription within the active window while preserving brushed-interval
 *   evaluations and mid-subscription verdict transitions.
 */
import type { TimeWindow } from '@pyric/ui/traffic';
import type { ObservedProduction, RulesDisposition } from 'pyric/sandbox';
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

function eventsInWindow<T extends { readonly at: number }>(
  events: readonly T[],
  window: TimeWindow,
): T[] {
  return events.filter((event) => event.at >= window.start && event.at < window.end);
}

/**
 * Canonical deduplication key (`listenerId:result:drifted`) for an observed
 * listener delivery carrying a local advisory Rules verdict. Shared with
 * `shell/traffic-retention.ts` so retention and aggregation agree on verdict
 * transitions.
 */
export function observedListenerVerdictKey(event: {
  readonly detail?: unknown;
  readonly production?: ObservedProduction;
}): string | undefined {
  const local = event.production?.local;
  if (local === undefined) return undefined;
  const listenerId = observedDetailListenerId(event.detail);
  if (listenerId === undefined) return undefined;
  const drifted = localDrift(event) !== undefined;
  return `${listenerId}:${local.result}:${drifted}`;
}

function isEarlierObservation<T extends { readonly at: number }>(
  at: number,
  existing: T | undefined,
): boolean {
  if (existing === undefined) return true;
  return at < existing.at;
}

/**
 * For events tied to a live listener subscription (`detail.listenerId`) inside
 * the active window, selects the earliest event for each distinct `(result, drift)`
 * state so steady-state push deliveries do not inflate counts while brushed
 * intervals and mid-subscription transitions to `deny` or `drift` still register.
 */
function distinctListenerEvaluations<T extends WindowedTrafficEvent>(
  events: readonly T[],
): ReadonlySet<T> {
  const earliestByVerdict = new Map<string, T>();
  for (const event of events) {
    const key = observedListenerVerdictKey(event);
    if (key === undefined) continue;
    const existing = earliestByVerdict.get(key);
    if (isEarlierObservation(event.at, existing)) {
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

function countWindowedEvents<T extends { readonly at: number }>(
  events: readonly T[],
  window: TimeWindow,
  predicate: (event: T) => boolean,
): number {
  const scoped = eventsInWindow(events, window);
  let count = 0;
  for (const event of scoped) {
    if (predicate(event)) {
      count += 1;
    }
  }
  return count;
}

function countDistinctWindowedEvaluations(
  events: readonly WindowedTrafficEvent[],
  window: TimeWindow,
  predicate: (event: WindowedTrafficEvent) => boolean,
): number {
  const scoped = eventsInWindow(events, window);
  const countedListeners = distinctListenerEvaluations(scoped);
  let count = 0;
  for (const event of scoped) {
    if (!isCountedEvaluation(event, countedListeners)) continue;
    if (predicate(event)) {
      count += 1;
    }
  }
  return count;
}

function isDecidedLocalVerdict(
  local: ObservedProduction['local'],
): local is { readonly result: 'allow' | 'deny' } {
  if (local === undefined) return false;
  return local.result === 'allow' || local.result === 'deny';
}

function isProductionDenial(event: { readonly production?: ObservedProduction }): boolean {
  if (event.production === undefined) return false;
  return productionVerdict(event.production.outcome) === 'denied';
}

/**
 * Live-mode advisory Rules evaluations: observed requests inside `window`
 * whose local rules produced a decided `allow` or `deny` verdict (plus any
 * sandbox-evaluated events in a mixed stream), projected onto `result` for
 * `useRulesMetrics`.
 */
export function liveRulesDecisionEvents(
  events: readonly StudioTrafficEvent[],
  window: TimeWindow,
): StudioTrafficEvent[] {
  const scoped = eventsInWindow(events, window);
  const countedListeners = distinctListenerEvaluations(scoped);
  const decided: StudioTrafficEvent[] = [];
  for (const event of scoped) {
    if (event.production !== undefined) {
      if (!isCountedEvaluation(event, countedListeners)) continue;
      const local = event.production.local;
      if (isDecidedLocalVerdict(local)) {
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
  return countDistinctWindowedEvaluations(
    events,
    window,
    (event) => localDrift(event) !== undefined,
  );
}

export function localUnevaluatedCount(
  events: readonly WindowedTrafficEvent[],
  window: TimeWindow,
): number {
  return countDistinctWindowedEvaluations(
    events,
    window,
    (event) => event.production?.local?.result === 'unevaluated',
  );
}

export function liveBypassedCount(
  events: readonly { readonly at: number; readonly rulesDisposition: RulesDisposition }[],
  window: TimeWindow,
): number {
  return countWindowedEvents(
    events,
    window,
    (event) => event.rulesDisposition.kind === 'bypassed',
  );
}

export function productionDeniedCount(
  events: readonly { readonly at: number; readonly production?: ObservedProduction }[],
  window: TimeWindow,
): number {
  return countWindowedEvents(events, window, isProductionDenial);
}

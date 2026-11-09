/**
 * Bounded multi-lane retention for Studio's Traffic stream (L6).
 *
 * Raw `events.slice(-STUDIO_EVENT_CAP)` over `SandboxEvent[]` mixes non-traffic
 * notifications, background Admin SDK polling (`rulesDisposition.kind === 'bypassed'`),
 * recurring listener callback deliveries (`detail.listenerId`), and client
 * requests in one 500-event ring buffer — causing `Rules` and `Billable metrics`
 * counts to tick backwards when background traffic evicts earlier client rows.
 *
 * Traffic retention filters to operation events first, persists seen
 * `(listenerId, result, drifted)` subscription verdict keys across incremental
 * folds until a `reset` `session_boundary`, and bounds four independent lanes at
 * `cap` each while preserving chronological arrival order:
 *   1. `client`: non-bypassed one-shot client requests.
 *   2. `listenerVerdicts`: the initial operation for each distinct local verdict
 *      on a live listener subscription.
 *   3. `deliveries`: subsequent recurring listener callback deliveries.
 *   4. `bypassed`: Admin SDK and other Rules-bypassed operations.
 */

import {
  isOperationEvent,
  rulesDispositionFor,
  type SandboxEvent,
} from 'pyric/sandbox';
import { observedDetailListenerId } from 'pyric/sandbox/internal';
import { isSessionResetBoundary } from '../events/fold.js';
import { observedListenerVerdictKey } from '../features/traffic/live-verdict.js';

interface SequencedEvent {
  readonly seq: number;
  readonly event: SandboxEvent;
}

interface TrafficLaneState {
  readonly client: readonly SequencedEvent[];
  readonly listenerVerdicts: readonly SequencedEvent[];
  readonly deliveries: readonly SequencedEvent[];
  readonly bypassed: readonly SequencedEvent[];
  readonly nextSeq: number;
}

export interface TrafficFeedSnapshot {
  readonly events: readonly SandboxEvent[];
  readonly capped: boolean;
  readonly clientCapped: boolean;
  /** Focused windows starting strictly before this timestamp lack evicted traffic. */
  readonly uncoveredBeforeAt: number | null;
  /** Focused Rules windows starting strictly before this timestamp lack evicted client or delivery rows. */
  readonly rulesUncoveredBeforeAt: number | null;
  readonly seenListenerVerdicts: ReadonlySet<string>;
  readonly lanes: TrafficLaneState;
}

const EMPTY_LANES: TrafficLaneState = {
  client: [],
  listenerVerdicts: [],
  deliveries: [],
  bypassed: [],
  nextSeq: 0,
};

export const EMPTY_TRAFFIC_FEED_SNAPSHOT: TrafficFeedSnapshot = {
  events: [],
  capped: false,
  clientCapped: false,
  uncoveredBeforeAt: null,
  rulesUncoveredBeforeAt: null,
  seenListenerVerdicts: new Set<string>(),
  lanes: EMPTY_LANES,
};

type OperationLane = 'client' | 'listenerVerdicts' | 'deliveries' | 'bypassed';

function isHistoryLimitGap(event: SandboxEvent): boolean {
  return event.kind === 'observation_gap' && event.reason === 'history-limit';
}

function isUnseenListenerVerdict(
  verdictKey: string | undefined,
  seen: ReadonlySet<string>,
): verdictKey is string {
  if (verdictKey === undefined) return false;
  return !seen.has(verdictKey);
}

function canReuseInputEvents(
  capped: boolean,
  retainedCount: number,
  inputCount: number,
): boolean {
  if (capped) return false;
  return retainedCount === inputCount;
}

function isClientRulesLane(lane: OperationLane): boolean {
  return lane === 'client' || lane === 'listenerVerdicts';
}

function isFocusedRulesLane(lane: OperationLane): boolean {
  return lane !== 'bypassed';
}

function maxUncoveredHorizon(
  previous: number | null,
  candidate: number | null,
): number | null {
  if (candidate === null) return previous;
  if (previous === null) return candidate;
  return Math.max(previous, candidate);
}

function classifyOperationLane(
  event: Parameters<typeof rulesDispositionFor>[0],
  seenListenerVerdicts: ReadonlySet<string>,
): { lane: OperationLane; addedVerdictKey?: string } {
  if (rulesDispositionFor(event).kind === 'bypassed') {
    return { lane: 'bypassed' };
  }
  const detail = 'detail' in event ? event.detail : undefined;
  const listenerId = observedDetailListenerId(detail);
  if (listenerId === undefined) {
    return { lane: 'client' };
  }
  let verdictKey: string | undefined;
  if (event.kind === 'operation') {
    verdictKey = observedListenerVerdictKey({ detail, production: event.production });
  }
  if (isUnseenListenerVerdict(verdictKey, seenListenerVerdicts)) {
    return { lane: 'listenerVerdicts', addedVerdictKey: verdictKey };
  }
  return { lane: 'deliveries' };
}

function appendBounded(
  lane: readonly SequencedEvent[],
  entry: SequencedEvent,
  cap: number,
): {
  items: readonly SequencedEvent[];
  evicted: boolean;
  uncoveredBeforeAt: number | null;
} {
  if (lane.length < cap) {
    return { items: [...lane, entry], evicted: false, uncoveredBeforeAt: null };
  }
  const evictedEntry = lane[0]!;
  const items = [...lane.slice(-(cap - 1)), entry];
  const oldestRetainedAt = items[0]!.event.at;
  const uncoveredBeforeAt = Math.max(oldestRetainedAt, evictedEntry.event.at + 1);
  return { items, evicted: true, uncoveredBeforeAt };
}

function mergeOrderedLanes(lanes: TrafficLaneState): SandboxEvent[] {
  const combined: SequencedEvent[] = [
    ...lanes.client,
    ...lanes.listenerVerdicts,
    ...lanes.deliveries,
    ...lanes.bypassed,
  ];
  combined.sort((left, right) => left.seq - right.seq);
  return combined.map((entry) => entry.event);
}

/**
 * Filter `events` to Traffic operations and bound each lane to the newest `cap`
 * entries in arrival order.
 */
export function retainTrafficEvents(
  events: readonly SandboxEvent[],
  cap: number,
): TrafficFeedSnapshot {
  let state = EMPTY_TRAFFIC_FEED_SNAPSHOT;
  for (const event of events) {
    state = foldTrafficFeedSnapshot(state, event, cap);
  }
  if (canReuseInputEvents(state.capped, state.events.length, events.length)) {
    return { ...state, events };
  }
  return state;
}

/**
 * Fold one live `SandboxEvent` into a bounded {@link TrafficFeedSnapshot}.
 * Seen listener verdict keys and rolling-cap horizons persist across folds until
 * a `session_boundary` (`phase: 'reset'`) clears the session, so retained
 * listener deliveries are never reclassified into the client lane.
 */
export function foldTrafficFeedSnapshot(
  prev: TrafficFeedSnapshot,
  event: SandboxEvent,
  cap: number,
): TrafficFeedSnapshot {
  if (isSessionResetBoundary(event)) {
    return EMPTY_TRAFFIC_FEED_SNAPSHOT;
  }
  if (isHistoryLimitGap(event)) {
    const gapHorizon = event.at + 1;
    return {
      ...prev,
      capped: true,
      clientCapped: true,
      uncoveredBeforeAt: maxUncoveredHorizon(prev.uncoveredBeforeAt, gapHorizon),
      rulesUncoveredBeforeAt: maxUncoveredHorizon(prev.rulesUncoveredBeforeAt, gapHorizon),
    };
  }
  if (!isOperationEvent(event)) {
    return prev;
  }

  const { lane, addedVerdictKey } = classifyOperationLane(event, prev.seenListenerVerdicts);
  let seenListenerVerdicts = prev.seenListenerVerdicts;
  if (addedVerdictKey !== undefined) {
    const nextSeen = new Set(prev.seenListenerVerdicts);
    nextSeen.add(addedVerdictKey);
    seenListenerVerdicts = nextSeen;
  }

  const entry: SequencedEvent = { seq: prev.lanes.nextSeq, event };
  const appended = appendBounded(prev.lanes[lane], entry, cap);
  const lanes: TrafficLaneState = {
    ...prev.lanes,
    [lane]: appended.items,
    nextSeq: prev.lanes.nextSeq + 1,
  };
  const clientEvicted = isClientRulesLane(lane) && appended.evicted;
  let rulesHorizonCandidate: number | null = null;
  if (isFocusedRulesLane(lane)) {
    rulesHorizonCandidate = appended.uncoveredBeforeAt;
  }

  return {
    events: mergeOrderedLanes(lanes),
    capped: prev.capped || appended.evicted,
    clientCapped: prev.clientCapped || clientEvicted,
    uncoveredBeforeAt: maxUncoveredHorizon(prev.uncoveredBeforeAt, appended.uncoveredBeforeAt),
    rulesUncoveredBeforeAt: maxUncoveredHorizon(prev.rulesUncoveredBeforeAt, rulesHorizonCandidate),
    seenListenerVerdicts,
    lanes,
  };
}

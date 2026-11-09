/**
 * The Studio event stream, and everything derived from it.
 *
 * One source of events, dev-seed first: the seeded sandbox's own reactive array
 * in review, the live SharedWorker feed under `pyric dev --ui`, and the empty
 * feed when neither is present. Every activity surface (Session, Traffic) and
 * every rules inspector reads through the hooks here rather than reaching for a
 * feed of its own, so they all see the same events under the same cap.
 */

import { useEffect, useMemo, useState } from 'react';
import type {
  EventProvenance,
  RequestEvent,
  SandboxEvent,
  SandboxListenerEvent,
  SandboxOperationEvent,
} from 'pyric/sandbox';
import { activeListeners, isOperationEvent, toOperationRecord } from 'pyric/sandbox';
import { messagingRequestsLine, storageGsPath } from 'pyric/sandbox/internal';
import type { StudioTrafficEvent } from '../features/traffic/verdict.js';
import { foldSessionEventLog } from '../events/fold.js';
import {
  EMPTY_TRAFFIC_FEED_SNAPSHOT,
  foldTrafficFeedSnapshot,
  retainTrafficEvents,
  type TrafficFeedSnapshot,
} from './traffic-retention.js';
import { useDevSeed } from '../dev/DevSeedProvider.js';
import { useEnvironment } from './environment.js';
import {
  emptyEventFeed,
  feedFromSandboxLike,
  type EventFeed,
} from '../features/action-center/feed.js';
import {
  selectDenials,
  selectRuleEvaluations,
  type Denial,
} from '../features/rules-debug/model.js';

/**
 * An {@link EventFeed} for the Action Center, dev-seed first. The seeded sandbox
 * satisfies the feed shape directly (`history()` + `onEvent`); otherwise the
 * live SharedWorker feed (`env.live.feed`) when `pyric dev --ui` is reachable,
 * and the empty feed as the final fallback (SSR / no worker / tests).
 */
export function useStudioEventFeed(): EventFeed {
  const seed = useDevSeed();
  const env = useEnvironment();
  const liveFeed = env.status === 'ready' ? env.env.live?.feed : undefined;
  return useMemo<EventFeed>(() => {
    if (seed.status === 'ready') return feedFromSandboxLike(seed.handles.sandbox);
    return liveFeed ?? emptyEventFeed();
  }, [seed, liveFeed]);
}

/**
 * Per-lane / per-surface retention cap (L6): a long-running session must not
 * grow render/memory cost without bound. `useStudioEvents` retains the newest
 * `STUDIO_EVENT_CAP` events; `useStudioTrafficFeed` bounds each Traffic lane
 * (`client`, `listenerVerdicts`, `deliveries`, `bypassed`) at `STUDIO_EVENT_CAP`
 * and surfaces explicit rolling-cap state when hit.
 */
export const STUDIO_EVENT_CAP = 500;

/** Newest-retained cap. Returns the SAME reference when under the cap, so
 *  memo consumers don't churn on every render. */
type EventRetention = 'recent' | 'active-listeners';

function capNewest(events: readonly SandboxEvent[], retention: EventRetention): readonly SandboxEvent[] {
  if (events.length <= STUDIO_EVENT_CAP) return events;
  const recent = events.slice(-STUDIO_EVENT_CAP);
  if (retention === 'recent') return recent;
  // A live registration is state, not disposable traffic history. Keep its
  // original attach until a detach/error closes it; deliveries remain capped.
  const active = new Set(activeListeners(events).map(listener => listener.id));
  const registrations = events.slice(0, -STUDIO_EVENT_CAP).filter(event =>
    (event.kind === 'listener_attach' || (event.kind === 'listener' && event.phase === 'attach')) &&
    active.has(event.listenerId),
  );
  return [...registrations, ...recent];
}

function useAccumulatedFeed<State>(
  emptyState: State,
  fromHistory: (events: readonly SandboxEvent[]) => State,
  foldEvent: (prev: State, event: SandboxEvent) => State,
): State {
  const seed = useDevSeed();
  const env = useEnvironment();
  const liveFeed = env.status === 'ready' ? env.env.live?.feed : undefined;
  const seedReady = seed.status === 'ready';

  const [liveState, setLiveState] = useState<State>(emptyState);
  useEffect(() => {
    if (seedReady) {
      setLiveState(emptyState);
      return;
    }
    if (!liveFeed) {
      setLiveState(emptyState);
      return;
    }
    setLiveState(fromHistory(liveFeed.history()));
    const unsub = liveFeed.subscribe((event) =>
      setLiveState((prev) => foldEvent(prev, event)),
    );
    return unsub;
  }, [seedReady, liveFeed, emptyState, fromHistory, foldEvent]);

  const seedState = useMemo<State>(() => {
    if (!seedReady) return emptyState;
    return fromHistory(seed.events);
  }, [seedReady, seed, emptyState, fromHistory]);

  return seedReady ? seedState : liveState;
}

const EMPTY_EVENTS: readonly SandboxEvent[] = [];

/**
 * The unified `SandboxEvent` array every activity surface (Session, Listeners)
 * reads, dev-seed first.
 */
export function useStudioEvents(retention: EventRetention = 'recent'): readonly SandboxEvent[] {
  const fromHistory = useMemo(
    () => (events: readonly SandboxEvent[]) => capNewest(events, retention),
    [retention],
  );
  const foldEvent = useMemo(
    () => (prev: readonly SandboxEvent[], event: SandboxEvent) =>
      capNewest(foldSessionEventLog(prev, event), retention),
    [retention],
  );
  return useAccumulatedFeed(EMPTY_EVENTS, fromHistory, foldEvent);
}

function isTrafficEvent(
  e: SandboxEvent,
): e is (RequestEvent | SandboxOperationEvent | SandboxListenerEvent) & EventProvenance {
  const isValidOperation = isOperationEvent(e);
  return isValidOperation;
}

function isPermissionDeniedErrorCode(code: unknown): boolean {
  if (typeof code !== 'string') return false;
  const normalized = code.toLowerCase();
  return (
    normalized === 'permission_denied' ||
    normalized === 'permission-denied' ||
    normalized === 'auth/permission-denied'
  );
}

type StudioTrafficEventWithDetail = StudioTrafficEvent & {
  detail?: Readonly<Record<string, unknown>>;
};

function toTrafficEvent(
  e: (RequestEvent | SandboxOperationEvent | SandboxListenerEvent) & EventProvenance,
): StudioTrafficEvent {
  const record = toOperationRecord(e);
  if (!record) {
    throw new Error('Studio traffic adapter received a non-operation event');
  }
  if (e.kind === 'request') {
    return {
      ...e,
      operationContext: record.context,
      rulesDisposition: record.rules,
      queryProof: record.queryProof,
    } as StudioTrafficEvent;
  }
  if (e.kind === 'listener') {
    let resultVal: 'allow' | 'deny' | 'unsupported' | 'error' | 'not-applicable' = 'error';
    if (e.result !== undefined) {
      resultVal = e.result;
    } else {
      const errorObj = e.error as Record<string, unknown> | undefined;
      const hasPermissionDeniedCode = errorObj !== undefined && isPermissionDeniedErrorCode(errorObj.code);
      if (hasPermissionDeniedCode) {
        resultVal = 'deny';
      }
    }
    let pathVal = '(service)';
    if (e.target.path !== undefined) {
      pathVal = e.target.path;
    }
    let reasonsVal: string[] = [];
    if (e.reasons !== undefined) {
      reasonsVal = e.reasons;
    } else {
      const errorObj = e.error as { reasons?: string[] } | undefined;
      if (errorObj !== undefined && errorObj.reasons !== undefined) {
        reasonsVal = errorObj.reasons;
      }
    }
    return {
      kind: 'operation',
      service: e.service,
      id: e.id,
      at: e.at,
      method: 'listen',
      path: pathVal,
      auth: e.auth,
      result: resultVal,
      reasons: reasonsVal,
      origin: 'listener',
      triggeredBy: e.triggeredBy,
      operationContext: record.context,
      rulesDisposition: record.rules,
      queryProof: record.queryProof,
      ...callerOf(e),
    };
  }
  let pathVal = '(service)';
  if (e.path !== undefined) {
    pathVal = e.path;
  }
  const gsPath = storageGsPath(e, e.path);
  if (gsPath !== undefined) {
    pathVal = gsPath;
  }
  const requestsLine = messagingRequestsLine(e);
  if (requestsLine !== undefined) {
    pathVal = requestsLine;
  }
  let reasonsVal: string[] = [];
  if (e.reasons !== undefined) {
    reasonsVal = e.reasons;
  }
  const adapted: StudioTrafficEventWithDetail = {
    kind: 'operation',
    service: e.service,
    id: e.id,
    at: e.at,
    durationMs: e.durationMs,
    method: e.method,
    path: pathVal,
    auth: e.auth,
    result: e.result,
    reasons: reasonsVal,
    request: e.request,
    resourceBefore: e.resourceBefore,
    resourceAfter: e.resourceAfter,
    origin: e.origin,
    groupId: e.groupId,
    groupKind: e.groupKind,
    triggeredBy: e.triggeredBy,
    operationContext: record.context,
    rulesDisposition: record.rules,
    queryProof: record.queryProof,
  };
  if (e.caller !== undefined) adapted.caller = e.caller;
  if (e.instance !== undefined) adapted.instance = e.instance;
  if (e.production !== undefined) adapted.production = e.production;
  if (e.detail !== undefined) adapted.detail = e.detail;
  return adapted;
}

/** The caller field to carry onto an adapted event, when the host stamped one. */
function callerOf(e: EventProvenance): Pick<StudioTrafficEvent, 'caller'> {
  return e.caller === undefined ? {} : { caller: e.caller };
}

export interface StudioTrafficFeed {
  readonly events: StudioTrafficEvent[];
  readonly capped: boolean;
  readonly clientCapped: boolean;
  readonly uncoveredBeforeAt: number | null;
  readonly rulesUncoveredBeforeAt: number | null;
}

function retainDefaultTrafficEvents(events: readonly SandboxEvent[]): TrafficFeedSnapshot {
  return retainTrafficEvents(events, STUDIO_EVENT_CAP);
}

function foldDefaultTrafficSnapshot(
  prev: TrafficFeedSnapshot,
  event: SandboxEvent,
): TrafficFeedSnapshot {
  return foldTrafficFeedSnapshot(prev, event, STUDIO_EVENT_CAP);
}

function useRetainedTrafficSnapshot(): TrafficFeedSnapshot {
  return useAccumulatedFeed(
    EMPTY_TRAFFIC_FEED_SNAPSHOT,
    retainDefaultTrafficEvents,
    foldDefaultTrafficSnapshot,
  );
}

/**
 * The bounded Traffic feed with per-lane retention (`client`, `listenerVerdicts`,
 * `deliveries`, `bypassed`) and explicit rolling-cap state.
 */
export function useStudioTrafficFeed(): StudioTrafficFeed {
  const snapshot = useRetainedTrafficSnapshot();
  return useMemo<StudioTrafficFeed>(
    () => ({
      events: studioTrafficEvents(snapshot.events),
      capped: snapshot.capped,
      clientCapped: snapshot.clientCapped,
      uncoveredBeforeAt: snapshot.uncoveredBeforeAt,
      rulesUncoveredBeforeAt: snapshot.rulesUncoveredBeforeAt,
    }),
    [snapshot],
  );
}

/**
 * The traffic feed. Firestore still emits legacy `request` events; RTDB and
 * other services can emit canonical `operation` events. Adapt both into the
 * headless `@pyric/ui/traffic` shape.
 */
export function useStudioTraffic(): StudioTrafficEvent[] {
  return useStudioTrafficFeed().events;
}

/** The traffic rows {@link useStudioTraffic} reads, from any event array. */
export function studioTrafficEvents(events: readonly SandboxEvent[]): StudioTrafficEvent[] {
  return events.filter(isTrafficEvent).map(toTrafficEvent);
}

/** The denied ops (rules-failure debugging), derived from the live stream. */
export function useStudioDenials(): Denial[] {
  const snapshot = useRetainedTrafficSnapshot();
  return useMemo<Denial[]>(() => selectDenials(snapshot.events), [snapshot.events]);
}

/** ALL rules-evaluated ops (allow AND deny/unsupported), derived from the live
 *  stream: the Traffic rules inspector's feed (`selectRuleEvaluations`). */
export function useStudioRuleEvaluations(): Denial[] {
  const snapshot = useRetainedTrafficSnapshot();
  return useMemo<Denial[]>(() => selectRuleEvaluations(snapshot.events), [snapshot.events]);
}

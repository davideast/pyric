import { EventHistory, OBSERVATION_HISTORY_LIMITS } from 'pyric/sandbox/internal';
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
import { trafficOperationEvent, toOperationRecord } from 'pyric/sandbox';
import type { StudioTrafficEvent } from '../features/traffic/verdict.js';
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
  return useMemo<EventFeed>(
    () =>
      seed.status === 'ready'
        ? feedFromSandboxLike(seed.handles.sandbox)
        : liveFeed ?? emptyEventFeed(),
    [seed, liveFeed],
  );
}

/**
 * Hard cap on the events any Studio surface accumulates (L6): a long-running
 * session must not grow render/memory cost without bound. Newest-retained;
 * `TrafficSurface` surfaces an explicit "showing latest N" line when hit.
 */
export const STUDIO_EVENT_CAP = OBSERVATION_HISTORY_LIMITS.maxEvents;

/** Newest-retained cap. Returns the SAME reference when under the cap, so
 *  memo consumers don't churn on every render. */
type EventRetention = 'recent' | 'active-listeners';

function capNewest(events: readonly SandboxEvent[], _retention: EventRetention): readonly SandboxEvent[] {
  const history = new EventHistory(OBSERVATION_HISTORY_LIMITS);
  for (const event of events) history.append(event);
  return history.snapshot();
}

/**
 * The unified `SandboxEvent` array every activity surface (Session, Traffic)
 * reads, dev-seed first. The seed's `events` array is already reactive; in
 * served mode it accumulates the live worker feed (the backlog seeds it, then
 * each live event appends). Empty when neither source is present.
 *
 * The feed delivers its history batch to the FIRST subscriber (see
 * `workerEventFeed`), so a fresh subscription receives the backlog even though
 * `history()` reads empty at subscribe time: hence we seed from `history()` AND
 * accumulate via `subscribe`, which folds each event exactly once.
 */
export function useStudioEvents(retention: EventRetention = 'recent'): readonly SandboxEvent[] {
  const seed = useDevSeed();
  const env = useEnvironment();
  const liveFeed = env.status === 'ready' ? env.env.live?.feed : undefined;
  const seedReady = seed.status === 'ready';

  const [liveEvents, setLiveEvents] = useState<readonly SandboxEvent[]>([]);
  useEffect(() => {
    if (seedReady || !liveFeed) {
      setLiveEvents([]);
      return;
    }
    // Cap BOTH accumulation paths (the history seed and the live appends).
    // Live appends fold through the session rule: a reset boundary drops the
    // wiped session's events (see `events/fold.ts`) so Traffic/Session read
    // (near-)empty after Settings then Reset, which is issue #359's extension.
    const history = new EventHistory(OBSERVATION_HISTORY_LIMITS);
    for (const event of liveFeed.history()) history.append(event);
    setLiveEvents(history.snapshot());
    const unsub = liveFeed.subscribe(event => {
      const reset = event.kind === 'session_boundary' && event.phase === 'reset';
      if (reset) history.clear();
      history.append(event);
      setLiveEvents(history.snapshot());
    });
    return unsub;
  }, [seedReady, liveFeed, retention]);

  // The dev-seed path reads the sandbox's own reactive array, capped at the
  // read (same reference under the cap, so no memo churn).
  const cappedSeedEvents = useMemo(
    () => (seedReady ? capNewest(seed.events, retention) : []),
    [seedReady, seed, retention],
  );
  return seedReady ? cappedSeedEvents : liveEvents;
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

export function toTrafficEvent(
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
    };
  }
  let pathVal = '(service)';
  if (e.path !== undefined) {
    pathVal = e.path;
  }
  let reasonsVal: string[] = [];
  if (e.reasons !== undefined) {
    reasonsVal = e.reasons;
  }
  return {
    kind: 'operation',
    service: e.service,
    id: record.id,
    at: record.at,
    observation: record.observation,
    detail: e.detail,
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
}

/**
 * The traffic feed. Firestore still emits legacy `request` events; RTDB and
 * other services can emit canonical `operation` events. Adapt both into the
 * headless `@pyric/ui/traffic` shape.
 */
export function useStudioTrafficHistory() {
  const events = useStudioEvents();
  return useMemo(() => {
    const requests = new Map<string, StudioTrafficEvent>();
    let omittedCount = 0;
    for (const event of events) {
      const operation = trafficOperationEvent(event);
      if (operation) {
        const request = toTrafficEvent(operation);
        requests.set(request.id, request);
      }
      if (event.kind === 'observation_gap') omittedCount += event.omittedCount;
    }
    return { requests: [...requests.values()], omittedCount };
  }, [events]);
}

export function useStudioTraffic(): StudioTrafficEvent[] {
  return useStudioTrafficHistory().requests;
}

/** The denied ops (rules-failure debugging), derived from the live stream. */
export function useStudioDenials(): Denial[] {
  const events = useStudioEvents();
  return useMemo<Denial[]>(() => selectDenials(events), [events]);
}

/** ALL rules-evaluated ops (allow AND deny/unsupported), derived from the live
 *  stream: the Traffic rules inspector's feed (`selectRuleEvaluations`). */
export function useStudioRuleEvaluations(): Denial[] {
  const events = useStudioEvents();
  return useMemo<Denial[]>(() => selectRuleEvaluations(events), [events]);
}

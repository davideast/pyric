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
import { isOperationEvent, toOperationRecord } from 'pyric/sandbox';
import type { StudioTrafficEvent } from '../features/traffic/verdict.js';
import { foldSessionEventLog } from '../events/fold.js';
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
export const STUDIO_EVENT_CAP = 500;

/** Newest-retained cap. Returns the SAME reference when under the cap, so
 *  memo consumers don't churn on every render. */
function capNewest(events: readonly SandboxEvent[]): readonly SandboxEvent[] {
  return events.length > STUDIO_EVENT_CAP ? events.slice(-STUDIO_EVENT_CAP) : events;
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
export function useStudioEvents(): readonly SandboxEvent[] {
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
    setLiveEvents(capNewest(liveFeed.history()));
    const unsub = liveFeed.subscribe((event) =>
      setLiveEvents((prev) => capNewest(foldSessionEventLog(prev, event))),
    );
    return unsub;
  }, [seedReady, liveFeed]);

  // The dev-seed path reads the sandbox's own reactive array, capped at the
  // read (same reference under the cap, so no memo churn).
  const cappedSeedEvents = useMemo(
    () => (seedReady ? capNewest(seed.events) : []),
    [seedReady, seed],
  );
  return seedReady ? cappedSeedEvents : liveEvents;
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
}

/**
 * The traffic feed. Firestore still emits legacy `request` events; RTDB and
 * other services can emit canonical `operation` events. Adapt both into the
 * headless `@pyric/ui/traffic` shape.
 */
export function useStudioTraffic(): StudioTrafficEvent[] {
  const events = useStudioEvents();
  return useMemo<StudioTrafficEvent[]>(
    () => events.filter(isTrafficEvent).map(toTrafficEvent),
    [events],
  );
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

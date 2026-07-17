import { operationContextFor } from '../../sandbox/operation-record.js';
import type { AuthLens, EventActor, SandboxEvent } from '../../sandbox/types/events.js';
import { evictOldest } from './activity-bounded.js';
import { ACTIVITY_CONTRACT } from './activity-contract.js';
import {
  releaseActivityListenerBucket,
  releaseOldestActivityListener,
} from './activity-listener-retention.js';
import {
  compactActivityFingerprint,
  createActivityPublicIdentity,
} from './activity-public-identity.js';
import { activityStructuralIdentity } from './activity-structural-identity.js';

const MAX_FINGERPRINTS = 256;
const MAX_EVIDENCE_IDS = 8;
const MAX_INCIDENTS = 64;
const MAX_SEEN_EVENT_IDS = 8_192;

export interface ActivityFeed {
  history(): readonly SandboxEvent[];
  subscribe(listener: (event: SandboxEvent) => void): () => void;
}

export type ActivityPattern = 'repeated-read' | 'duplicate-listener' | 'listener-churn';
export type ActivitySeverity = 'warning' | 'critical';
export type ActivityAuthLens =
  | { readonly mode: 'as'; readonly uid: string }
  | { readonly mode: 'app-session' }
  | { readonly mode: 'anon' };
/** The most specific honest origin label an incident's operation context
 * carries: `app`, or `app <journeyId>` when the host stamped a page journey. */
export type ActivitySourceAttribution = 'app' | `app ${string}`;

export interface ActivityIncident {
  readonly fingerprint: string;
  readonly pattern: ActivityPattern;
  readonly confidence: 'medium' | 'high';
  readonly severity: ActivitySeverity;
  readonly service: 'firestore';
  readonly method: 'get' | 'list' | 'listen';
  readonly targetFingerprint: string;
  readonly actor: EventActor;
  readonly authLens: ActivityAuthLens;
  readonly authUid: string | null;
  readonly count: number;
  readonly windowMs: number;
  readonly listenerBalance?: {
    readonly attaches: number;
    readonly detaches: number;
    readonly active: number;
    /** Counts are bounded observed lower bounds after retention saturation. */
    readonly isLowerBound?: boolean;
  };
  readonly usage: {
    readonly unit: 'document-reads' | 'listener-attaches';
    readonly lowerBound: number;
    readonly limitations: readonly string[];
  };
  readonly evidenceEventIds: readonly string[];
  readonly sourceAttribution: ActivitySourceAttribution;
  readonly message: string;
}

export interface ActivityReport {
  readonly incidents: readonly ActivityIncident[];
}

export interface ActivityMonitor {
  report(): ActivityReport;
  dispose(): void;
}

interface ObservedEvent {
  readonly id: string;
  readonly at: number;
}

interface ReadBucket {
  events: ObservedEvent[];
}

interface ListenerLifecycleObservation extends ObservedEvent {
  readonly phase: 'attach' | 'detach';
}

interface ListenerBucket {
  readonly active: Map<string, ObservedEvent>;
  readonly lifecycle: ListenerLifecycleObservation[];
  saturated: boolean;
}

/**
 * Analyze Firebase activity without changing application behavior. Existing
 * history contributes to the report but never replays a warning; only a live
 * event can notify the caller.
 */
export function monitorFirebaseActivity(
  feed: ActivityFeed,
  onIncident: (incident: ActivityIncident) => void,
): ActivityMonitor {
  const reads = new Map<string, ReadBucket>();
  const listeners = new Map<string, ListenerBucket>();
  const appListeners = new Map<string, AppListenerIdentity>();
  const incidents = new Map<string, ActivityIncident>();
  const notifiedSeverity = new Map<string, ActivitySeverity>();
  const seenEventIds = new Set<string>();
  const publicIdentity = createActivityPublicIdentity(MAX_FINGERPRINTS);
  let segment = 0;
  let disposed = false;

  const notify = (incident: ActivityIncident): void => {
    try {
      onIncident(incident);
    } catch {
      /* A diagnostic sink must never change application behavior. */
    }
  };

  const rememberIncident = (key: string, incident: ActivityIncident): void => {
    if (!incidents.has(key) && incidents.size >= MAX_INCIDENTS) {
      evictOldest(incidents);
    }
    incidents.set(key, incident);
  };

  const shouldNotify = (key: string, severity: ActivitySeverity): boolean => {
    const previous = notifiedSeverity.get(key);
    if (previous !== undefined) {
      // Re-insert to keep active fingerprints newest; eviction under
      // MAX_FINGERPRINTS pressure must not make a still-hot fingerprint
      // re-notify at an unchanged severity.
      notifiedSeverity.delete(key);
      if (previous === 'critical' || previous === severity) {
        notifiedSeverity.set(key, previous);
        return false;
      }
      notifiedSeverity.set(key, severity);
      return true;
    }
    if (notifiedSeverity.size >= MAX_FINGERPRINTS) evictOldest(notifiedSeverity);
    notifiedSeverity.set(key, severity);
    return true;
  };

  const resetSegment = (): void => {
    reads.clear();
    listeners.clear();
    appListeners.clear();
    notifiedSeverity.clear();
    seenEventIds.clear();
    segment += 1;
  };

  const observe = (event: SandboxEvent, historical: boolean): void => {
    if (seenEventIds.has(event.id)) return;
    if (seenEventIds.size >= MAX_SEEN_EVENT_IDS) evictOldest(seenEventIds);
    seenEventIds.add(event.id);
    if (event.kind === 'session_boundary') {
      resetSegment();
      return;
    }

    const read = appFirestoreRead(event);
    if (!read) {
      const listener = appFirestoreListener(event, appListeners);
      if (listener) observeListener(event, listener, historical);
      return;
    }

    const key = `segment:${segment}|read:${read.method}:${read.targetFingerprint}`
      + `|actor:${read.actorAuthFingerprint}`;
    let bucket = reads.get(key);
    if (!bucket) {
      if (reads.size >= MAX_FINGERPRINTS) evictOldest(reads);
      bucket = { events: [] };
      reads.set(key, bucket);
    }

    bucket.events.push({ id: event.id, at: event.at });
    const cutoff = event.at - ACTIVITY_CONTRACT.readWindowMs;
    while (bucket.events.length > 0 && bucket.events[0]!.at < cutoff) {
      bucket.events.shift();
    }
    if (bucket.events.length > ACTIVITY_CONTRACT.maxEventsPerFingerprint) {
      bucket.events.splice(
        0,
        bucket.events.length - ACTIVITY_CONTRACT.maxEventsPerFingerprint,
      );
    }
    if (bucket.events.length < ACTIVITY_CONTRACT.readThreshold) return;

    const first = bucket.events[0]!;
    const last = bucket.events[bucket.events.length - 1]!;
    const publicPath = compactActivityFingerprint(read.path);
    const incident: ActivityIncident = Object.freeze({
      fingerprint: publicIdentity.incidentFingerprint(key),
      pattern: 'repeated-read',
      confidence: 'high',
      severity: severityFor('repeated-read', bucket.events.length),
      service: 'firestore',
      method: read.method,
      targetFingerprint: publicIdentity.readTarget(read.path, read.targetFingerprint),
      actor: read.actor,
      authLens: publicAuthLens(read.authLens as Exclude<AuthLens, { mode: 'admin' }>),
      authUid: read.authUid,
      count: bucket.events.length,
      windowMs: last.at - first.at,
      usage: Object.freeze({
        unit: 'document-reads',
        lowerBound: bucket.events.length,
        limitations: Object.freeze([
          'Observed sandbox reads are a lower bound; production cache and billing behavior are not measured.',
        ]),
      }),
      evidenceEventIds: Object.freeze(
        bucket.events.slice(-MAX_EVIDENCE_IDS).map((entry) => entry.id),
      ),
      sourceAttribution: sourceAttributionFor(read.actor),
      message:
        `Repeated Firestore ${read.method} on ${publicPath}: `
        + `${bucket.events.length} reads in ${last.at - first.at}ms.`,
    });
    rememberIncident(key, incident);

    if (!historical && shouldNotify(key, incident.severity)) {
      notify(incident);
    }
  };

  const observeListener = (
    event: SandboxEvent,
    listener: AppFirestoreListener,
    historical: boolean,
  ): void => {
    const targetKey = activityStructuralIdentity(listener.target);
    const publicTarget = publicIdentity.listenerTarget(targetKey);
    const bucketKey = `segment:${segment}|listener:${targetKey}`
      + `|actor:${listener.actorAuthFingerprint}`;
    let bucket = listeners.get(bucketKey);
    if (!bucket) {
      if (listeners.size >= MAX_FINGERPRINTS) {
        const oldest = listeners.keys().next().value as string | undefined;
        if (oldest !== undefined) {
          releaseActivityListenerBucket(listeners.get(oldest)!.active, appListeners);
          listeners.delete(oldest);
        }
      }
      bucket = { active: new Map(), lifecycle: [], saturated: false };
      listeners.set(bucketKey, bucket);
    }

    if (listener.phase === 'attach') {
      if (bucket.active.has(listener.physicalListenerId)) return;
      if (bucket.active.size >= ACTIVITY_CONTRACT.maxEventsPerFingerprint) {
        if (releaseOldestActivityListener(bucket.active, appListeners)) {
          bucket.saturated = true;
        }
      }
      bucket.active.set(listener.physicalListenerId, { id: event.id, at: event.at });
      appListeners.set(listener.physicalListenerId, {
        listenerId: listener.listenerId,
        target: listener.target,
        actor: listener.actor,
        authLens: listener.authLens,
        authUid: listener.authUid,
        actorAuthFingerprint: listener.actorAuthFingerprint,
      });
    } else {
      bucket.active.delete(listener.physicalListenerId);
      appListeners.delete(listener.physicalListenerId);
    }
    // Firestore listener errors are terminal. They close active accounting,
    // but are not React cleanup and must not contribute to churn detection.
    if (listener.phase === 'errored') return;
    // Reauthorization replaces one logical app subscription underneath the
    // page. Keep active accounting current, but do not classify the host's
    // transparent detach/attach pair as React listener churn.
    if (listener.reauthorization) return;
    bucket.lifecycle.push({ id: event.id, at: event.at, phase: listener.phase });
    const cutoff = event.at - ACTIVITY_CONTRACT.listenerWindowMs;
    while (bucket.lifecycle.length > 0 && bucket.lifecycle[0]!.at < cutoff) {
      bucket.lifecycle.shift();
    }
    if (bucket.lifecycle.length > ACTIVITY_CONTRACT.maxEventsPerFingerprint) {
      bucket.lifecycle.splice(
        0,
        bucket.lifecycle.length - ACTIVITY_CONTRACT.maxEventsPerFingerprint,
      );
      bucket.saturated = true;
    }

    const attachCount = bucket.lifecycle.filter((entry) => entry.phase === 'attach').length;
    const detachCount = bucket.lifecycle.length - attachCount;
    const listenerBalance = Object.freeze({
      attaches: attachCount,
      detaches: detachCount,
      active: bucket.active.size,
      ...(bucket.saturated ? { isLowerBound: true } : {}),
    });

    if (bucket.active.size >= ACTIVITY_CONTRACT.duplicateListenerThreshold) {
      const active = [...bucket.active.values()];
      const first = active[0]!;
      const key = `${bucketKey}|duplicate`;
      emitListenerIncident(
        key,
        'duplicate-listener',
        active.length,
        event.at - first.at,
        active.map((entry) => entry.id),
        `Duplicate Firestore listener on ${publicTarget}: ${active.length} active subscriptions.`,
        historical,
        listener,
        publicTarget,
        listenerBalance,
      );
    }

    if (attachCount >= ACTIVITY_CONTRACT.churnAttachThreshold
      && detachCount >= ACTIVITY_CONTRACT.churnDetachThreshold) {
      const first = bucket.lifecycle[0]!;
      const key = `${bucketKey}|churn`;
      emitListenerIncident(
        key,
        'listener-churn',
        attachCount,
        event.at - first.at,
        bucket.lifecycle.map((entry) => entry.id),
        `Firestore listener churn on ${publicTarget}: `
          + `${attachCount} attaches and ${detachCount} detaches in ${event.at - first.at}ms.`,
        historical,
        listener,
        publicTarget,
        listenerBalance,
      );
    }
  };

  const emitListenerIncident = (
    key: string,
    pattern: 'duplicate-listener' | 'listener-churn',
    count: number,
    windowMs: number,
    evidenceEventIds: readonly string[],
    message: string,
    historical: boolean,
    listener: AppFirestoreListener,
    targetFingerprint: string,
    listenerBalance: NonNullable<ActivityIncident['listenerBalance']>,
  ): void => {
    const incident: ActivityIncident = Object.freeze({
      fingerprint: publicIdentity.incidentFingerprint(key),
      pattern,
      confidence: pattern === 'duplicate-listener'
        && count < ACTIVITY_CONTRACT.criticalDuplicateListenerThreshold
        ? 'medium'
        : 'high',
      severity: severityFor(pattern, count),
      service: 'firestore',
      method: 'listen',
      targetFingerprint: compactActivityFingerprint(targetFingerprint),
      actor: listener.actor,
      authLens: publicAuthLens(listener.authLens as Exclude<AuthLens, { mode: 'admin' }>),
      authUid: listener.authUid,
      count,
      windowMs,
      listenerBalance,
      usage: Object.freeze({
        unit: 'listener-attaches',
        lowerBound: count,
        limitations: Object.freeze([
          'Listener lifecycle events count attachments; document deliveries and production billing are not measured.',
          ...(listenerBalance.isLowerBound ? [
            'Listener retention saturated; reported counts are observed lower bounds.',
          ] : []),
        ]),
      }),
      evidenceEventIds: Object.freeze(evidenceEventIds.slice(-MAX_EVIDENCE_IDS)),
      sourceAttribution: sourceAttributionFor(listener.actor),
      message,
    });
    rememberIncident(key, incident);
    if (!historical && shouldNotify(key, incident.severity)) {
      notify(incident);
    }
  };

  const history = feed.history();
  for (const event of history) observe(event, true);
  // A restored capture belongs to a completed runtime segment. Keep its
  // incidents in report(), but never let its counters or active listener IDs
  // prime a warning in this fresh worker lifetime.
  if (history.length > 0) resetSegment();
  const unsubscribe = feed.subscribe((event) => {
    if (!disposed) observe(event, false);
  });

  return {
    report: () => Object.freeze({ incidents: Object.freeze([...incidents.values()]) }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      reads.clear();
      listeners.clear();
      appListeners.clear();
      notifiedSeverity.clear();
      seenEventIds.clear();
      publicIdentity.clear();
    },
  };
}

function severityFor(pattern: ActivityPattern, count: number): ActivitySeverity {
  const criticalThreshold = pattern === 'repeated-read'
    ? ACTIVITY_CONTRACT.criticalReadThreshold
    : pattern === 'duplicate-listener'
      ? ACTIVITY_CONTRACT.criticalDuplicateListenerThreshold
      : ACTIVITY_CONTRACT.criticalChurnThreshold;
  return count >= criticalThreshold ? 'critical' : 'warning';
}

/** The actor/auth identity every observed app operation and incident carries. */
interface ActivityActorIdentity {
  readonly actor: EventActor;
  readonly authLens: AuthLens;
  readonly authUid: string | null;
  readonly actorAuthFingerprint: string;
}

interface AppFirestoreListener extends ActivityActorIdentity {
  readonly phase: 'attach' | 'detach' | 'errored';
  readonly physicalListenerId: string;
  readonly listenerId: string;
  readonly reauthorization: boolean;
  readonly target: unknown;
}

type AppListenerIdentity = Omit<
  AppFirestoreListener,
  'phase' | 'physicalListenerId' | 'reauthorization'
>;

function appFirestoreListener(
  event: SandboxEvent,
  knownAppListeners: ReadonlyMap<string, AppListenerIdentity>,
): AppFirestoreListener | null {
  const isLegacy = event.kind === 'listener_attach'
    || event.kind === 'listener_detach'
    || event.kind === 'listener_errored';
  const isCanonical = event.kind === 'listener'
    && (event.phase === 'attach' || event.phase === 'detach' || event.phase === 'errored');
  if (!isLegacy && !isCanonical) return null;
  if ((event.service ?? 'firestore') !== 'firestore') return null;
  if (event.planId) return null;

  let phase: 'attach' | 'detach' | 'errored';
  if (event.kind === 'listener_attach') phase = 'attach';
  else if (event.kind === 'listener_detach') phase = 'detach';
  else if (event.kind === 'listener_errored') phase = 'errored';
  else if (event.kind === 'listener'
    && (event.phase === 'attach' || event.phase === 'detach' || event.phase === 'errored')) {
    phase = event.phase;
  } else {
    return null;
  }
  const context = operationContextFor(event);
  const knownIdentity = phase !== 'attach' ? knownAppListeners.get(event.listenerId) : undefined;
  const isKnownAppTermination = knownIdentity !== undefined;
  if (
    !isKnownAppTermination
    && (context.source.kind !== 'app' || context.authLens.mode === 'admin')
  ) return null;
  const logicalListenerId = event.activityListenerId ?? knownIdentity?.listenerId ?? event.listenerId;
  const identity: AppListenerIdentity = knownIdentity ?? {
    listenerId: logicalListenerId,
    target: event.target,
    actor: context.source,
    authLens: context.authLens,
    authUid: event.auth?.uid ?? null,
    actorAuthFingerprint: activityStructuralIdentity({
      actor: context.source,
      authLens: publicAuthLens(
        context.authLens as Exclude<AuthLens, { mode: 'admin' }>,
      ),
      uid: event.auth?.uid ?? null,
    }),
  };
  return {
    phase,
    physicalListenerId: event.listenerId,
    reauthorization: event.activityListenerLifecycle === 'reauthorize',
    ...identity,
  };
}

/** Derive the most specific honest origin label the operation context carries.
 * The monitor only observes `app` traffic, so the label is `app`, refined by
 * the host-stamped page journey identity when the event carries one. */
function sourceAttributionFor(actor: EventActor): ActivitySourceAttribution {
  return actor.kind === 'app' && actor.journeyId !== undefined
    ? `app ${actor.journeyId}`
    : 'app';
}

/** Keep custom-token claims inside the sandbox; diagnostics need only the lens identity. */
function publicAuthLens(
  authLens: Exclude<AuthLens, { mode: 'admin' }>,
): ActivityAuthLens {
  if (authLens.mode === 'as') return { mode: 'as', uid: authLens.uid };
  return { mode: authLens.mode };
}

function appFirestoreRead(
  event: SandboxEvent,
): ({
  method: 'get' | 'list';
  path: string;
  targetFingerprint: string;
} & ActivityActorIdentity) | null {
  if (event.kind !== 'request' && event.kind !== 'operation') return null;
  const service = event.kind === 'request' ? (event.service ?? 'firestore') : event.service;
  if (service !== 'firestore') return null;
  if (event.method !== 'get' && event.method !== 'list') return null;
  if (event.origin !== 'user' || event.result !== 'allow') return null;
  if (
    event.groupId
    || event.groupKind
    || event.activityGroupKind
    || event.planId
    || event.detail?.admin === true
  ) return null;

  const context = operationContextFor(event);
  if (context.source.kind !== 'app' || context.authLens.mode === 'admin') return null;
  const path = event.path ?? '<unknown>';
  const query = event.kind === 'request'
    ? (event.detail?.activityQuery ?? event.detail?.query)
    : event.request?.query;
  const serializedQuery = query === undefined ? undefined : activityStructuralIdentity(query);
  return {
    method: event.method,
    path,
    targetFingerprint: serializedQuery === undefined ? path : `${path}|query:${serializedQuery}`,
    actorAuthFingerprint: activityStructuralIdentity({
      actor: context.source,
      authLens: publicAuthLens(
        context.authLens as Exclude<AuthLens, { mode: 'admin' }>,
      ),
      uid: event.auth?.uid ?? null,
    }),
    actor: context.source,
    authLens: context.authLens,
    authUid: event.auth?.uid ?? null,
  };
}

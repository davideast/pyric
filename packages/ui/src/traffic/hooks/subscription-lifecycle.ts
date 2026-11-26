/**
 * Normalized listener and connection lifecycle contract (#284).
 *
 * Unifies Firestore's legacy lifecycle variants (`listener_attach`,
 * `listener_detach`, `listener_errored`, `snapshot_delivery`,
 * `snapshot_suppressed`), canonical cross-service `SandboxListenerEvent`
 * (`kind: 'listener'`), explicit connection lifecycle events
 * (`kind: 'connection'`), `session_boundary` (`reset` / `dispose`), and
 * `observation_gap` horizons without fabricating `TrafficEvent` fields.
 *
 * Connection identity boundary (modeled against Cloud Firestore monitoring):
 * - Web/mobile client SDK instances share one database stream connection across
 *   all active listeners on that client session (`clientKind: 'web'`). Ten
 *   Firestore listeners on one web client report 10 listeners and 1 connection;
 *   zero listeners on one open web connection report 0 listeners and 1
 *   connection.
 * - Server client libraries open one stream connection per active listener
 *   (`clientKind: 'server'`).
 * - Active connections come strictly from explicit connection lifecycle events
 *   or an explicit connection baseline snapshot. They are never inferred from
 *   listener counts or SharedWorker page presence.
 */

import {
  operationContextFor,
  type AuthLens,
  type AuthState,
  type EventActor,
  type EventCaller,
  type SandboxEvent,
} from 'pyric/sandbox';

const DEFAULT_SCOPE = '(default)';

export type SubscriptionService = 'firestore' | 'rtdb';
export type SubscriptionListenerPhase =
  | 'attach'
  | 'detach'
  | 'delivery'
  | 'suppressed'
  | 'errored';
export type SubscriptionConnectionPhase = 'attach' | 'detach';
export type SubscriptionClientKind = 'web' | 'server';

/**
 * Explicit connection lifecycle event emitted at a connection owner boundary.
 */
export interface SubscriptionConnectionEvent {
  readonly kind: 'connection';
  readonly id: string;
  readonly at: number;
  readonly service: SubscriptionService | 'database';
  readonly phase: SubscriptionConnectionPhase;
  readonly connectionId: string;
  readonly clientKind?: SubscriptionClientKind;
  readonly database?: string;
  readonly instance?: string;
  readonly actor?: EventActor;
  readonly caller?: EventCaller;
  readonly auth?: AuthState;
}

export type SubscriptionLifecycleInput = SandboxEvent | SubscriptionConnectionEvent;

export interface NormalizedListenerLifecycleEvent {
  readonly kind: 'listener';
  readonly id: string;
  readonly at: number;
  readonly service: SubscriptionService;
  readonly scope: string;
  readonly listenerId: string;
  readonly listenerKey: string;
  readonly phase: SubscriptionListenerPhase;
  readonly connectionId?: string;
  readonly connectionKey?: string;
  readonly actor: EventActor;
  readonly authLens: AuthLens;
  readonly caller?: EventCaller;
  readonly auth?: AuthState;
}

export interface NormalizedConnectionLifecycleEvent {
  readonly kind: 'connection';
  readonly id: string;
  readonly at: number;
  readonly service: SubscriptionService;
  readonly scope: string;
  readonly connectionId: string;
  readonly connectionKey: string;
  readonly phase: SubscriptionConnectionPhase;
  readonly clientKind: SubscriptionClientKind;
  readonly actor?: EventActor;
  readonly caller?: EventCaller;
  readonly auth?: AuthState;
}

export interface NormalizedSessionBoundaryLifecycleEvent {
  readonly kind: 'session_boundary';
  readonly id: string;
  readonly at: number;
  readonly phase: 'reset' | 'dispose';
}

export interface NormalizedObservationGapLifecycleEvent {
  readonly kind: 'observation_gap';
  readonly id: string;
  readonly at: number;
  readonly reason: 'frame-limit' | 'history-limit';
  readonly omittedCount: number;
}

export type NormalizedSubscriptionLifecycleEvent =
  | NormalizedListenerLifecycleEvent
  | NormalizedConnectionLifecycleEvent
  | NormalizedSessionBoundaryLifecycleEvent
  | NormalizedObservationGapLifecycleEvent;

function normalizeServiceToken(raw: unknown): SubscriptionService | null {
  if (raw === 'firestore') return 'firestore';
  if (raw === 'rtdb' || raw === 'database') return 'rtdb';
  return null;
}

function normalizeScopeToken(service: SubscriptionService, event: object): string {
  if (service === 'firestore') {
    const rawDb = (event as { database?: unknown }).database;
    if (typeof rawDb === 'string' && rawDb.length > 0) return rawDb;
    return DEFAULT_SCOPE;
  }
  const rawInstance = (event as { instance?: unknown }).instance;
  if (typeof rawInstance === 'string' && rawInstance.length > 0) return rawInstance;
  return DEFAULT_SCOPE;
}

export function subscriptionListenerKey(
  service: SubscriptionService,
  scope: string,
  listenerId: string,
): string {
  return `${service}:${scope}:${listenerId}`;
}

export function subscriptionConnectionKey(
  service: SubscriptionService,
  scope: string,
  connectionId: string,
): string {
  return `${service}:${scope}:${connectionId}`;
}

function readExplicitConnectionId(event: object): string | undefined {
  const raw = (event as { connectionId?: unknown }).connectionId;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  return undefined;
}

function legacyFirestorePhase(kind: SandboxEvent['kind']): SubscriptionListenerPhase | null {
  if (kind === 'listener_attach') return 'attach';
  if (kind === 'listener_detach') return 'detach';
  if (kind === 'listener_errored') return 'errored';
  if (kind === 'snapshot_delivery') return 'delivery';
  if (kind === 'snapshot_suppressed') return 'suppressed';
  return null;
}

function isExplicitConnectionEvent(
  event: SubscriptionLifecycleInput,
): event is SubscriptionConnectionEvent {
  return event.kind === 'connection';
}

function buildNormalizedListenerEvent(
  event: SandboxEvent,
  service: SubscriptionService,
  listenerId: string,
  phase: SubscriptionListenerPhase,
): NormalizedListenerLifecycleEvent {
  const scope = normalizeScopeToken(service, event);
  const context = operationContextFor(event);
  const connectionId = readExplicitConnectionId(event);
  const authField = 'auth' in event ? event.auth : undefined;
  const out: {
    kind: 'listener';
    id: string;
    at: number;
    service: SubscriptionService;
    scope: string;
    listenerId: string;
    listenerKey: string;
    phase: SubscriptionListenerPhase;
    connectionId?: string;
    connectionKey?: string;
    actor: EventActor;
    authLens: AuthLens;
    caller?: EventCaller;
    auth?: AuthState;
  } = {
    kind: 'listener',
    id: event.id,
    at: event.at,
    service,
    scope,
    listenerId,
    listenerKey: subscriptionListenerKey(service, scope, listenerId),
    phase,
    actor: context.source,
    authLens: context.authLens,
  };
  if (connectionId !== undefined) {
    out.connectionId = connectionId;
    out.connectionKey = subscriptionConnectionKey(service, scope, connectionId);
  }
  if (event.caller !== undefined) out.caller = event.caller;
  if (authField !== undefined) out.auth = authField;
  return out;
}

/**
 * Pure normalizer mapping legacy Firestore listener events, canonical
 * cross-service `SandboxListenerEvent`s, explicit `connection` lifecycle
 * events, `session_boundary` events, and `observation_gap` markers into one
 * discriminated lifecycle union. Returns `null` for unrelated events.
 */
export function normalizeSubscriptionLifecycleEvent(
  event: SubscriptionLifecycleInput,
): NormalizedSubscriptionLifecycleEvent | null {
  if (isExplicitConnectionEvent(event)) {
    const service = normalizeServiceToken(event.service);
    if (service === null) return null;
    if (event.connectionId.length === 0) return null;
    const scope = normalizeScopeToken(service, event);
    const clientKind: SubscriptionClientKind = event.clientKind ?? 'web';
    const out: {
      kind: 'connection';
      id: string;
      at: number;
      service: SubscriptionService;
      scope: string;
      connectionId: string;
      connectionKey: string;
      phase: SubscriptionConnectionPhase;
      clientKind: SubscriptionClientKind;
      actor?: EventActor;
      caller?: EventCaller;
      auth?: AuthState;
    } = {
      kind: 'connection',
      id: event.id,
      at: event.at,
      service,
      scope,
      connectionId: event.connectionId,
      connectionKey: subscriptionConnectionKey(service, scope, event.connectionId),
      phase: event.phase,
      clientKind,
    };
    if (event.actor !== undefined) out.actor = event.actor;
    if (event.caller !== undefined) out.caller = event.caller;
    if (event.auth !== undefined) out.auth = event.auth;
    return out;
  }

  const firestorePhase = legacyFirestorePhase(event.kind);
  if (firestorePhase !== null && 'listenerId' in event) {
    return buildNormalizedListenerEvent(event, 'firestore', event.listenerId, firestorePhase);
  }

  if (event.kind === 'listener') {
    const service = normalizeServiceToken(event.service);
    if (service === null) return null;
    return buildNormalizedListenerEvent(event, service, event.listenerId, event.phase);
  }

  if (event.kind === 'session_boundary') {
    return {
      kind: 'session_boundary',
      id: event.id,
      at: event.at,
      phase: event.phase,
    };
  }

  if (event.kind === 'observation_gap') {
    return {
      kind: 'observation_gap',
      id: event.id,
      at: event.at,
      reason: event.reason,
      omittedCount: event.omittedCount,
    };
  }

  return null;
}

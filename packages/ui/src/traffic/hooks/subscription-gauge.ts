/**
 * Stateful gauge reducer and rolling pre-cap baseline for normalized listener
 * and connection lifecycle events (#284).
 */

import type { AuthLens, AuthState, EventActor, EventCaller } from 'pyric/sandbox';
import {
  normalizeSubscriptionLifecycleEvent,
  type NormalizedConnectionLifecycleEvent,
  type NormalizedListenerLifecycleEvent,
  type SubscriptionClientKind,
  type SubscriptionLifecycleInput,
  type SubscriptionService,
} from './subscription-lifecycle.js';

export const DEFAULT_SUBSCRIPTION_TRANSITION_CAP = 4_096;

export interface SubscriptionListenerRecord {
  readonly key: string;
  readonly listenerId: string;
  readonly service: SubscriptionService;
  readonly scope: string;
  readonly attachedAt: number;
  readonly connectionId?: string;
  readonly connectionKey?: string;
  readonly actor: EventActor;
  readonly authLens: AuthLens;
  readonly caller?: EventCaller;
  readonly auth?: AuthState;
}

export interface SubscriptionConnectionRecord {
  readonly key: string;
  readonly connectionId: string;
  readonly service: SubscriptionService;
  readonly scope: string;
  readonly clientKind: SubscriptionClientKind;
  readonly attachedAt: number;
  readonly actor?: EventActor;
  readonly caller?: EventCaller;
  readonly auth?: AuthState;
}

export type SubscriptionGaugeTransition =
  | {
      readonly kind: 'listener_attach';
      readonly at: number;
      readonly record: SubscriptionListenerRecord;
    }
  | {
      readonly kind: 'listener_terminal';
      readonly at: number;
      readonly phase: 'detach' | 'errored';
      readonly listenerKey: string;
      readonly service: SubscriptionService;
    }
  | {
      readonly kind: 'connection_attach';
      readonly at: number;
      readonly record: SubscriptionConnectionRecord;
    }
  | {
      readonly kind: 'connection_detach';
      readonly at: number;
      readonly connectionKey: string;
      readonly service: SubscriptionService;
    }
  | {
      readonly kind: 'dispose';
      readonly at: number;
    };

export interface SubscriptionGaugeSnapshot {
  readonly activeListeners: ReadonlyMap<string, SubscriptionListenerRecord>;
  readonly activeConnections: ReadonlyMap<string, SubscriptionConnectionRecord>;
  readonly baselineListeners: ReadonlyMap<string, SubscriptionListenerRecord>;
  readonly baselineConnections: ReadonlyMap<string, SubscriptionConnectionRecord>;
  readonly transitions: readonly SubscriptionGaugeTransition[];
  readonly connectionsObservedByService: ReadonlySet<SubscriptionService>;
  readonly capped: boolean;
  readonly uncoveredBeforeAt: number | null;
  readonly earliestTransitionAt: number | null;
  readonly latestTransitionAt: number | null;
}

export interface SubscriptionBaselineInit {
  readonly listeners?: readonly SubscriptionListenerRecord[];
  readonly connections?: readonly SubscriptionConnectionRecord[];
  readonly connectionsObservedServices?: readonly SubscriptionService[];
}

export const EMPTY_SUBSCRIPTION_GAUGE_SNAPSHOT: SubscriptionGaugeSnapshot = {
  activeListeners: new Map(),
  activeConnections: new Map(),
  baselineListeners: new Map(),
  baselineConnections: new Map(),
  transitions: [],
  connectionsObservedByService: new Set(),
  capped: false,
  uncoveredBeforeAt: null,
  earliestTransitionAt: null,
  latestTransitionAt: null,
};

export function createSubscriptionGaugeSnapshot(
  init?: SubscriptionBaselineInit,
): SubscriptionGaugeSnapshot {
  if (!init) return EMPTY_SUBSCRIPTION_GAUGE_SNAPSHOT;
  const listeners = new Map<string, SubscriptionListenerRecord>();
  const connections = new Map<string, SubscriptionConnectionRecord>();
  const observed = new Set<SubscriptionService>(init.connectionsObservedServices ?? []);

  for (const listener of init.listeners ?? []) {
    listeners.set(listener.key, listener);
  }
  for (const connection of init.connections ?? []) {
    connections.set(connection.key, connection);
    observed.add(connection.service);
  }

  return {
    activeListeners: listeners,
    activeConnections: connections,
    baselineListeners: new Map(listeners),
    baselineConnections: new Map(connections),
    transitions: [],
    connectionsObservedByService: observed,
    capped: false,
    uncoveredBeforeAt: null,
    earliestTransitionAt: null,
    latestTransitionAt: null,
  };
}

function maxHorizon(previous: number | null, candidate: number | null): number | null {
  if (candidate === null) return previous;
  if (previous === null) return candidate;
  return Math.max(previous, candidate);
}

function minTimestamp(previous: number | null, candidate: number): number {
  if (previous === null) return candidate;
  return Math.min(previous, candidate);
}

function maxTimestamp(previous: number | null, candidate: number): number {
  if (previous === null) return candidate;
  return Math.max(previous, candidate);
}

export function applySubscriptionTransition(
  listeners: Map<string, SubscriptionListenerRecord>,
  connections: Map<string, SubscriptionConnectionRecord>,
  transition: SubscriptionGaugeTransition,
  serviceFilter?: SubscriptionService,
  includeListener?: (record: SubscriptionListenerRecord) => boolean,
  includeConnection?: (record: SubscriptionConnectionRecord) => boolean,
): void {
  if (transition.kind === 'listener_attach') {
    const record = transition.record;
    const matchesService = serviceFilter === undefined || record.service === serviceFilter;
    const matchesPredicate = includeListener === undefined || includeListener(record);
    if (matchesService && matchesPredicate) {
      listeners.set(record.key, record);
    } else {
      listeners.delete(record.key);
    }
    return;
  }
  if (transition.kind === 'listener_terminal') {
    listeners.delete(transition.listenerKey);
    return;
  }
  if (transition.kind === 'connection_attach') {
    const record = transition.record;
    const matchesService = serviceFilter === undefined || record.service === serviceFilter;
    const matchesPredicate = includeConnection === undefined || includeConnection(record);
    if (matchesService && matchesPredicate) {
      connections.set(record.key, record);
    } else {
      connections.delete(record.key);
    }
    return;
  }
  if (transition.kind === 'connection_detach') {
    connections.delete(transition.connectionKey);
    for (const [key, listener] of listeners) {
      if (listener.connectionKey === transition.connectionKey) {
        listeners.delete(key);
      }
    }
    return;
  }
  listeners.clear();
  connections.clear();
}

function appendTransitionBounded(
  prev: SubscriptionGaugeSnapshot,
  transition: SubscriptionGaugeTransition,
  maxTransitions: number,
): {
  readonly baselineListeners: ReadonlyMap<string, SubscriptionListenerRecord>;
  readonly baselineConnections: ReadonlyMap<string, SubscriptionConnectionRecord>;
  readonly transitions: readonly SubscriptionGaugeTransition[];
  readonly capped: boolean;
  readonly uncoveredBeforeAt: number | null;
} {
  if (maxTransitions <= 0) {
    const nextBaseListeners = new Map(prev.baselineListeners);
    const nextBaseConnections = new Map(prev.baselineConnections);
    applySubscriptionTransition(nextBaseListeners, nextBaseConnections, transition);
    return {
      baselineListeners: nextBaseListeners,
      baselineConnections: nextBaseConnections,
      transitions: [],
      capped: true,
      uncoveredBeforeAt: maxHorizon(prev.uncoveredBeforeAt, transition.at + 1),
    };
  }

  if (prev.transitions.length < maxTransitions) {
    return {
      baselineListeners: prev.baselineListeners,
      baselineConnections: prev.baselineConnections,
      transitions: [...prev.transitions, transition],
      capped: prev.capped,
      uncoveredBeforeAt: prev.uncoveredBeforeAt,
    };
  }

  const evicted = prev.transitions[0];
  const nextBaseListeners = new Map(prev.baselineListeners);
  const nextBaseConnections = new Map(prev.baselineConnections);
  if (evicted !== undefined) {
    applySubscriptionTransition(nextBaseListeners, nextBaseConnections, evicted);
  }
  const retained = [...prev.transitions.slice(-(maxTransitions - 1)), transition];
  const oldestRetained = retained[0];
  let horizonCandidate: number | null = null;
  if (evicted !== undefined && oldestRetained !== undefined) {
    horizonCandidate = Math.max(oldestRetained.at, evicted.at + 1);
  } else if (evicted !== undefined) {
    horizonCandidate = evicted.at + 1;
  }
  return {
    baselineListeners: nextBaseListeners,
    baselineConnections: nextBaseConnections,
    transitions: retained,
    capped: true,
    uncoveredBeforeAt: maxHorizon(prev.uncoveredBeforeAt, horizonCandidate),
  };
}

function toListenerRecord(event: NormalizedListenerLifecycleEvent): SubscriptionListenerRecord {
  const record: {
    key: string;
    listenerId: string;
    service: SubscriptionService;
    scope: string;
    attachedAt: number;
    connectionId?: string;
    connectionKey?: string;
    actor: EventActor;
    authLens: AuthLens;
    caller?: EventCaller;
    auth?: AuthState;
  } = {
    key: event.listenerKey,
    listenerId: event.listenerId,
    service: event.service,
    scope: event.scope,
    attachedAt: event.at,
    actor: event.actor,
    authLens: event.authLens,
  };
  if (event.connectionId !== undefined) record.connectionId = event.connectionId;
  if (event.connectionKey !== undefined) record.connectionKey = event.connectionKey;
  if (event.caller !== undefined) record.caller = event.caller;
  if (event.auth !== undefined) record.auth = event.auth;
  return record;
}

function toConnectionRecord(
  event: NormalizedConnectionLifecycleEvent,
): SubscriptionConnectionRecord {
  const record: {
    key: string;
    connectionId: string;
    service: SubscriptionService;
    scope: string;
    clientKind: SubscriptionClientKind;
    attachedAt: number;
    actor?: EventActor;
    caller?: EventCaller;
    auth?: AuthState;
  } = {
    key: event.connectionKey,
    connectionId: event.connectionId,
    service: event.service,
    scope: event.scope,
    clientKind: event.clientKind,
    attachedAt: event.at,
  };
  if (event.actor !== undefined) record.actor = event.actor;
  if (event.caller !== undefined) record.caller = event.caller;
  if (event.auth !== undefined) record.auth = event.auth;
  return record;
}

/**
 * Fold one event into the stateful subscription gauge snapshot.
 * Unrelated operations and recurring deliveries leave gauge state untouched and
 * return `prev` by reference.
 */
export function foldSubscriptionGauge(
  prev: SubscriptionGaugeSnapshot,
  rawEvent: SubscriptionLifecycleInput,
  maxTransitions: number = DEFAULT_SUBSCRIPTION_TRANSITION_CAP,
): SubscriptionGaugeSnapshot {
  const normalized = normalizeSubscriptionLifecycleEvent(rawEvent);
  if (normalized === null) return prev;

  if (normalized.kind === 'observation_gap') {
    if (normalized.reason !== 'history-limit' && normalized.reason !== 'frame-limit') {
      return prev;
    }
    return {
      ...prev,
      capped: true,
      uncoveredBeforeAt: maxHorizon(prev.uncoveredBeforeAt, normalized.at + 1),
    };
  }

  if (normalized.kind === 'session_boundary') {
    if (normalized.phase === 'reset') {
      return {
        activeListeners: new Map(),
        activeConnections: new Map(prev.activeConnections),
        baselineListeners: new Map(),
        baselineConnections: new Map(prev.activeConnections),
        transitions: [],
        connectionsObservedByService: prev.connectionsObservedByService,
        capped: false,
        uncoveredBeforeAt: null,
        earliestTransitionAt: null,
        latestTransitionAt: null,
      };
    }
    if (prev.activeListeners.size === 0 && prev.activeConnections.size === 0) {
      return prev;
    }
    const transition: SubscriptionGaugeTransition = { kind: 'dispose', at: normalized.at };
    const bounded = appendTransitionBounded(prev, transition, maxTransitions);
    return {
      ...prev,
      ...bounded,
      activeListeners: new Map(),
      activeConnections: new Map(),
      earliestTransitionAt: minTimestamp(prev.earliestTransitionAt, normalized.at),
      latestTransitionAt: maxTimestamp(prev.latestTransitionAt, normalized.at),
    };
  }

  if (normalized.kind === 'listener') {
    if (normalized.phase === 'delivery' || normalized.phase === 'suppressed') {
      return prev;
    }
    if (normalized.phase === 'attach') {
      const record = toListenerRecord(normalized);
      const nextListeners = new Map(prev.activeListeners);
      nextListeners.set(record.key, record);
      const transition: SubscriptionGaugeTransition = {
        kind: 'listener_attach',
        at: normalized.at,
        record,
      };
      const bounded = appendTransitionBounded(prev, transition, maxTransitions);
      return {
        ...prev,
        ...bounded,
        activeListeners: nextListeners,
        earliestTransitionAt: minTimestamp(prev.earliestTransitionAt, normalized.at),
        latestTransitionAt: maxTimestamp(prev.latestTransitionAt, normalized.at),
      };
    }
    if (!prev.activeListeners.has(normalized.listenerKey)) {
      return prev;
    }
    const nextListeners = new Map(prev.activeListeners);
    nextListeners.delete(normalized.listenerKey);
    const transition: SubscriptionGaugeTransition = {
      kind: 'listener_terminal',
      at: normalized.at,
      phase: normalized.phase,
      listenerKey: normalized.listenerKey,
      service: normalized.service,
    };
    const bounded = appendTransitionBounded(prev, transition, maxTransitions);
    return {
      ...prev,
      ...bounded,
      activeListeners: nextListeners,
      earliestTransitionAt: minTimestamp(prev.earliestTransitionAt, normalized.at),
      latestTransitionAt: maxTimestamp(prev.latestTransitionAt, normalized.at),
    };
  }

  let nextObserved = prev.connectionsObservedByService;
  if (!nextObserved.has(normalized.service)) {
    const copy = new Set(nextObserved);
    copy.add(normalized.service);
    nextObserved = copy;
  }

  if (normalized.phase === 'attach') {
    const record = toConnectionRecord(normalized);
    const nextConnections = new Map(prev.activeConnections);
    nextConnections.set(record.key, record);
    const transition: SubscriptionGaugeTransition = {
      kind: 'connection_attach',
      at: normalized.at,
      record,
    };
    const bounded = appendTransitionBounded(prev, transition, maxTransitions);
    return {
      ...prev,
      ...bounded,
      activeConnections: nextConnections,
      connectionsObservedByService: nextObserved,
      earliestTransitionAt: minTimestamp(prev.earliestTransitionAt, normalized.at),
      latestTransitionAt: maxTimestamp(prev.latestTransitionAt, normalized.at),
    };
  }

  let hasMatchingListener = false;
  for (const listener of prev.activeListeners.values()) {
    if (listener.connectionKey === normalized.connectionKey) {
      hasMatchingListener = true;
      break;
    }
  }
  const hasActiveConnection = prev.activeConnections.has(normalized.connectionKey);
  if (!hasActiveConnection && !hasMatchingListener) {
    if (nextObserved === prev.connectionsObservedByService) return prev;
    return { ...prev, connectionsObservedByService: nextObserved };
  }

  const nextConnections = new Map(prev.activeConnections);
  nextConnections.delete(normalized.connectionKey);
  let nextListeners = prev.activeListeners;
  if (hasMatchingListener) {
    const copy = new Map(prev.activeListeners);
    for (const [key, listener] of copy) {
      if (listener.connectionKey === normalized.connectionKey) {
        copy.delete(key);
      }
    }
    nextListeners = copy;
  }
  const transition: SubscriptionGaugeTransition = {
    kind: 'connection_detach',
    at: normalized.at,
    connectionKey: normalized.connectionKey,
    service: normalized.service,
  };
  const bounded = appendTransitionBounded(prev, transition, maxTransitions);
  return {
    ...prev,
    ...bounded,
    activeListeners: nextListeners,
    activeConnections: nextConnections,
    connectionsObservedByService: nextObserved,
    earliestTransitionAt: minTimestamp(prev.earliestTransitionAt, normalized.at),
    latestTransitionAt: maxTimestamp(prev.latestTransitionAt, normalized.at),
  };
}

/**
 * Fold a full event backlog into a {@link SubscriptionGaugeSnapshot}.
 */
export function retainSubscriptionGauge(
  events: readonly SubscriptionLifecycleInput[],
  options: {
    readonly maxTransitions?: number;
    readonly baseline?: SubscriptionBaselineInit;
  } = {},
): SubscriptionGaugeSnapshot {
  const cap = options.maxTransitions ?? DEFAULT_SUBSCRIPTION_TRANSITION_CAP;
  let state = createSubscriptionGaugeSnapshot(options.baseline);
  for (const event of events) {
    state = foldSubscriptionGauge(state, event, cap);
  }
  return state;
}

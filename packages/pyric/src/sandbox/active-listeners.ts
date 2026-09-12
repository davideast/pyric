/**
 * Every listener the sandbox currently holds attached, derived by folding the
 * event stream's attach and detach lifecycle rather than tracked as separate
 * live state. A listener that never detached before a restart is still
 * active; one that detached, or errored, is not, no matter how many
 * deliveries it saw first.
 *
 * Firestore reports lifecycle through its own `listener_attach` /
 * `listener_detach` / `listener_errored` / `snapshot_delivery` /
 * `snapshot_suppressed` variants; the Realtime Database and every future
 * listening service report it through the canonical `listener` variant. This
 * module is the one place both shapes are folded into one answer, so a caller
 * asking "what is still listening" never has to know which service produced
 * the events.
 */
import type { AuthLens, EventActor, EventService } from './types/operation.js';
import { operationContextFor } from './operation-record.js';
import type { ListenerOwner, SandboxEvent } from './types/events.js';

/** The two families of target a listener watches. */
export type ActiveListenerTarget =
  | string
  | { readonly collection: string; readonly query?: unknown };

/** One listener that has attached and not yet detached or errored. */
export interface ActiveListener {
  readonly id: string;
  readonly service: 'firestore' | 'database';
  readonly target: ActiveListenerTarget;
  readonly actor: EventActor;
  readonly authLens: AuthLens;
  readonly attachedAt: number;
  readonly deliveryCount: number;
  readonly suppressedCount: number;
  readonly lastDeliveryAt?: number;
  /**
   * Who owns the listener, as its attach event recorded it (a creation frame,
   * an explicit tag) and as its deliveries revealed it (the DOM regions its
   * callback changed). Absent when the emitter recorded nothing.
   */
  readonly owners?: readonly ListenerOwner[];
  /**
   * The id the page's own client gave this subscription, when the host
   * stamped it on the attach as the activity listener id. A page that
   * observes a delivery knows only this id, so it is how a page-side
   * observation finds the listener the sandbox recorded.
   */
  readonly clientListenerId?: string;
  /**
   * The query the attach recorded, when the listener watches a query rather
   * than one record: Firestore's constraint projection, or the Realtime
   * Database's query spec. Absent for a document or a bare path.
   */
  readonly query?: unknown;
}

type ListenerPhase = 'attach' | 'detach' | 'delivery' | 'suppressed' | 'errored';

/** The listener-shaped fields this module reads off one raw event. */
interface ListenerEventInfo {
  readonly phase: ListenerPhase;
  readonly listenerId: string;
  readonly service: 'firestore' | 'database';
  readonly target: ActiveListenerTarget;
  readonly actor: EventActor;
  readonly authLens: AuthLens;
  readonly owners?: readonly ListenerOwner[];
  readonly query?: unknown;
}

/** The internal service token 'rtdb' translated to the word this module's
 * callers already use for the Realtime Database everywhere else on this
 * surface. */
function externalService(service: EventService | undefined): 'firestore' | 'database' {
  if (service === 'rtdb') return 'database';
  return 'firestore';
}

/** Firestore's own lifecycle target shape: a doc path, or a query's collection. */
function firestoreTarget(target: { kind: 'doc'; path: string } | { kind: 'query'; collection: string; query?: unknown }): ActiveListenerTarget {
  if (target.kind === 'doc') return target.path;
  return { collection: target.collection, query: target.query };
}

/** Canonical lifecycle target: today only a path, carried by the Realtime
 * Database's listeners. */
function canonicalTarget(target: { kind: string; path?: string; query?: unknown }): ActiveListenerTarget {
  if (target.path !== undefined) return target.path;
  return { collection: '', query: target.query };
}

/** The query a lifecycle target carries, as a spreadable field. Both services
 * put it on the target, so one reader serves them. */
function targetQuery(target: object): { query?: unknown } {
  const query = (target as { query?: unknown }).query;
  return query === undefined ? {} : { query };
}

/** The fields this module needs off one event, or `null` when it is not
 * listener lifecycle. */
function listenerEventInfo(event: SandboxEvent): ListenerEventInfo | null {
  const context = operationContextFor(event);
  const owners = 'owners' in event && Array.isArray(event.owners) ? event.owners : undefined;
  const identity = { actor: context.source, authLens: context.authLens, owners };

  if (event.kind === 'listener_attach') {
    return {
      phase: 'attach',
      listenerId: event.listenerId,
      service: 'firestore',
      target: firestoreTarget(event.target),
      ...identity,
      ...targetQuery(event.target),
    };
  }
  if (event.kind === 'listener_detach') {
    return { phase: 'detach', listenerId: event.listenerId, service: 'firestore', target: firestoreTarget(event.target), ...identity };
  }
  if (event.kind === 'listener_errored') {
    return { phase: 'errored', listenerId: event.listenerId, service: 'firestore', target: firestoreTarget(event.target), ...identity };
  }
  if (event.kind === 'snapshot_delivery') {
    return { phase: 'delivery', listenerId: event.listenerId, service: 'firestore', target: firestoreTarget(event.target), ...identity };
  }
  if (event.kind === 'snapshot_suppressed') {
    return { phase: 'suppressed', listenerId: event.listenerId, service: 'firestore', target: firestoreTarget(event.target), ...identity };
  }
  if (event.kind === 'listener') {
    return {
      phase: event.phase,
      listenerId: event.listenerId,
      service: externalService(event.service),
      target: canonicalTarget(event.target),
      ...identity,
      ...targetQuery(event.target),
    };
  }
  return null;
}

interface ActiveListenerDraft {
  id: string;
  service: 'firestore' | 'database';
  target: ActiveListenerTarget;
  actor: EventActor;
  authLens: AuthLens;
  attachedAt: number;
  deliveryCount: number;
  suppressedCount: number;
  lastDeliveryAt?: number;
  owners?: ListenerOwner[];
  clientListenerId?: string;
  query?: unknown;
}

/**
 * Every listener the sandbox holds attached right now, folded from its whole
 * event history. Order is attach order; a listener that detached and
 * reattached under the same id is folded from its most recent attach.
 */
export function activeListeners(events: readonly SandboxEvent[]): readonly ActiveListener[] {
  const active = new Map<string, ActiveListenerDraft>();
  for (const event of events) {
    const info = listenerEventInfo(event);
    if (info === null) continue;
    if (info.phase === 'attach') {
      const draft: ActiveListenerDraft = {
        id: info.listenerId,
        service: info.service,
        target: info.target,
        actor: info.actor,
        authLens: info.authLens,
        attachedAt: event.at,
        deliveryCount: 0,
        suppressedCount: 0,
      };
      if (info.owners !== undefined) draft.owners = [...info.owners];
      if (info.query !== undefined) draft.query = info.query;
      const clientListenerId = (event as { activity?: { listenerId?: unknown } }).activity?.listenerId;
      if (typeof clientListenerId === 'string') draft.clientListenerId = clientListenerId;
      active.set(info.listenerId, draft);
      continue;
    }
    const entry = active.get(info.listenerId);
    if (entry === undefined) continue;
    if (info.phase === 'delivery') {
      entry.deliveryCount += 1;
      entry.lastDeliveryAt = event.at;
      if (info.owners !== undefined) entry.owners = withDeliveryOwners(entry.owners, info.owners);
      continue;
    }
    if (info.phase === 'suppressed') {
      entry.suppressedCount += 1;
      continue;
    }
    // 'detach' and 'errored' both end a listener's active life.
    active.delete(info.listenerId);
  }
  return Object.freeze([...active.values()].map((entry) => Object.freeze({ ...entry })));
}

/**
 * A listener's owners after one delivery: the attach-time owners stay, and the
 * delivery's `regions` replace any earlier regions, since the latest delivery
 * is the current answer to what the callback paints.
 */
function withDeliveryOwners(
  current: readonly ListenerOwner[] | undefined,
  delivered: readonly ListenerOwner[],
): ListenerOwner[] {
  const regions = delivered.filter((owner) => owner.kind === 'regions');
  if (regions.length === 0) return [...(current ?? [])];
  const kept = (current ?? []).filter((owner) => owner.kind !== 'regions');
  return [...kept, ...regions];
}

/** Whether a listener's target starts with a caller-supplied prefix. A
 * query-shaped target is matched on its collection. */
export function activeListenerTargetStartsWith(
  target: ActiveListenerTarget,
  prefix: string,
): boolean {
  if (typeof target === 'string') return target.startsWith(prefix);
  return target.collection.startsWith(prefix);
}

/**
 * Observed calls: a client reports what production answered a call the app
 * made, and the host writes it to the event stream every traffic view reads.
 *
 * Both hosts reach this through `handleMessage`, which has already refused a
 * malformed record (`inbound-validation.ts`) and bound the frame's caller from
 * the connection (`caller.ts`). The record is read again here so the event is
 * built from a fresh copy that holds only the known fields, never from the
 * frame itself. Pyric serves nothing and changes no sandbox state. For a
 * Firestore or RTDB call it evaluates the same request against the local
 * rules files and records that verdict as `production.local`; production's
 * answer stays the event's result (`observe-local-verdict.ts`). A listener's
 * attach or detach becomes a `listener` event instead, with no verdict.
 */
import { emitSandboxEvent, observedCallEvent, observedListenerEvent, readObservedCall } from 'pyric/sandbox/internal';
import type { EventCaller, ObservedCall, Sandbox } from 'pyric/sandbox';
import type { VerifyObservedCallValues } from '../../../verify/fixture.js';
import type { ObserveMessage } from '../protocol.js';
import { activityJourneyId, ok, fail, type HostCtx, type PortLike } from '../host-context.js';
import { callerOf } from './caller.js';
import { localVerdict } from './observe-local-verdict.js';

/** A listener's attach or detach, as the reader returns it. */
type ObservedListener = NonNullable<ObservedCall['listener']>;

/** One sandbox's live call values by event id, and the size at which they are next pruned. */
interface ValueStore {
  byEvent: Map<string, VerifyObservedCallValues>;
  pruneAt: number;
}

/** Each sandbox's live call values: host memory, read only by the capture. */
const LIVE_CALL_VALUES = new WeakMap<Sandbox, ValueStore>();

/** The fewest entries a store holds before an observed call prunes it. */
const MIN_PRUNE_AT = 256;

/**
 * Drop the values whose events the history no longer holds. A pruned
 * store is next pruned at twice its size, so pruning stays a constant cost
 * per observed call and the store stays within twice the history.
 */
function prune(sandbox: Sandbox, store: ValueStore): void {
  const held = new Set(sandbox.history().map((event) => event.id));
  for (const id of store.byEvent.keys()) {
    if (!held.has(id)) store.byEvent.delete(id);
  }
  store.pruneAt = Math.max(MIN_PRUNE_AT, store.byEvent.size * 2);
}

/** How many live calls' values `sandbox`'s host holds right now, without pruning them. */
export function heldLiveCallValueCount(sandbox: Sandbox): number {
  return LIVE_CALL_VALUES.get(sandbox)?.byEvent.size ?? 0;
}

/**
 * The values each live call in `sandbox` carried, by event id, for the
 * capture file to hold beside the events, pruned to the events the history
 * still holds. Emails are already left out.
 */
export function liveCallValues(sandbox: Sandbox): ReadonlyMap<string, VerifyObservedCallValues> {
  const store = LIVE_CALL_VALUES.get(sandbox);
  if (store === undefined) return new Map();
  prune(sandbox, store);
  return store.byEvent;
}

/** A token's claims without the account's email, top level or among its sign-in identities. */
function claimsWithoutEmail(claims: Record<string, unknown>): Record<string, unknown> {
  const { email: _email, ...rest } = claims;
  const firebase = rest.firebase;
  const hasIdentities = isRecord(firebase) && isRecord(firebase.identities);
  if (!hasIdentities) return rest;
  const { email: _identityEmail, ...identities } = firebase.identities as Record<string, unknown>;
  return { ...rest, firebase: { ...firebase, identities } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The values a call carried for the local rules, or `undefined` for none. */
function valuesOf(call: ObservedCall): VerifyObservedCallValues | undefined {
  const claims = call.account?.claims;
  const values: VerifyObservedCallValues = {
    ...(claims === undefined ? {} : { claims: claimsWithoutEmail(claims) }),
    ...(call.writeData === undefined ? {} : { writeData: call.writeData }),
    ...(call.document === undefined ? {} : { document: call.document }),
  };
  return Object.keys(values).length === 0 ? undefined : values;
}

function rememberValues(sandbox: Sandbox, eventId: string, call: ObservedCall): void {
  const values = valuesOf(call);
  if (values === undefined) return;
  const store = LIVE_CALL_VALUES.get(sandbox) ?? { byEvent: new Map<string, VerifyObservedCallValues>(), pruneAt: MIN_PRUNE_AT };
  LIVE_CALL_VALUES.set(sandbox, store);
  if (store.byEvent.size >= store.pruneAt) prune(sandbox, store);
  store.byEvent.set(eventId, values);
}

/**
 * The listener id the event names: the page's own id scoped to the
 * connection that minted it, so a page's and a Node process's `l-1` stay two
 * listeners. A caller with neither a page id nor a client id, such as a
 * relayed frame, is scoped to its port's journey id, so two such callers
 * never share one. The page's id stays the event's `activity.listenerId`.
 */
function scopedListenerId(ctx: HostCtx, port: PortLike, caller: EventCaller | undefined, id: string): string {
  const scope = caller?.pageId ?? caller?.clientId ?? activityJourneyId(ctx, port);
  return `${caller?.kind ?? 'port'}:${scope}:${id}`;
}

/** A listener's attach or detach record, and the caller that sent it. */
interface ListenerRecord {
  readonly call: ObservedCall;
  readonly listener: ObservedListener;
  readonly caller: EventCaller | undefined;
}

/** The most listeners one port is held to; past it the oldest is no longer swept. */
const MAX_ATTACHED_PER_PORT = 1024;

/** Each port's attached listeners by scoped id, until they detach or the port closes. */
const ATTACHED_BY_PORT = new WeakMap<PortLike, Map<string, ListenerRecord>>();

/** Hold an attach until its detach, or drop the listener a detach ends. */
function trackListener(port: PortLike, scopedId: string, record: ListenerRecord): void {
  const held = ATTACHED_BY_PORT.get(port) ?? new Map<string, ListenerRecord>();
  ATTACHED_BY_PORT.set(port, held);
  if (record.listener.phase === 'detach') {
    held.delete(scopedId);
    return;
  }
  const oldest = held.keys().next().value;
  if (held.size >= MAX_ATTACHED_PER_PORT && oldest !== undefined) held.delete(oldest);
  held.set(scopedId, record);
}

/**
 * Write a listener's attach or detach with its caller. It runs no local
 * rules and holds no values: the record carries none.
 */
function emitListener(ctx: HostCtx, port: PortLike, record: ListenerRecord): void {
  const { call, listener, caller } = record;
  const listenerId = scopedListenerId(ctx, port, caller, listener.id);
  const event = { ...observedListenerEvent(call), listenerId };
  trackListener(port, listenerId, record);
  emitSandboxEvent(ctx.sandbox, event, {
    actor: { kind: 'app' },
    authLens: { mode: 'app-session' },
    activity: { listenerId: listener.id },
    ...(caller === undefined ? {} : { caller }),
  });
}

/**
 * Detach every listener `port` attached and never detached, once the port
 * closes: a closed tab, a reload or an exited process ends its listeners
 * without an unsubscribe. Each would otherwise stay active, and a page
 * reloaded three times would read as three duplicate listeners.
 */
export function sweepObservedListeners(ctx: HostCtx, port: PortLike, now: () => number = Date.now): void {
  const held = ATTACHED_BY_PORT.get(port);
  if (held === undefined) return;
  const at = now();
  for (const { call, listener, caller } of [...held.values()]) {
    const detach: ObservedListener = { ...listener, phase: 'detach' };
    emitListener(ctx, port, { call: { ...call, at, listener: detach }, listener: detach, caller });
  }
  ATTACHED_BY_PORT.delete(port);
}

/** Write one observed call to the event stream with its caller, then answer the frame. */
export function handleObserve(ctx: HostCtx, port: PortLike, msg: ObserveMessage): void {
  try {
    const call = readObservedCall(msg.call);
    const listener = call.listener;
    if (listener !== undefined) {
      emitListener(ctx, port, { call, listener, caller: callerOf(msg) });
      ok(port, msg.id, undefined);
      return;
    }
    const observed = observedCallEvent(call);
    const local = localVerdict(ctx, call);
    const production = observed.production;
    const hasLocal = local !== undefined && production !== undefined;
    const event = hasLocal ? { ...observed, production: { ...production, local } } : observed;
    const caller = callerOf(msg);
    // Before the emit, so the capture its event schedules finds them.
    rememberValues(ctx.sandbox, event.id, call);
    emitSandboxEvent(ctx.sandbox, event, {
      actor: { kind: 'app' },
      authLens: { mode: 'app-session' },
      ...(caller === undefined ? {} : { caller }),
    });
    ok(port, msg.id, undefined);
  } catch (error) {
    fail(port, msg.id, error);
  }
}

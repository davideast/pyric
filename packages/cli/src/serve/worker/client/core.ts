import { setAiEvidence } from 'pyric/ai/internal';
/**
 * Worker-client transport core — the shared singleton machinery every API
 * family (firestore, auth, rtdb, storage) rides on: port wiring, RPC
 * correlation, the pending/subscriber maps, the Pyric Studio auth-lens default,
 * and the op-source (issuer) stamp.
 *
 * This module owns the client's mutable module state. Because ES module
 * bindings are live, family modules import `_defaultLens` (and the maps) and
 * observe every `setLens(...)` update through the same singleton — exactly as
 * they did when all of this lived inline in `client.ts`.
 */
import type { InboundMessage, OutboundMessage } from '../protocol.js';
import type { RuntimeReloadMessage } from '../protocol.js';
// TYPE-ONLY — the auth-lens contract + the cross-service event envelope, shared
// with the worker host + the sandbox's event provenance. Erased at build, so the
// leaf client bundle stays engine-free.
import type { AuthLens, SandboxEvent } from 'pyric/sandbox';
import { FirebaseError } from 'pyric/app';
import { receiveClockState } from './clock.js';
import type { ClientPort } from './handles.js';
import { createOperationBudget } from '../../../bridge/operation-budget.js';
import { requestInstance } from '../request-instance.js';
import { rtdbFateAtDrop } from '../rtdb-drop-fates.js';
import { hasValidOutboundEnvelope, hasValidReplyOutcome, snapshotError } from '../outbound-validation.js';
import { closeSendOrder, issueTime, postInOrder, waitsToSubscribe, withdrawOperation, withdrawSubscription, type SendReservation } from './send-order.js';

// ─── Port + correlation machinery ─────────────────────────────────────────

let _opCounter = 0;
let _subCounter = 0;

export function nextId(): string { return `op-${++_opCounter}`; }
export function nextSubId(): string { return `sub-${++_subCounter}`; }

/**
 * Pending RPC resolvers. Keyed by correlation id.
 * Resolves with the `value` field on success; rejects with a typed error
 * on failure.
 */
export const _pending = new Map<string, {
  port: ClientPort;
  clientSessionId?: string;
  /** The named RTDB instance the request addressed; a denial relay names it. */
  instance?: string;
  budget?: ReturnType<typeof createOperationBudget>;
  release?: () => void;
  /** When the app issued the request; a hold deadline counts from here. */
  issuedAt: number;
  /** The frame the request sent, so a transport can send it again after a drop. */
  message: InboundMessage;
  resolve: (v: unknown) => void;
  reject: (e: Error & { code?: string }) => void;
}>();

/**
 * Active snapshot subscribers. Keyed by subId.
 * `next` is the user-supplied callback; `error` is the optional error handler.
 */
export const _snapSubs = new Map<string, {
  port: ClientPort;
  next: (snap: unknown) => void;
  error?: (err: unknown) => void;
  /** Firestore listeners abort on app deletion; RTDB/Auth stop silently. */
  service?: 'firestore';
  message?: InboundMessage;
  close?: () => void;
}>();

/**
 * Active event-stream subscribers (Pyric Studio keystone). Keyed by subId.
 * `next` receives each delivered BATCH of `SandboxEvent`s — the first batch is
 * the initial `history()` snapshot, subsequent batches are single live events.
 */
export const _eventSubs = new Map<string, {
  port: ClientPort;
  next: (events: readonly SandboxEvent[]) => void;
  message: InboundMessage;
  error?: (error: Error & { code: string }) => void;
  /** Called when the subscription is sent again; the host replies with its whole history. */
  restored?: () => void;
}>();
const disconnectedPorts = new WeakSet<ClientPort>();
const runtimeReloadListeners = new Set<(message: RuntimeReloadMessage) => void>();

export function subscribeRuntimeReload(
  listener: (message: RuntimeReloadMessage) => void,
): () => void {
  runtimeReloadListeners.add(listener);
  return () => runtimeReloadListeners.delete(listener);
}

function appDeletedError(): Error & { code: string } {
  return Object.assign(new Error('Firebase App was deleted'), { code: 'app/app-deleted' });
}

/**
 * What on `port` is still waiting on the host: requests without a reply, and
 * data subscriptions (Firestore, RTDB, an AI stream). Auth state, presence,
 * messaging and event-stream subscriptions are not counted; they observe the
 * host rather than wait on it. A Node process stays up while this is nonzero.
 */
export function outstandingWorkOn(port: ClientPort): number {
  let count = 0;
  for (const pending of _pending.values()) {
    const ownsRequest = pending.port === port;
    if (ownsRequest) count += 1;
  }
  for (const subscription of _snapSubs.values()) {
    const ownsSubscription = subscription.port === port;
    const target = (subscription.message as { target?: unknown } | undefined)?.target;
    const waitsOnData = typeof target === 'object' && target !== null;
    if (ownsSubscription && waitsOnData) count += 1;
  }
  return count;
}

export function isDisconnectedPort(port: ClientPort): boolean {
  return disconnectedPorts.has(port);
}

type SnapshotSubscription = typeof _snapSubs extends Map<string, infer T> ? T : never;

/** A subscription in the routing table whose `sub` frame the caller sends later. */
export interface RegisteredSubscription {
  /**
   * Sends the `sub` frame, in `reservation`'s place when one is given. Does
   * nothing once the subscription was cancelled. A frame the transport
   * refuses reports through the subscription's error callback, never a throw.
   */
  send(message: InboundMessage, reservation?: SendReservation): void;
}

/**
 * Puts a subscription in the routing table before its frame exists (D7), or
 * returns undefined when its app port is closed. Until `send` runs the entry
 * has no message, so no restore re-sends it and a cancel sends nothing.
 */
export function registerSnapshotSubscription(
  port: ClientPort,
  subId: string,
  subscription: SnapshotSubscription,
): RegisteredSubscription | undefined {
  const isDeleted = disconnectedPorts.has(port);
  if (isDeleted) return undefined;
  const entry: SnapshotSubscription = { ...subscription, message: undefined };
  _snapSubs.set(subId, entry);
  const isRegistered = (): boolean => _snapSubs.get(subId) === entry;
  const failed = (error: unknown): void => {
    const wasRegistered = isRegistered() && _snapSubs.delete(subId);
    if (wasRegistered) subscription.error?.(error);
  };
  return {
    send(message, reservation) {
      const wasCancelled = !isRegistered();
      if (wasCancelled) return;
      entry.message = message;
      try {
        if (reservation !== undefined) reservation.send(message, failed);
        else postInOrder(port, message, failed);
      } catch (error) {
        // A closed transport refuses the frame; the listener hears it as an error, as a deleted app's would.
        queueMicrotask(() => failed(error));
      }
    },
  };
}

/** Atomically register and post a subscription unless its app port is closed. */
export function openSnapshotSubscription(
  port: ClientPort,
  subId: string,
  subscription: SnapshotSubscription,
  message: InboundMessage,
  reservation?: SendReservation,
): boolean {
  const registered = registerSnapshotSubscription(port, subId, subscription);
  const isDeleted = registered === undefined;
  if (isDeleted) return false;
  registered.send(message, reservation);
  return true;
}

/** Atomically register an event-stream subscription unless its port is closed. */
export function openEventSubscription(
  port: ClientPort,
  subId: string,
  next: (events: readonly SandboxEvent[]) => void,
  message: InboundMessage,
  error?: (error: Error & { code: string }) => void,
  restored?: () => void,
): boolean {
  const isDeleted = disconnectedPorts.has(port);
  if (isDeleted) { error?.(appDeletedError()); return false; }
  _eventSubs.set(subId, { port, next, error, message, restored });
  const failed = (cause: unknown): void => {
    const isRegistered = _eventSubs.get(subId)?.message === message && _eventSubs.delete(subId);
    if (isRegistered) error?.(cause instanceof FirebaseError ? cause : appDeletedError());
  };
  try {
    postInOrder(port, message, failed);
  } catch (cause) {
    queueMicrotask(() => failed(cause));
  }
  return true;
}

/** Move existing observers when getToken selects a different Service Worker scope. */
export function retargetMessagingSubscriptions(
  port: ClientPort,
  recipientId: string,
  postMessage: ClientPort['postMessage'] = message => postInOrder(port, message),
): void {
  for (const [subId, subscription] of _snapSubs) {
    const message = subscription.message;
    const ownsSubscription = subscription.port === port && message?.t === 'sub';
    if (!ownsSubscription) continue;
    const isMessaging = message.target === 'messaging.foreground' || message.target === 'messaging.background';
    if (!isMessaging) continue;
    postMessage({ t: 'unsub', subId });
    message.recipientId = recipientId;
    postMessage(message);
  }
}

/** Reattach Messaging observers without replaying sends or token mutations. */
export function restoreMessagingSubscriptions(port: ClientPort, postMessage: ClientPort['postMessage']): void {
  const visibility = port.messagingVisibility;
  if (visibility) postMessage({ ...visibility, id: nextId() });
  for (const [subId, subscription] of _snapSubs) {
    const message = subscription.message;
    const ownsSubscription = subscription.port === port && message?.t === 'sub';
    if (!ownsSubscription) continue;
    const isMessaging = message.target === 'messaging.foreground' || message.target === 'messaging.background';
    if (!isMessaging) continue;
    postMessage({ t: 'unsub', subId });
    postMessage(message);
  }
}

/** Re-establish live observations without replaying operations or AI requests. */
export function restoreObservationSubscriptions(
  port: ClientPort,
  postMessage: ClientPort['postMessage'] = message => port.postMessage(message),
): void {
  for (const [subId, subscription] of _snapSubs) {
    const message = subscription.message;
    const ownsSubscription = subscription.port === port && message?.t === 'sub';
    if (!ownsSubscription) continue;
    const isRtdbTarget = typeof message.target === 'object' && 'service' in message.target && message.target.service === 'rtdb';
    const observesDatabase = subscription.service === 'firestore' || isRtdbTarget;
    const observesPresence = message.target === 'presence';
    const restoresObservation = observesDatabase || observesPresence;
    if (restoresObservation) {
      postMessage({ t: 'unsub', subId });
      postMessage(message);
    }
  }
  for (const [subId, subscription] of _eventSubs) {
    const ownsSubscription = subscription.port === port;
    if (!ownsSubscription) continue;
    subscription.restored?.();
    postMessage({ t: 'unsub', subId });
    postMessage(subscription.message);
  }
}

/** A replacement host has no Auth observers, even when the app retains its handle. */
export function restoreAuthSubscriptions(port: ClientPort, postMessage: ClientPort['postMessage']): void {
  for (const subscription of _snapSubs.values()) {
    const message = subscription.message;
    const ownsSubscription = subscription.port === port && message?.t === 'sub';
    if (ownsSubscription) {
      const observesAuth = message.target === 'authState' || message.target === 'idToken';
      if (observesAuth) postMessage(message);
    }
  }
}

/**
 * Remove a local subscription and notify only a live app port (D10). The host
 * hears `unsub` once, and only when its `sub` frame was sent: a second cancel
 * sends nothing, and a cancel before the frame left the client takes the
 * frame back instead.
 */
export function closeSubscription(
  port: ClientPort,
  subId: string,
  clientSessionId?: string,
): void {
  const entry = _snapSubs.get(subId) ?? _eventSubs.get(subId);
  const isOpen = entry !== undefined;
  if (!isOpen) return;
  _snapSubs.delete(subId);
  _eventSubs.delete(subId);
  const isDeleted = disconnectedPorts.has(port);
  if (isDeleted) return;
  const wasNeverSent = entry.message === undefined
    || withdrawSubscription(port, subId)
    || port.withdrawSubscription?.(subId) === true;
  if (wasNeverSent) return;
  const message: InboundMessage = { t: 'unsub', subId };
  const hasSessionId = clientSessionId !== undefined && clientSessionId !== '';
  if (hasSessionId) message.clientSessionId = clientSessionId;
  const ignore = (): void => {
    // Local cancellation is complete even when the host cannot be notified.
  };
  try {
    postInOrder(port, message, ignore);
  } catch {
    ignore();
  }
}

/**
 * Settle outstanding calls without claiming that the owning app was deleted.
 * `selects` narrows them by correlation id, so a transport can fail the calls
 * it sent and keep the ones it still holds.
 */
export function rejectPendingRequests(
  port: ClientPort,
  error: Error & { code: string },
  selects: (id: string) => boolean = () => true,
): void {
  for (const [id, pending] of [..._pending]) {
    const isOwnedRequest = pending.port === port;
    const isSelected = isOwnedRequest && selects(id);
    if (isSelected) {
      takePendingRequest(id);
      pending.reject(error);
    }
  }
}

/** The outstanding calls on `port` that `selects` picks, in issue order, with the frame each sent. */
export function pendingRequestsOn(
  port: ClientPort,
  selects: (id: string) => boolean,
): Array<{ id: string; message: InboundMessage }> {
  const requests: Array<{ id: string; message: InboundMessage }> = [];
  for (const [id, pending] of _pending) {
    const isSelected = pending.port === port && selects(id);
    if (isSelected) requests.push({ id, message: pending.message });
  }
  return requests;
}

/**
 * Moves each outstanding operation in `ids` to a new correlation id and
 * returns the frames to send under them, in the order given. A reply to an old
 * id then finds no call to settle; the Realtime Database SDK clears its
 * response callbacks on a drop for the same reason. A moved call goes to the
 * end of the issue order, after every call still outstanding.
 */
export function reissuePendingRequests(ids: string[]): InboundMessage[] {
  const reissued: InboundMessage[] = [];
  for (const id of ids) {
    const pending = _pending.get(id);
    const message = pending?.message;
    const isOutstandingOperation = pending !== undefined && message?.t === 'op';
    if (!isOutstandingOperation) continue;
    const moved = { ...message, id: nextId() };
    _pending.delete(id);
    _pending.set(moved.id, { ...pending, message: moved });
    reissued.push(moved);
  }
  return reissued;
}

/** Rejects one outstanding call with `error`, which may carry no code. */
export function rejectPendingRequest(id: string, error: Error): void {
  const pending = takePendingRequest(id);
  pending?.reject(error);
}

/**
 * Forgets one outstanding call without settling it: no reply can reach it
 * and its promise never settles, as production drops a sent onDisconnect's
 * callback when its connection drops.
 */
export function forgetPendingRequest(id: string): void {
  takePendingRequest(id);
}

/**
 * Forgets every Realtime Database onDisconnect call outstanding on a closing
 * port, sent or held, without settling it. `@firebase/database` 1.1.3 ends a
 * deleted app's connection as it ends a dropped one (`repoInterrupt`), which
 * clears the request callbacks, so an onDisconnect never settles there either.
 * The Firebase presence sample leaves that promise without a handler (#1215).
 */
export function forgetOnDisconnectCalls(port: ClientPort): void {
  for (const { id, message } of pendingRequestsOn(port, () => true)) {
    const isOnDisconnect = message.t === 'op' && rtdbFateAtDrop(message.method) === 'forget';
    if (isOnDisconnect) forgetPendingRequest(id);
  }
}

/** Drop every client-side correlation owned by a closing app port. */
export function disconnectPort(port: ClientPort): void {
  disconnectedPorts.add(port);
  forgetOnDisconnectCalls(port);
  rejectPendingRequests(port, appDeletedError());
  endPortSubscriptions(port, new FirebaseError('aborted', 'The operation was aborted.'), appDeletedError());
  port.onmessage = null;
}

/**
 * Ends every subscription on `port` once (D6). A Firestore listener and an
 * event stream hear the error; RTDB, Auth, Messaging and presence observers
 * stop without a call, as production's do when their app is deleted.
 */
export function endPortSubscriptions(
  port: ClientPort,
  error: Error & { code: string },
  streamError: Error & { code: string } = error,
): void {
  for (const [id, subscription] of [..._snapSubs]) {
    const isForeignSubscription = subscription.port !== port;
    if (isForeignSubscription) continue;
    _snapSubs.delete(id);
    const isFirestoreSubscription = subscription.service === 'firestore';
    if (isFirestoreSubscription) subscription.error?.(error);
    else if (isAiStream(subscription.message)) subscription.error?.(streamError);
    subscription.close?.();
  }
  for (const [id, subscription] of [..._eventSubs]) {
    const isForeignSubscription = subscription.port !== port;
    if (isForeignSubscription) continue;
    _eventSubs.delete(id);
    subscription.error?.(streamError);
  }
}

function isAiStream(message: InboundMessage | undefined): boolean {
  const isSubscription = message?.t === 'sub';
  if (!isSubscription) return false;
  const target = message.target;
  return typeof target === 'object' && target !== null && 'service' in target && target.service === 'ai';
}

/**
 * Fails every AI stream whose `sub` frame the dropped socket took (decision
 * 7). A stream is not restored on re-attach, so it fails once with `error`
 * like an operation in flight. Its `unsub` is held and released after the
 * re-attach, which stops a resumed session's pump. A stream whose frame is
 * still held stays open and is sent after the re-attach.
 */
export function failInFlightStreams(
  port: ClientPort,
  error: Error & { code: string },
  isHeld: (subId: string) => boolean,
): void {
  for (const [subId, subscription] of [..._snapSubs]) {
    const ownsStream = subscription.port === port && isAiStream(subscription.message);
    if (!ownsStream) continue;
    const wasSent = !isHeld(subId) && !waitsToSubscribe(port, subId);
    if (!wasSent) continue;
    closeSubscription(port, subId);
    subscription.error?.(error);
  }
}

// ─── Denial relay (headless dev visibility) ────────────────────────────────
//
// An agent driving `pyric dev` in process never sees the browser console, so
// a rules denial is otherwise invisible to it. Relay every denial (an error
// carrying `denialContext`) to the dev server, which prints it to the
// terminal — regardless of whether the app itself catches/handles the
// error. Fire-and-forget: never throws, never awaited into app flow, and a
// relay failure (dev server down, no `fetch`, non-pyric host) is swallowed
// silently — this is a diagnostics side channel, not a correctness path.

/** Shape POSTed to the dev server's `/__pyric/denials` endpoint. */
interface DenialRelayPayload {
  kind: 'listener' | 'read';
  code: string;
  message: string;
  denialContext: unknown;
  /** Sibling of denialContext on the sandbox error (query-proof denials
   *  attach the suggested where() fix there); forwarded when present. */
  remediation?: string;
  /** The named RTDB instance the denied request addressed; absent for the default one. */
  instance?: string;
  /** A denied listener's owners, as the page recorded them when it opened. */
  owners?: unknown[];
}

/** POST a denial to the dev server for terminal visibility. No-op when the
 *  error carries no `denialContext` (only rules denials are relayed) or when
 *  `fetch` isn't available (non-browser host). */
function relayDenial(
  kind: 'listener' | 'read',
  err: { message: string; code?: string; denialContext?: unknown; remediation?: unknown },
  instance?: string,
  owners?: unknown[],
): void {
  if (err.denialContext === undefined) return;
  if (typeof fetch !== 'function') return;
  const payload: DenialRelayPayload = {
    kind,
    code: err.code ?? 'unknown',
    message: err.message,
    denialContext: err.denialContext,
    ...(typeof err.remediation === 'string' ? { remediation: err.remediation } : {}),
    ...(instance === undefined ? {} : { instance }),
    ...(owners !== undefined ? { owners } : {}),
  };
  try {
    void fetch('/__pyric/denials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  } catch {
    /* fire-and-forget — never let the relay disturb app flow */
  }
}

/** Wire up the port's onmessage handler (idempotent per-port). */
export function wirePort(port: ClientPort): void {
  port.onmessage = (ev: MessageEvent<OutboundMessage>) => {
    const msg = ev.data;
    const hasInvalidEnvelope = !hasValidOutboundEnvelope(msg);
    if (hasInvalidEnvelope) {
      const error = new FirebaseError('unavailable',
        'The sandbox sent a malformed reply envelope. The operation may have completed; check state before retrying.');
      rejectPendingRequests(port, error);
      for (const [id, subscription] of _snapSubs) {
        const ownsSubscription = subscription.port === port;
        if (ownsSubscription) { closeSubscription(port, id); subscription.error?.(error); }
      }
      for (const [id, subscription] of _eventSubs) {
        const ownsSubscription = subscription.port === port;
        if (ownsSubscription) { closeSubscription(port, id); subscription.error?.(error); }
      }
      return;
    }
    const isResponse = msg.t === 'res';
    const isSnapshot = msg.t === 'snap';
    const isEventBatch = msg.t === 'event';
    const isRuntimeReload = msg.t === 'runtime-reload';
    const isClock = msg.t === 'clock';
    if (isResponse) {
      const pending = _pending.get(msg.id);
      const isForeignRequest = pending === undefined || pending.port !== port;
      if (isForeignRequest) return;
      takePendingRequest(msg.id);
      const hasInvalidOutcome = !hasValidReplyOutcome(msg);
      if (hasInvalidOutcome) {
        pending.reject(new FirebaseError('unavailable', 'The sandbox sent a malformed operation reply. The operation may have completed; check state before retrying.'));
        return;
      }
      const succeeded = msg.ok;
      if (succeeded) {
        pending.resolve(msg.value);
      } else {
        const hasCode = msg.error.codeless !== true;
        let err: Error & {
          code?: string;
          denialContext?: unknown;
          aiEnvelope?: unknown;
        };
        if (hasCode) {
          err = new FirebaseError(msg.error.code, msg.error.message);
        } else {
          err = new Error(msg.error.message);
        }
        // Structured denial context (spike gap 6): re-attach so consumers —
        // and the bridge relay, which re-serializes thrown errors — see the
        // same shape a local SandboxError carries.
        const hasDenialContext = msg.error.denialContext !== undefined;
        if (hasDenialContext) {
          err.denialContext = msg.error.denialContext;
        }
        // AI wire error envelope (pyric/ai): re-attach so the served
        // `firebase/ai` entry can mint the exact SDK AIError decoration the
        // in-process plane applies (see entries/ai.ts).
        const aiEvidence = msg.error.aiEvidence;
        const hasAiEvidence = aiEvidence !== undefined;
        if (hasAiEvidence) setAiEvidence(err, aiEvidence);
        const hasAiEnvelope = msg.error.aiEnvelope !== undefined;
        if (hasAiEnvelope) {
          err.aiEnvelope = msg.error.aiEnvelope;
        }
        relayDenial('read', err, pending.instance);
        pending.reject(err);
      }
    } else if (isSnapshot) {
      const sub = _snapSubs.get(msg.subId);
      if (sub === undefined) {
        const eventSub = _eventSubs.get(msg.subId);
        const errPayload = snapshotError(msg);
        if (eventSub !== undefined && eventSub.port === port && errPayload !== undefined) {
          closeSubscription(port, msg.subId, eventSub.message.clientSessionId);
          const err = errPayload.codeless !== true
            ? new FirebaseError(errPayload.code, errPayload.message)
            : Object.assign(new Error(errPayload.message), { code: 'unavailable' });
          eventSub.error?.(err);
        }
        return;
      }
      const isForeignSubscription = sub.port !== port;
      if (isForeignSubscription) return;
      const errPayload = snapshotError(msg);
      const hasError = errPayload !== undefined;
      if (hasError) {
        closeSubscription(port, msg.subId, sub.message?.clientSessionId);
        const hasCode = errPayload.codeless !== true;
        let err: Error & { code?: string; denialContext?: unknown; aiEnvelope?: unknown };
        if (hasCode) {
          err = new FirebaseError(errPayload.code, errPayload.message);
        } else {
          err = new Error(errPayload.message);
        }
        const hasDenialContext = errPayload.denialContext !== undefined;
        if (hasDenialContext) err.denialContext = errPayload.denialContext;
        const aiEvidence = errPayload.aiEvidence;
        const hasAiEvidence = aiEvidence !== undefined;
        if (hasAiEvidence) setAiEvidence(err, aiEvidence);
        const hasAiEnvelope = errPayload.aiEnvelope !== undefined;
        if (hasAiEnvelope) err.aiEnvelope = errPayload.aiEnvelope;
        const opened = sub.message;
        const owners = opened !== undefined && 'owners' in opened ? opened.owners : undefined;
        relayDenial('listener', err, requestInstance(opened), owners);
        // Surface an unobserved listener error instead of swallowing it — the
        // worker-path twin of the in-page default (a denied listener after a
        // rules change / sign-out must not fail silently on the page console).
        const handleError = sub.error;
        const hasErrorHandler = handleError !== undefined;
        if (hasErrorHandler) handleError.call(sub, err);
        else console.error('pyric/firestore: Uncaught Error in snapshot listener:', err);
        return;
      }
      sub.next(msg.value);
    } else if (isEventBatch) {
      // Event-stream batch (Pyric Studio keystone). Plain JSON SandboxEvents —
      // no rehydration. Deliver the whole batch to the registered subscriber.
      const subscription = _eventSubs.get(msg.subId);
      const ownsSubscription = subscription !== undefined && subscription.port === port;
      if (ownsSubscription) subscription.next(msg.events);
    } else if (isRuntimeReload) {
      for (const listener of runtimeReloadListeners) listener(msg);
    } else if (isClock) {
      receiveClockState(msg.state);
    }
  };
  // Ask for the clock mirror as the port is wired, so the values the page
  // mints synchronously (push ids, in-flight upload stamps) read the sandbox's
  // clock rather than the wall clock from the first op onward.
  port.postMessage({ t: 'clock-subscribe' } satisfies InboundMessage);
}

// ─── Auth lens (Pyric Studio) ──────────────────────────────────────────────
//
// The default per-op auth lens carried on every FIRESTORE DATA op this client
// sends. The host resolves a data handle from it (`lensDb` in host.ts):
//   - `{ mode: 'app-session' }` (the default): the served app's own session.
//   - `{ mode: 'as', uid }`: impersonate — rules evaluate as that user.
//   - `{ mode: 'admin' }`: admin lens (rule bypass; see host.ts gap note).
//
// Studio sets this so its data grids / rules-debug "re-run as user" views run
// under the chosen identity without threading `actAs` through every call. AUTH
// ops (`auth.*`) and `getVersion` are NEVER lensed — they operate the worker's
// session, not data — so the lens is stamped only on the data-op path.

export const AUTH_LENS_STORAGE_KEY = 'pyric:auth-lens';

type PersistedAuthLens =
  | Extract<AuthLens, { mode: 'admin' }>
  | Extract<AuthLens, { mode: 'as' }>
  | Extract<AuthLens, { mode: 'anon' }>;

export function isPersistedAuthLens(value: unknown): value is PersistedAuthLens {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { mode?: unknown; uid?: unknown };
  if (candidate.mode === 'admin' || candidate.mode === 'anon') return true;
  return candidate.mode === 'as' && typeof candidate.uid === 'string';
}

function normalizePersistedAuthLens(value: unknown): PersistedAuthLens | undefined {
  if (isPersistedAuthLens(value)) return value;
  return undefined;
}

/** Read persisted auth lens from sessionStorage safely. */
export function hydrateLensFromStorage(): AuthLens | undefined {
  if (typeof sessionStorage === 'undefined') return undefined;
  try {
    const raw = sessionStorage.getItem(AUTH_LENS_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    const persistedLens = normalizePersistedAuthLens(parsed);
    if (persistedLens) return persistedLens;
    sessionStorage.removeItem(AUTH_LENS_STORAGE_KEY);
    return undefined;
  } catch {
    try {
      sessionStorage.removeItem(AUTH_LENS_STORAGE_KEY);
    } catch {
      // Ignore storage restrictions
    }
    return undefined;
  }
}

/** Module-level default lens. `undefined` ⇒ the worker treats the op as the
 *  app's session (the additive default — existing senders omit `actAs`).
 *
 *  Exported as a LIVE binding: family modules read it to stamp the lens onto
 *  subscriptions (`onSnapshot`, `rtdbOnValue`), and see `setLens(...)` updates
 *  through this one singleton. */
export let _defaultLens: AuthLens | undefined = hydrateLensFromStorage();

const lensListeners = new Set<(lens: AuthLens | undefined) => void>();

/**
 * Register a listener for auth lens mutations.
 * Returns an unsubscribe function that removes the listener.
 */
export function subscribeLens(listener: (lens: AuthLens | undefined) => void): () => void {
  lensListeners.add(listener);
  return () => {
    lensListeners.delete(listener);
  };
}

/**
 * Set the default auth lens applied to subsequent Firestore DATA ops from this
 * client (Pyric Studio & Runtime Chip). Pass `{ mode: 'as', uid }` to read/write AS a user
 * (rules apply), `{ mode: 'admin' }` for the admin lens, or
 * `{ mode: 'app-session' }` / `undefined` to revert to the app's own session.
 *
 * The lens is process-wide for this client module (one served page = one
 * worker port), mirroring how Studio drives a single active identity at a time.
 * Auth ops are unaffected — they always operate the real session.
 *
 * Persists active admin and impersonation lenses to sessionStorage under
 * AUTH_LENS_STORAGE_KEY, and removes the key when cleared or reverted to the
 * app session.
 * Notifies all registered subscribeLens listeners.
 */
export function setLens(lens: AuthLens | undefined): void {
  _defaultLens = normalizePersistedAuthLens(lens);

  if (typeof sessionStorage !== 'undefined') {
    try {
      if (_defaultLens) {
        sessionStorage.setItem(AUTH_LENS_STORAGE_KEY, JSON.stringify(_defaultLens));
      } else {
        sessionStorage.removeItem(AUTH_LENS_STORAGE_KEY);
      }
    } catch {
      // Ignore quota or disabled storage restrictions
    }
  }

  for (const listener of [...lensListeners]) {
    try {
      listener(_defaultLens);
    } catch (err) {
      console.error('Error in subscribeLens listener:', err);
    }
  }
}

/** The active default lens (read-only view), for Studio UI to reflect state. */
export function getLens(): AuthLens | undefined {
  return _defaultLens;
}

/** Alias for {@link setLens} exposed on the public Web Auth surface. */
export const switchAuthLens = setLens;

/** Alias for {@link getLens} exposed on the public Web Auth surface. */
export const getAuthLens = getLens;

/** Alias for {@link subscribeLens} exposed on the public Web Auth surface. */
export const onAuthLensChanged = subscribeLens;

/**
 * Module-level op-source declaration (Pyric Studio traffic attribution).
 * When set, every op/sub message THIS CLIENT MODULE CONSTRUCTS is stamped
 * `source: 'studio'` on the wire; the host maps that onto the unified
 * event stream's `actor` field so Traffic can filter Studio's own
 * viewer/editor ops out of the app's stream.
 *
 * Studio's live plane sets this once at connect (`connectWorkerLive`);
 * the served APP page never calls it (its service handles remain the source
 * of app attribution), and RELAYED frames bypass Studio stamping entirely —
 * the bridge relay ({@link relayWorkerOp} / {@link relayWorkerSub}) clears the
 * Studio issuer and marks remote frames through {@link rawRpc} / a direct postMessage, so a
 * user's own admin-SDK traffic through the remote bridge is never
 * mislabeled as Studio's even though it rides the same port.
 */
let _opIssuer: 'studio' | undefined;

/** Declare who issues the ops this client module constructs. See {@link _opIssuer}. */
export function setOpIssuer(source: 'studio' | undefined): void {
  _opIssuer = source;
}

/** Stamp the declared op source onto a client-constructed message. Ops and
 *  subscriptions only — control frames (`tool`, `unsub`) never carry it
 *  (agent tool-calls dispatched through this port must not inherit
 *  Studio's source; their inner ops are attributed by the host). */
export function stampIssuer<T extends { t?: string }>(msg: T): T {
  return _opIssuer && (msg.t === 'op' || msg.t === 'sub')
    ? { ...msg, issuer: _opIssuer }
    : msg;
}

/**
 * Send an already-final message and return a promise for its result — no
 * implicit stamping. The RELAY path ({@link relayWorkerOp}) explicitly owns
 * the final remote provenance fields before sending through this function.
 *
 * The message goes out in call order ({@link postInOrder}), or in the place
 * `reservation` claimed when the app issued the call. A custom `postMessage`
 * is the transport's own restore traffic and bypasses the order.
 */
export function rawRpc(
  port: ClientPort,
  msg: InboundMessage,
  postMessage?: ClientPort['postMessage'],
  reservation?: SendReservation,
): Promise<unknown> {
  const isDeleted = disconnectedPorts.has(port);
  if (isDeleted) return Promise.reject(appDeletedError());
  const isOperation = msg.t === 'op' || msg.t === 'tool';
  const budget = isOperation ? operationBudget(port, msg.clientSessionId) : undefined;
  const budgetReservation = budget?.reserve(msg);
  const isRefused = budgetReservation?.accepted === false;
  if (isRefused) return Promise.reject(new FirebaseError(budgetReservation.error.code, budgetReservation.error.message));
  const isTeardown = msg.t === 'disconnect';
  // An app's teardown sends none of the frames still waiting for their turn.
  if (isTeardown) closeSendOrder(port);
  return new Promise<unknown>((resolve, reject) => {
    const opMsg = msg as { id: string };
    _pending.set(opMsg.id, {
      port,
      clientSessionId: msg.clientSessionId,
      instance: requestInstance(msg),
      budget: budget,
      release: budgetReservation?.release,
      issuedAt: reservation?.issuedAt ?? issueTime(),
      message: msg,
      resolve,
      reject,
    });
    const failed = (error: unknown): void => {
      const isPending = takePendingRequest(opMsg.id) !== undefined;
      if (isPending) reject(error);
    };
    try {
      if (postMessage !== undefined) postMessage(msg);
      else if (reservation !== undefined) reservation.send(msg, failed);
      else postInOrder(port, msg, failed);
    } catch (error) {
      failed(error);
    }
  });
}

function operationBudget(port: ClientPort, clientSessionId: string | undefined): ReturnType<typeof createOperationBudget> {
  for (const request of _pending.values()) {
    const belongsToClient = request.port === port && request.clientSessionId === clientSessionId;
    const budget = request.budget;
    const hasClientBudget = belongsToClient && budget !== undefined;
    if (hasClientBudget) return budget;
  }
  return createOperationBudget();
}

/** Removing correlation releases its operation charge, including local cancellation. */
function takePendingRequest(id: string) {
  const request = _pending.get(id);
  _pending.delete(id);
  if (request !== undefined) withdrawOperation(request.port, id);
  request?.release?.();
  return request;
}

/** Send a CLIENT-CONSTRUCTED message: stamps the declared op source, then sends. */
export function rpc(port: ClientPort, msg: InboundMessage, reservation?: SendReservation): Promise<unknown> {
  return rawRpc(port, stampIssuer(msg), undefined, reservation);
}

/**
 * Send a client RPC with a bounded wait, while keeping correlation cleanup
 * inside the transport module that owns the pending-request registry.
 */
export function rpcWithTimeout(
  port: ClientPort,
  msg: InboundMessage,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<unknown> {
  const id = (msg as { id: string }).id;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const isAlreadySettled = takePendingRequest(id) === undefined;
      if (isAlreadySettled) return;
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });
  return Promise.race([rpc(port, msg), timeout]).finally(() => {
    const hasTimer = timer !== undefined;
    if (hasTimer) clearTimeout(timer);
  });
}

/**
 * Like {@link rpc} but stamps the active default auth lens onto the op message
 * (Pyric Studio). Used by data-service ops so a `setLens(...)` choice
 * carries per op without every call site threading `actAs`. Auth ops + version
 * use the bare {@link rpc} so they never carry a lens.
 *
 * `actAs` is only attached when a lens is active — when none is set the wire
 * message is byte-identical to before, preserving the additive contract.
 */
export function dataRpc(
  port: ClientPort,
  msg: InboundMessage & { t: 'op' },
  reservation?: SendReservation,
): Promise<unknown> {
  if (disconnectedPorts.has(port) && !msg.method.startsWith('rtdb.')) {
    return Promise.reject(
      new FirebaseError('failed-precondition', 'The client has already been terminated.'),
    );
  }
  const withLens = _defaultLens ? { ...msg, actAs: _defaultLens } : msg;
  return rpc(port, withLens, reservation);
}

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
// TYPE-ONLY — the auth-lens contract + the cross-service event envelope, shared
// with the worker host + the sandbox's event provenance. Erased at build, so the
// leaf client bundle stays engine-free.
import type { AuthLens, SandboxEvent } from 'pyric/sandbox';
import { FirebaseError } from 'pyric/app';
import type { ClientPort } from './handles.js';

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
  resolve: (v: unknown) => void;
  reject: (e: Error & { code: string }) => void;
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
}>();

/**
 * Active event-stream subscribers (Pyric Studio keystone). Keyed by subId.
 * `next` receives each delivered BATCH of `SandboxEvent`s — the first batch is
 * the initial `history()` snapshot, subsequent batches are single live events.
 */
export const _eventSubs = new Map<string, {
  port: ClientPort;
  next: (events: readonly SandboxEvent[]) => void;
}>();
const disconnectedPorts = new WeakSet<ClientPort>();

function appDeletedError(): Error & { code: string } {
  return Object.assign(new Error('Firebase App was deleted'), { code: 'app/app-deleted' });
}

export function isDisconnectedPort(port: ClientPort): boolean {
  return disconnectedPorts.has(port);
}

/** Atomically register and post a subscription unless its app port is closed. */
export function openSnapshotSubscription(
  port: ClientPort,
  subId: string,
  subscription: (typeof _snapSubs extends Map<string, infer T> ? T : never),
  message: InboundMessage,
): boolean {
  if (disconnectedPorts.has(port)) return false;
  _snapSubs.set(subId, subscription);
  port.postMessage(message);
  return true;
}

/** Atomically register an event-stream subscription unless its port is closed. */
export function openEventSubscription(
  port: ClientPort,
  subId: string,
  next: (events: readonly SandboxEvent[]) => void,
  message: InboundMessage,
): boolean {
  if (disconnectedPorts.has(port)) return false;
  _eventSubs.set(subId, { port, next });
  port.postMessage(message);
  return true;
}

/** Remove a local subscription and notify only a live app port. */
export function closeSubscription(port: ClientPort, subId: string): void {
  _snapSubs.delete(subId);
  _eventSubs.delete(subId);
  if (!disconnectedPorts.has(port)) {
    port.postMessage({ t: 'unsub', subId } satisfies InboundMessage);
  }
}

/** Drop every client-side correlation owned by a closing app port. */
export function disconnectPort(port: ClientPort): void {
  disconnectedPorts.add(port);
  const error = appDeletedError();
  for (const [id, pending] of [..._pending]) {
    if (pending.port !== port) continue;
    _pending.delete(id);
    pending.reject(error);
  }
  for (const [id, subscription] of [..._snapSubs]) {
    if (subscription.port !== port) continue;
    _snapSubs.delete(id);
    if (subscription.service === 'firestore') {
      subscription.error?.(new FirebaseError('aborted', 'The operation was aborted.'));
    }
  }
  for (const [id, subscription] of [..._eventSubs]) {
    if (subscription.port !== port) continue;
    _eventSubs.delete(id);
  }
  port.onmessage = null;
}

/** Wire up the port's onmessage handler (idempotent per-port). */
export function wirePort(port: ClientPort): void {
  port.onmessage = (ev: MessageEvent<OutboundMessage>) => {
    const msg = ev.data;
    if (msg.t === 'res') {
      const pending = _pending.get(msg.id);
      if (!pending) return;
      _pending.delete(msg.id);
      if (msg.ok) {
        pending.resolve(msg.value);
      } else {
        const err = new Error(msg.error.message) as Error & {
          code: string;
          denialContext?: unknown;
          aiEnvelope?: unknown;
        };
        err.code = msg.error.code;
        // Structured denial context (spike gap 6): re-attach so consumers —
        // and the bridge relay, which re-serializes thrown errors — see the
        // same shape a local SandboxError carries.
        if (msg.error.denialContext !== undefined) {
          err.denialContext = msg.error.denialContext;
        }
        // AI wire error envelope (pyric/ai): re-attach so the served
        // `firebase/ai` entry can mint the exact SDK AIError decoration the
        // in-process plane applies (see entries/ai.ts).
        if (msg.error.aiEnvelope !== undefined) {
          err.aiEnvelope = msg.error.aiEnvelope;
        }
        pending.reject(err);
      }
    } else if (msg.t === 'snap') {
      const sub = _snapSubs.get(msg.subId);
      if (!sub) return;
      // Auth snaps carry `SerializedUser | null` — a null value is a valid
      // "signed out" payload, not an error, so guard the __error sniff.
      const value = (msg.value ?? {}) as Record<string, unknown>;
      if (value.__error) {
        const errPayload = value.__error as { code: string; message: string; denialContext?: unknown; aiEnvelope?: unknown };
        const err = new Error(errPayload.message) as Error & { code: string; denialContext?: unknown; aiEnvelope?: unknown };
        err.code = errPayload.code;
        if (errPayload.denialContext !== undefined) err.denialContext = errPayload.denialContext;
        if (errPayload.aiEnvelope !== undefined) err.aiEnvelope = errPayload.aiEnvelope;
        // Surface an unobserved listener error instead of swallowing it — the
        // worker-path twin of the in-page default (a denied listener after a
        // rules change / sign-out must not fail silently on the page console).
        if (sub.error) sub.error(err);
        else console.error('pyric/firestore: Uncaught Error in snapshot listener:', err);
        return;
      }
      sub.next(msg.value);
    } else if (msg.t === 'event') {
      // Event-stream batch (Pyric Studio keystone). Plain JSON SandboxEvents —
      // no rehydration. Deliver the whole batch to the registered subscriber.
      const subscription = _eventSubs.get(msg.subId);
      if (subscription) subscription.next(msg.events);
    }
  };
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

/** Module-level default lens. `undefined` ⇒ the worker treats the op as the
 *  app's session (the additive default — existing senders omit `actAs`).
 *
 *  Exported as a LIVE binding: family modules read it to stamp the lens onto
 *  subscriptions (`onSnapshot`, `rtdbOnValue`), and see `setLens(...)` updates
 *  through this one singleton. */
export let _defaultLens: AuthLens | undefined;

/**
 * Set the default auth lens applied to subsequent Firestore DATA ops from this
 * client (Pyric Studio). Pass `{ mode: 'as', uid }` to read/write AS a user
 * (rules apply), `{ mode: 'admin' }` for the admin lens, or
 * `{ mode: 'app-session' }` / `undefined` to revert to the app's own session.
 *
 * The lens is process-wide for this client module (one served page = one
 * worker port), mirroring how Studio drives a single active identity at a time.
 * Auth ops are unaffected — they always operate the real session.
 */
export function setLens(lens: AuthLens | undefined): void {
  _defaultLens = lens && lens.mode === 'app-session' ? undefined : lens;
}

/** The active default lens (read-only view), for Studio UI to reflect state. */
export function getLens(): AuthLens | undefined {
  return _defaultLens;
}

/**
 * Module-level op-source declaration (Pyric Studio traffic attribution).
 * When set, every op/sub message THIS CLIENT MODULE CONSTRUCTS is stamped
 * `source: 'studio'` on the wire; the host maps that onto the unified
 * event stream's `actor` field so Traffic can filter Studio's own
 * viewer/editor ops out of the app's stream.
 *
 * Studio's live plane sets this once at connect (`connectWorkerLive`);
 * the served APP page never calls it (its service handles remain the source
 * of app attribution), and RELAYED frames bypass Studio stamping entirely — the bridge
 * relay ({@link relayWorkerOp} / {@link relayWorkerSub}) forwards remote
 * frames verbatim through {@link rawRpc} / a direct postMessage, so a
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
 * stamping. The RELAY path ({@link relayWorkerOp}) sends through this so
 * remote frames pass verbatim.
 */
export function rawRpc(port: ClientPort, msg: InboundMessage): Promise<unknown> {
  if (disconnectedPorts.has(port)) return Promise.reject(appDeletedError());
  return new Promise<unknown>((resolve, reject) => {
    const opMsg = msg as { id: string };
    _pending.set(opMsg.id, {
      port,
      resolve,
      reject: reject as (e: Error & { code: string }) => void,
    });
    port.postMessage(msg);
  });
}

/** Send a CLIENT-CONSTRUCTED message: stamps the declared op source, then sends. */
export function rpc(port: ClientPort, msg: InboundMessage): Promise<unknown> {
  return rawRpc(port, stampIssuer(msg));
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
export function dataRpc(port: ClientPort, msg: InboundMessage & { t: 'op' }): Promise<unknown> {
  if (disconnectedPorts.has(port) && !msg.method.startsWith('rtdb.')) {
    return Promise.reject(
      new FirebaseError('failed-precondition', 'The client has already been terminated.'),
    );
  }
  const withLens = _defaultLens ? { ...msg, actAs: _defaultLens } : msg;
  return rpc(port, withLens);
}

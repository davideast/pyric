/**
 * SharedWorker host — Firestore + RTDB value-subscription registry.
 *
 * `onSnapshot` / RTDB `onValue` listeners registered against the op's
 * lens-resolved handle, with cross-port snapshot fan-out. Owns the
 * session-bound sub registry (#754) that re-establishes a port's lens-less
 * listeners under its NEW identity on every auth transition, mirroring prod's
 * stream re-establishment (a sign-out re-evaluates live listeners so an
 * auth-gated stream loses access instead of leaking the previous user's data).
 *
 * Routed here by the host dispatcher. Never imports the dispatcher.
 */

import {
  onSnapshot,
  type DocumentReference,
  type CollectionReference,
  type Query,
} from 'pyric/firestore';
import {
  ref as rtdbRef,
  onValue as rtdbOnValue,
  type DatabaseReference,
} from 'pyric/database/modular';

import type { FirestoreSubMessage, RtdbValueSubMessage, UnsubMessage } from '../protocol.js';
import { serializeError, isRtdbSub } from '../protocol.js';
import { type HostCtx, type PortLike, post } from '../host-context.js';
import { lensDb, sessionDb, lensRtdb, resolveTarget, serializeDocSnap } from './core.js';
import { rtdbSnapToWire } from './rtdb.js';

/**
 * Session-bound sub registry (#754): the original sub message for every
 * listener a port opened WITHOUT an explicit lens, so a port session change
 * can re-establish it under the new identity (see resubscribeSessionSubs).
 * Parallel to `ctx.subs` (which holds only the unsub fns).
 */
type SessionBoundSubMessage = FirestoreSubMessage | RtdbValueSubMessage;

const _sessionSubs = new WeakMap<HostCtx, Map<PortLike, Map<string, SessionBoundSubMessage>>>();

function sessionSubsFor(ctx: HostCtx, port: PortLike): Map<string, SessionBoundSubMessage> {
  let byPort = _sessionSubs.get(ctx);
  if (!byPort) {
    byPort = new Map();
    _sessionSubs.set(ctx, byPort);
  }
  let bySubId = byPort.get(port);
  if (!bySubId) {
    bySubId = new Map();
    byPort.set(port, bySubId);
  }
  return bySubId;
}

/** Drop a port's session-bound sub records — invoked by the dispatcher's
 *  `cleanupPort` on port disconnect. */
export function dropPortSessionSubs(ctx: HostCtx, port: PortLike): void {
  _sessionSubs.get(ctx)?.delete(port);
}

/**
 * Re-establish a port's session-bound listeners under its CURRENT session —
 * invoked (via the ctx hook) on every port session change. Mirrors prod's
 * stream re-establishment on auth transitions: each listener is torn down and
 * re-registered through `sessionDb`, so the fresh evaluation either delivers
 * a snapshot (allowed) or a `permission-denied` snap-error (revoked). A
 * signed-out page no longer keeps receiving auth-gated data.
 */
function resubscribeSessionSubs(ctx: HostCtx, port: PortLike): void {
  const bound = _sessionSubs.get(ctx)?.get(port);
  if (!bound || bound.size === 0) return;
  const portSubs = ctx.subs.get(port);
  for (const [subId, msg] of [...bound]) {
    const unsub = portSubs?.get(subId);
    if (unsub) unsub();
    portSubs?.delete(subId);
    bound.delete(subId); // handleSub/handleRtdbSub re-records it
    if (isRtdbSub(msg)) {
      handleRtdbSub(ctx, port, msg);
    } else {
      handleSub(ctx, port, msg);
    }
  }
}

export function handleSub(ctx: HostCtx, port: PortLike, msg: FirestoreSubMessage): void {
  // Resolve the listener's data handle through the SAME lens path ops use
  // (Pyric Studio F4 "watch as user"): `{ mode: 'as', uid }` registers the
  // listener as that user so its rule evals impersonate, `{ mode: 'admin' }`
  // bypasses rules. Absent ⇒ the PORT'S SESSION (#754), so an app listener
  // evaluates rules as whoever this tab signed in as.
  const db = msg.actAs ? lensDb(ctx, msg.actAs) : sessionDb(ctx, port);
  ensurePortSubs(ctx, port);
  const portSubs = ctx.subs.get(port)!;

  if (portSubs.has(msg.subId)) return; // idempotent

  // Session-bound listeners re-establish on this port's auth transitions.
  if (!msg.actAs) {
    ctx.resubscribePortSubs ??= (p) => resubscribeSessionSubs(ctx, p);
    sessionSubsFor(ctx, port).set(msg.subId, msg);
  }

  let target: DocumentReference | CollectionReference | Query;
  let unsub: () => void;
  try {
    target = resolveTarget(db, msg.target);
    unsub = registerListener(ctx, port, msg, target);
  } catch (e) {
    // resolveTarget / onSnapshot can throw synchronously (e.g. an invalid
    // query or a rules-rejected target). Deliver it to the client's onSnapshot
    // error callback as a snap-error instead of letting it escape handleMessage
    // as an unhandled rejection (which would silently deliver NOTHING).
    post(port, { t: 'snap', subId: msg.subId, value: { __error: serializeError(e) } });
    return;
  }

  portSubs.set(msg.subId, unsub);
}

export function handleRtdbSub(ctx: HostCtx, port: PortLike, msg: RtdbValueSubMessage): void {
  ensurePortSubs(ctx, port);
  const portSubs = ctx.subs.get(port)!;
  if (portSubs.has(msg.subId)) return;

  if (!msg.actAs) {
    ctx.resubscribePortSubs ??= (p) => resubscribeSessionSubs(ctx, p);
    sessionSubsFor(ctx, port).set(msg.subId, msg);
  }

  try {
    const ref = rtdbRef(lensRtdb(ctx, msg.actAs, port), msg.target.path);
    const unsub = rtdbOnValue(
      ref as DatabaseReference,
      (snap) => post(port, { t: 'snap', subId: msg.subId, value: rtdbSnapToWire(snap) }),
    );
    portSubs.set(msg.subId, unsub);
  } catch (e) {
    post(port, { t: 'snap', subId: msg.subId, value: { __error: serializeError(e) } });
  }
}

/** Register the real sandbox listener for a resolved target; returns its unsub.
 *  Split out of handleSub so the throwing surface (resolveTarget + onSnapshot)
 *  is inside handleSub's try/catch. */
function registerListener(
  _ctx: HostCtx,
  port: PortLike,
  msg: FirestoreSubMessage,
  target: DocumentReference | CollectionReference | Query,
): () => void {
  return onSnapshot(
    target as DocumentReference | Query,
    (snap) => {
      // Detect doc vs query snapshot by shape.
      const snapAny = snap as {
        id?: string;
        path?: string;
        exists?: boolean | (() => boolean);
        data?: () => Record<string, unknown> | undefined;
        docs?: Array<{
          id: string;
          path?: string;
          exists: boolean | (() => boolean);
          data(): Record<string, unknown>;
        }>;
      };

      if (Array.isArray(snapAny.docs)) {
        // Query snapshot
        const docs = snapAny.docs.map((d) =>
          serializeDocSnap(d as Parameters<typeof serializeDocSnap>[0]),
        );
        post(port, { t: 'snap', subId: msg.subId, value: { docs } });
      } else if (snapAny.id !== undefined) {
        // Doc snapshot
        post(port, {
          t: 'snap',
          subId: msg.subId,
          value: serializeDocSnap(snapAny as Parameters<typeof serializeDocSnap>[0]),
        });
      }
    },
    (err) => {
      // Snapshot listener error (e.g. rules changed to deny).
      // We forward as a snap with an __error field so the client can
      // surface it to the original onSnapshot error callback.
      post(port, { t: 'snap', subId: msg.subId, value: { __error: serializeError(err) } });
    },
  );
}

export function handleUnsub(ctx: HostCtx, port: PortLike, msg: UnsubMessage): void {
  // Drop the session-bound record first — even when the live listener never
  // registered (it errored at sub time), the record must not resurrect the
  // sub on a later session change.
  _sessionSubs.get(ctx)?.get(port)?.delete(msg.subId);
  const portSubs = ctx.subs.get(port);
  if (!portSubs) return;
  const unsub = portSubs.get(msg.subId);
  if (!unsub) return;
  unsub();
  portSubs.delete(msg.subId);
}

// ─── Internal helpers ─────────────────────────────────────────────────────

function ensurePortSubs(ctx: HostCtx, port: PortLike): void {
  if (!ctx.subs.has(port)) {
    ctx.subs.set(port, new Map());
  }
}

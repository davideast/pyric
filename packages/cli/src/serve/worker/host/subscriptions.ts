/**
 * SharedWorker host — Firestore + RTDB value-subscription registry.
 *
 * `onSnapshot` / RTDB `onValue` listeners registered against the op's
 * lens-resolved handle, with cross-port snapshot fan-out. Owns the
 * subscription intents that re-establish listeners after state replacement and
 * a port's lens-less listeners on every auth transition, mirroring prod's
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
  onValue as rtdbOnValue,
  type DatabaseReference,
  type Query as RtdbQuery,
} from 'pyric/database';

import type { FirestoreSubMessage, RtdbValueSubMessage, UnsubMessage } from '../protocol.js';
import { serializeError, isRtdbSub } from '../protocol.js';
import { activityJourneyId, type HostCtx, type PortLike, post } from '../host-context.js';
import {
  lensDb,
  lensRtdb,
  opProvenance,
  resolveTarget,
  serializeDocSnap,
} from './core.js';
import { rtdbSnapToWire, rtdbTarget } from './rtdb.js';

/**
 * The original data-subscription messages, including explicit lenses. State
 * replacement re-establishes all; auth changes select only app-session ones.
 * Parallel to `ctx.subs` (which holds only the unsub fns).
 */
type DataSubMessage = FirestoreSubMessage | RtdbValueSubMessage;

const _subscriptionIntents = new WeakMap<HostCtx, Map<PortLike, Map<string, DataSubMessage>>>();

function subscriptionIntentsFor(ctx: HostCtx, port: PortLike): Map<string, DataSubMessage> {
  const byPort = _subscriptionIntents.get(ctx) ?? new Map<PortLike, Map<string, DataSubMessage>>();
  _subscriptionIntents.set(ctx, byPort);
  const bySubId = byPort.get(port) ?? new Map<string, DataSubMessage>();
  byPort.set(port, bySubId);
  return bySubId;
}

/** Drop a port's subscription intents — invoked by the dispatcher's
 *  `cleanupPort` on port disconnect. */
export function dropPortSubscriptionIntents(ctx: HostCtx, port: PortLike): void {
  _subscriptionIntents.get(ctx)?.delete(port);
}

/**
 * Tear down and clear all active listeners for a port (e.g. on peer failover/replacement
 * or port disconnect), and drop its subscription intents.
 */
export function teardownPortSubscriptions(ctx: HostCtx, port: PortLike): void {
  const portSubs = ctx.subs.get(port);
  const hasPortSubscriptions = portSubs !== undefined;
  if (hasPortSubscriptions) {
    for (const unsub of portSubs.values()) {
      try {
        unsub();
      } catch {}
    }
    portSubs.clear();
    ctx.subs.delete(port);
  }
  dropPortSubscriptionIntents(ctx, port);
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
  const intents = _subscriptionIntents.get(ctx)?.get(port);
  const hasNoIntents = intents === undefined;
  if (hasNoIntents) return;
  for (const [subId, msg] of [...intents]) {
    const followsAppSession = !msg.actAs || msg.actAs.mode === 'app-session';
    if (followsAppSession) restartSubscription(ctx, port, subId, msg);
  }
}

/** Bind every retained data listener to the restored sandbox environment. */
export function restoreSubscriptions(ctx: HostCtx): void {
  const byPort = _subscriptionIntents.get(ctx);
  const hasNoIntents = byPort === undefined;
  if (hasNoIntents) return;
  for (const [port, intents] of [...byPort]) {
    for (const [subId, msg] of [...intents]) {
      restartSubscription(ctx, port, subId, msg);
    }
  }
}

function restartSubscription(ctx: HostCtx, port: PortLike, subId: string, msg: DataSubMessage): void {
  const portSubs = ctx.subs.get(port);
  const intents = _subscriptionIntents.get(ctx)?.get(port);
  const unsub = portSubs?.get(subId);
  const isRtdb = isRtdbSub(msg);
  const register = (): void => {
    unsub?.();
    portSubs?.delete(subId);
    intents?.delete(subId);
    if (isRtdb) {
      handleRtdbSub(ctx, port, msg);
    } else {
      handleSub(ctx, port, msg);
    }
  };
  if (isRtdb) {
    register();
    return;
  }
  // Restore the original listener's page attribution, including when another
  // consumer initiated the checkpoint restore outside that page's dispatcher.
  const provenance = {
    ...opProvenance(msg, activityJourneyId(ctx, port)),
    activity: { listenerId: subId, listenerLifecycle: 'reauthorize' as const },
  };
  const runWithProvenance = ctx.sandbox.runWithProvenance;
  const supportsProvenance = runWithProvenance !== undefined;
  if (supportsProvenance) {
    runWithProvenance.call(ctx.sandbox, provenance, register);
  } else {
    register();
  }
}

export function handleSub(ctx: HostCtx, port: PortLike, msg: FirestoreSubMessage): void {
  const portSubs = ensurePortSubs(ctx, port);

  const alreadyRegistered = portSubs.has(msg.subId);
  if (alreadyRegistered) return;

  let target: DocumentReference | CollectionReference | Query;
  let unsub: () => void;
  try {
    // Resolve the listener's data handle through the SAME lens path ops use
    // (Pyric Studio F4 "watch as user"): `{ mode: 'as', uid }` registers the
    // listener as that user so its rule evals impersonate, `{ mode: 'admin' }`
    // bypasses rules. Absent ⇒ the PORT'S SESSION (#754), so an app listener
    // evaluates rules as whoever this tab signed in as.
    const db = lensDb(ctx, msg.actAs, port);
    target = resolveTarget(db, msg.target);
    unsub = registerListener(ctx, port, msg, target);
  } catch (e) {
    // resolveTarget / onSnapshot / lensDb can throw synchronously (e.g. an invalid
    // query, malformed actAs lens, or a rules-rejected target). Deliver it to the client's onSnapshot
    // error callback as a snap-error instead of letting it escape handleMessage
    // as an unhandled rejection (which would silently deliver NOTHING).
    post(port, { t: 'snap', subId: msg.subId, value: { __error: serializeError(e) } });
    return;
  }

  ctx.resubscribePortSubs ??= (p) => resubscribeSessionSubs(ctx, p);
  subscriptionIntentsFor(ctx, port).set(msg.subId, msg);

  portSubs.set(msg.subId, unsub);
}

export function handleRtdbSub(ctx: HostCtx, port: PortLike, msg: RtdbValueSubMessage): void {
  const portSubs = ensurePortSubs(ctx, port);
  const alreadyRegistered = portSubs.has(msg.subId);
  if (alreadyRegistered) return;

  try {
    const ref = rtdbTarget(
      lensRtdb(ctx, msg.actAs, port),
      msg.target.path,
      msg.target.query,
    );
    const options: { owners?: typeof msg.owners } = {};
    const hasOwners = Boolean(msg.owners);
    if (hasOwners) options.owners = msg.owners;
    const unsub = rtdbOnValue(
      ref as DatabaseReference | RtdbQuery,
      (snap) => post(port, { t: 'snap', subId: msg.subId, value: rtdbSnapToWire(snap) }),
      (err) => post(port, { t: 'snap', subId: msg.subId, value: { __error: serializeError(err) } }),
      // Same reason as the Firestore path: the owners belong to the page.
      options,
    );

    ctx.resubscribePortSubs ??= (p) => resubscribeSessionSubs(ctx, p);
    subscriptionIntentsFor(ctx, port).set(msg.subId, msg);

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
    // The page derived the owners where its stack and its DOM are. Handing
    // them over makes the sandbox record those instead of capturing a frame
    // out of this worker's own bundle.
    { ...(msg.owners ? { owners: msg.owners } : {}) },
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
  // Drop the retained intent first — even when the live listener never
  // registered (it errored at sub time), the record must not resurrect the
  // sub on a later session change.
  _subscriptionIntents.get(ctx)?.get(port)?.delete(msg.subId);
  const portSubs = ctx.subs.get(port);
  const hasNoPortSubscriptions = portSubs === undefined;
  if (hasNoPortSubscriptions) return;
  const unsub = portSubs.get(msg.subId);
  const hasNoSubscription = unsub === undefined;
  if (hasNoSubscription) return;
  unsub();
  portSubs.delete(msg.subId);
}

// ─── Internal helpers ─────────────────────────────────────────────────────

function ensurePortSubs(ctx: HostCtx, port: PortLike): Map<string, () => void> {
  const portSubs = ctx.subs.get(port) ?? new Map<string, () => void>();
  ctx.subs.set(port, portSubs);
  return portSubs;
}

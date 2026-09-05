/**
 * SharedWorker host — the message dispatcher + port cleanup.
 *
 * The top of the host: `handleMessage` opens the op's ambient-provenance
 * window and hands to `dispatchMessage`, which peels off the auth / AI /
 * messaging / event families (their sibling `host-*.ts` modules), then routes
 * ops to `handleOp` (the firestore/rules/admin/rtdb/storage/connection/studio
 * orchestrator) and subs to the subscription registry. `cleanupPort` tears a
 * disconnected port's per-subsystem state down.
 *
 * `handleOp` resolves the op's Firestore handle ONCE (the `db`/`lens`
 * preamble) — the eager lens/session resolution every op sees — then dispatches
 * to the per-family `handle*Op` handlers. This is the single unit-testable seam:
 * tests build a real `HostCtx` over an in-memory sandbox and call
 * `handleMessage` directly with fake ports.
 */

import type { InboundMessage, OpMessage, ToolMessage } from '../protocol.js';
import {
  isAuthSub,
  isEventSub,
  isRtdbSub,
  isAiSub,
  isMessagingSub,
  isPresenceSub,
} from '../protocol.js';
// The canonical agent tool dispatcher — reused on the worker so a bridged agent
// executes against THIS sandbox (one backend for app + Studio + agent), instead
// of a separate in-page sandbox.
import { buildSandboxDispatcher } from '../../../bridge/client/dispatch.js';
import { firebaseOptionsEqual } from 'pyric/app/internal';

import { activityJourneyId, type HostCtx, type PortLike, ok, fail } from '../host-context.js';
import { getOrCreateRemoteClientPort, RemoteClientPort } from '../remote-client-port.js';
import {
  authSubsFor,
  isAuthOp,
  handleAuthOp,
  handleAuthSub,
  handleAuthUnsub,
  cleanupPortSession,
} from '../host-auth.js';
import {
  eventSubsFor,
  handleEventSub,
  handleEventUnsub,
} from '../host-events.js';
import { isAiOp, handleAiOp, handleAiSub } from '../host-ai.js';
import {
  isMessagingOp,
  handleMessagingOp,
  handleMessagingSub,
  cleanupPortMessaging,
} from '../host-messaging.js';
import {
  lensDb,
  lensProvenance,
  opProvenance,
} from './core.js';
import { isFirestoreReadOp, handleFirestoreReadOp } from './firestore-reads.js';
import { isFirestoreWriteOp, handleFirestoreWriteOp } from './firestore-writes.js';
import { isRulesOp, handleRulesOp } from './rules.js';
import { isAdminFirestoreOp, handleAdminFirestoreOp } from './admin-firestore.js';
import { isRtdbOp, handleRtdbOp, drainPortRtdbDisconnects, forgetPortRtdbConnection } from './rtdb.js';
import { isStorageOp, handleStorageOp } from './storage.js';
import { isConnectionOp, handleConnectionOp } from './connection.js';
import { isStudioOp, handleStudioOp } from './studio.js';
import {
  isPresenceOp,
  handlePresenceOp,
  handlePresenceSub,
  handlePresenceUnsub,
  cleanupPortPresence,
} from './presence.js';
import { handleSub, handleRtdbSub, handleUnsub, dropPortSessionSubs } from './subscriptions.js';

function configConflictError(): Error & { code: string } {
  return Object.assign(
    new Error('Pyric currently supports one Firebase configuration per runtime'),
    { code: 'app/multiple-configs-not-supported' },
  );
}

// ─── Op orchestrator ────────────────────────────────────────────────────────

async function handleOp(ctx: HostCtx, port: PortLike, msg: OpMessage): Promise<void> {
  // Explicit lens (Studio admin / as / app-session) → lensDb; no lens → the
  // PORT'S SESSION (#754), so app ops run as whoever this tab signed in as.
  let db: ReturnType<typeof lensDb>;
  try {
    db = lensDb(ctx, msg.actAs, port);
  } catch (e) {
    fail(port, msg.id, e);
    return;
  }
  // Provenance the op runs under. Stamped onto the unified event stream's
  // `authLens` by the emit path (C1 field / T1 emit). For `{ mode: 'as', uid }`
  // the resolved `db` already carries `auth: { uid }`, so a rules eval emits
  // under that identity; `lens` is the canonical normalised value the host
  // hands forward when the explicit emit-time stamp seam exists (see lensProvenance).
  const lens = lensProvenance(msg.actAs);
  void lens;

  // Firestore reads/writes run against the resolved `db` (lens/session)
  // computed above; peeled off to their family modules.
  if (isFirestoreReadOp(msg.method)) return handleFirestoreReadOp(ctx, port, msg, db);
  if (isFirestoreWriteOp(msg.method)) return handleFirestoreWriteOp(ctx, port, msg, db);
  if (isRulesOp(msg.method)) return handleRulesOp(ctx, port, msg, db);
  if (isAdminFirestoreOp(msg.method)) return handleAdminFirestoreOp(ctx, port, msg);
  if (isRtdbOp(msg.method)) return handleRtdbOp(ctx, port, msg);
  if (isStorageOp(msg.method)) return handleStorageOp(ctx, port, msg);
  if (isConnectionOp(msg.method)) return handleConnectionOp(ctx, port, msg);
  if (isStudioOp(msg.method)) return handleStudioOp(ctx, port, msg);
  if (isPresenceOp(msg.method)) return handlePresenceOp(ctx, port, msg);

  // Auth (`auth.*`), AI (`ai.*`), and messaging (`messaging.*`) ops are routed
  // to their handlers by dispatchMessage BEFORE reaching handleOp, so any
  // method landing here is genuinely unknown.
  fail(port, msg.id, new Error(`Unknown method: ${String((msg as { method: unknown }).method)}`));
}

// ─── Main dispatch ────────────────────────────────────────────────────────

/**
 * Agent tool-call dispatch. The bridge peer forwards `tool` messages so the
 * agent runs the canonical sandbox tool set against THIS worker's sandbox (the
 * same instance the app + Studio use) instead of a separate in-page backend.
 * Replies with a `res` whose value is the `{ ok, summary, data }` result.
 */
async function handleTool(ctx: HostCtx, port: PortLike, msg: ToolMessage): Promise<void> {
  try {
    ctx.toolDispatch ??= buildSandboxDispatcher(ctx.sandbox);
    const result = await ctx.toolDispatch(msg.name, msg.args ?? {});
    // Pre-serialize via JSON BEFORE the structured-clone hop over the port. Read
    // results carry real firebase wrapper instances (Timestamp/GeoPoint/Bytes/
    // VectorValue) whose toJSON() produces the canonical agent-facing shapes.
    // structuredClone would strip those prototypes (losing toJSON) and post
    // mangled internals, and would throw DataCloneError on any non-cloneable
    // field. JSON.stringify here runs toJSON() while the instances are intact and
    // yields a plain, clone-safe object — matching the in-page path, which
    // JSON-stringified at the bridge. A serialization error lands in the catch
    // below, never in postMessage.
    ok(port, msg.id, JSON.parse(JSON.stringify(result)));
  } catch (e) {
    fail(port, msg.id, e);
  }
}

/**
 * Handle one inbound message from a port.
 *
 * This is the primary unit-testable seam. Tests create a real `HostCtx`
 * backed by an in-memory pyric sandbox and call this function directly
 * with fake port objects, exercising the full op+subscription lifecycle
 * without a real SharedWorker.
 */
export async function handleMessage(
  ctx: HostCtx,
  port: PortLike,
  msg: InboundMessage,
): Promise<void> {
  if (msg.clientSessionId && ctx.disconnectedClientSessions?.has(msg.clientSessionId) && msg.t !== 'disconnect') {
    if ((msg as { resumeSession?: boolean }).resumeSession) {
      ctx.disconnectedClientSessions.delete(msg.clientSessionId);
    } else {
      if (msg.t === 'op' || msg.t === 'tool') {
        fail(
          new RemoteClientPort(port, msg.clientSessionId),
          msg.id,
          Object.assign(new Error('Firebase App was deleted'), { code: 'app/app-deleted' }),
        );
      } else if (msg.t === 'sub' && msg.target !== 'events') {
        new RemoteClientPort(port, msg.clientSessionId).postMessage({
          t: 'snap',
          subId: msg.subId,
          value: { __error: { code: 'app/app-deleted', message: 'Firebase App was deleted' } },
        });
      }
      return;
    }
  }

  const targetPort = msg.clientSessionId
    ? getOrCreateRemoteClientPort(ctx, port, msg.clientSessionId)
    : port;

  if (msg.t === 'disconnect' && msg.clientSessionId) {
    try {
      const virtualPort = ctx.remoteClientPorts?.get(msg.clientSessionId);
      if (virtualPort) {
        (ctx.disconnectedClientSessions ??= new Set()).add(msg.clientSessionId);
        ctx.remoteClientPorts?.delete(msg.clientSessionId);
        await cleanupPortWithDisconnect(ctx, virtualPort);
      }
      ok(targetPort, msg.id, undefined);
    } catch (error) {
      fail(targetPort, msg.id, error);
    }
    return;
  }

  if (msg.t === 'appConfig') {
    if (ctx.appOptions === undefined) {
      ctx.appOptions = structuredClone(msg.options);
    } else if (!firebaseOptionsEqual(ctx.appOptions, msg.options)) {
      (ctx.rejectedConfigPorts ??= new WeakSet()).add(targetPort);
    }
    return;
  }
  // A rejected app port still owns host-side resources until its explicit
  // disconnect handshake completes. Never swallow that teardown frame.
  if (ctx.rejectedConfigPorts?.has(targetPort) && msg.t !== 'disconnect') {
    if (msg.t === 'op' || msg.t === 'tool') {
      fail(targetPort, msg.id, configConflictError());
    } else if (msg.t === 'sub' && msg.target !== 'events') {
      const error = configConflictError();
      targetPort.postMessage({
        t: 'snap',
        subId: msg.subId,
        value: { __error: { code: error.code, message: error.message } },
      });
    }
    return;
  }
  if (ctx.disconnectedPorts?.has(targetPort) && msg.t !== 'disconnect') {
    if (msg.t === 'op' || msg.t === 'tool') {
      fail(
        targetPort,
        msg.id,
        Object.assign(new Error('Firebase App was deleted'), { code: 'app/app-deleted' }),
      );
    } else if (msg.t === 'sub' && msg.target !== 'events') {
      targetPort.postMessage({
        t: 'snap',
        subId: msg.subId,
        value: { __error: { code: 'app/app-deleted', message: 'Firebase App was deleted' } },
      });
    }
    return;
  }
  // Op provenance, bound at dispatch by `opProvenance` (see its docs). Opened
  // as the sandbox's SYNCHRONOUS ambient window so firestore/rtdb/auth emits —
  // which run inside `dispatchMessage` before any await — pick it up. Storage
  // ops emit AFTER async awaits, outside this window, so they thread the same
  // provenance EXPLICITLY instead (see `handleOp`'s storage cases). Without the
  // lens on admin ops, `verdictFor` mislabeled a rules BYPASS as ALLOW (the
  // RTDB/Firestore asymmetry the traffic-metrics work flagged).
  const isRemoteRelay = (msg as { relaySource?: 'remote' }).relaySource === 'remote'
    || Boolean(msg.clientSessionId);
  const tracksFirestoreActivity = !isRemoteRelay && (msg.t === 'op'
    ? isFirestoreReadOp(msg.method)
    : msg.t === 'sub'
      && msg.target !== null
      && typeof msg.target === 'object'
      && '__ref' in msg.target);
  const prov = opProvenance(
    msg,
    tracksFirestoreActivity ? activityJourneyId(ctx, targetPort) : undefined,
  );
  if (prov && ctx.sandbox.runWithProvenance) {
    return ctx.sandbox.runWithProvenance(prov, () => dispatchMessage(ctx, targetPort, msg));
  }
  return dispatchMessage(ctx, targetPort, msg);
}

async function dispatchMessage(
  ctx: HostCtx,
  port: PortLike,
  msg: InboundMessage,
): Promise<void> {
  if (msg.t === 'op') {
    if (isAuthOp(msg.method)) {
      await handleAuthOp(ctx, port, msg);
    } else if (isAiOp(msg.method)) {
      await handleAiOp(ctx, port, msg);
    } else if (isMessagingOp(msg.method)) {
      await handleMessagingOp(ctx, port, msg);
    } else {
      await handleOp(ctx, port, msg);
    }
  } else if (msg.t === 'sub') {
    if (isAuthSub(msg)) {
      handleAuthSub(ctx, port, msg);
    } else if (isEventSub(msg)) {
      handleEventSub(ctx, port, msg);
    } else if (isRtdbSub(msg)) {
      handleRtdbSub(ctx, port, msg);
    } else if (isAiSub(msg)) {
      // AI streams are FINITE subs registered in ctx.subs (so `unsub` cancels
      // them); they auto-unsub on the terminal done/error snap. host-ai.ts.
      handleAiSub(ctx, port, msg);
    } else if (isMessagingSub(msg)) {
      handleMessagingSub(ctx, port, msg);
    } else if (isPresenceSub(msg)) {
      handlePresenceSub(ctx, port, msg);
    } else {
      handleSub(ctx, port, msg);
    }
  } else if (msg.t === 'unsub') {
    // An unsub may target an auth sub, an event-stream sub, a presence sub, or
    // a Firestore listener — try the cheap routing registries first, then fall
    // through to the Firestore listener teardown.
    if (
      !handleAuthUnsub(ctx, port, msg.subId) &&
      !handleEventUnsub(ctx, port, msg.subId) &&
      !handlePresenceUnsub(ctx, port, msg.subId)
    ) {
      handleUnsub(ctx, port, msg);
    }
  } else if (msg.t === 'disconnect') {
    try {
      await cleanupPortWithDisconnect(ctx, port);
      ok(port, msg.id, undefined);
    } catch (error) {
      fail(port, msg.id, error);
    }
  } else if (msg.t === 'tool') {
    await handleTool(ctx, port, msg);
  }
}

/** Best-effort close path: drain queued RTDB work before session teardown. */
export async function cleanupPortWithDisconnect(ctx: HostCtx, port: PortLike): Promise<void> {
  let drainFailure: unknown;
  try {
    await drainPortRtdbDisconnects(ctx, port);
  } catch (error) {
    drainFailure = error;
  }
  try {
    cleanupPort(ctx, port);
  } catch (error) {
    if (drainFailure !== undefined) {
      throw new AggregateError([drainFailure, error], 'Multiple SharedWorker port resources failed to tear down');
    }
    throw error;
  }
  if (drainFailure !== undefined) throw drainFailure;
}

// ─── Port cleanup ─────────────────────────────────────────────────────────

/**
 * Tear down all subscriptions for a disconnected port.
 * Called when a port's `close` event fires (browser best-effort) or
 * when the entry point explicitly cleans up a port.
 */
export function cleanupPort(ctx: HostCtx, port: PortLike): void {
  (ctx.disconnectedPorts ??= new WeakSet()).add(port);
  const failures: unknown[] = [];
  const attempt = (cleanup: () => void): void => {
    try {
      cleanup();
    } catch (error) {
      failures.push(error);
    }
  };
  // Drop the port's auth subscriptions (routing entries — no real listener
  // to tear down), its per-port session, and its session-bound sub records
  // (#754).
  attempt(() => { authSubsFor(ctx).delete(port); });
  attempt(() => { cleanupPortSession(ctx, port); });
  attempt(() => { dropPortSessionSubs(ctx, port); });

  // Drop the port's event-stream subscriptions too (also routing entries off
  // the single shared `sandbox.onEvent` subscription — nothing to unsubscribe,
  // just stop fanning out to a dead port).
  attempt(() => { eventSubsFor(ctx).delete(port); });

  // Drop the port's messaging broker client so a closed tab's last-reported
  // visibility stops feeding the routing rule. Its delivery-handler unsubs
  // live in `ctx.subs` and are torn down with the loop below.
  attempt(() => { cleanupPortMessaging(ctx, port); });

  // Presence: best-effort remove this port's logical client when it was the
  // last association (lease expiry remains the correctness path).
  attempt(() => { cleanupPortPresence(ctx, port); });
  attempt(() => { forgetPortRtdbConnection(ctx, port); });

  const portSubs = ctx.subs.get(port);
  if (portSubs) {
    for (const unsub of portSubs.values()) attempt(unsub);
    ctx.subs.delete(port);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Multiple SharedWorker port resources failed to tear down');
  }
}

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
import { refuseInvalidInboundMessage } from '../inbound-validation.js';
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
import { isAuthActionCodeOp, handleAuthActionCodeOp } from './auth-action-codes.js';
import { handleCustomTokenSignIn } from './auth-custom-token.js';
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
import { handleClockOp, isClockOp, subscribeClock, unsubscribeClock } from './clock.js';
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
import { handleSub, handleRtdbSub, handleUnsub, dropPortSubscriptionIntents } from './subscriptions.js';

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
  if (isClockOp(msg.method)) return handleClockOp(ctx, port, msg);

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
 *
 * The frame's `actAs` carries the identity the bridge holds for its MCP caller,
 * so a tool call forwarded after `auth_impersonate` is rules-evaluated as that
 * user. It reaches the dispatcher, not `lensDb`: the agent tool surface names
 * its own identity seam (`as`), and that per-call argument still wins.
 */
async function handleTool(ctx: HostCtx, port: PortLike, msg: ToolMessage): Promise<void> {
  try {
    ctx.toolDispatch ??= buildSandboxDispatcher(ctx.sandbox);
    // `msg.actAs` is the identity the bridge holds for the MCP caller. The
    // dispatcher applies it only where a tool has no identity argument of its
    // own; it is NOT the `lensDb` path `op` frames take.
    const result = await ctx.toolDispatch(msg.name, msg.args ?? {}, msg.actAs);
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
  const isRefused = refuseInvalidInboundMessage(port, msg);
  if (isRefused) return;
  const clientSessionId = msg.clientSessionId;
  const isRemoteClient = clientSessionId !== undefined && clientSessionId !== '';
  const isDisconnect = msg.t === 'disconnect';
  const physicalPortIsClosed = ctx.disconnectedPorts?.has(port) === true && !isDisconnect;
  if (physicalPortIsClosed) {
    const replyPort = isRemoteClient ? new RemoteClientPort(port, clientSessionId) : port;
    refuseDeletedMessage(replyPort, msg);
    return;
  }
  const sessionIsClosed = isRemoteClient
    && ctx.disconnectedClientSessions?.has(clientSessionId) === true && !isDisconnect;
  if (sessionIsClosed) {
    const resumesSession = msg.resumeSession === true;
    if (resumesSession) {
      ctx.disconnectedClientSessions?.delete(clientSessionId);
    } else {
      refuseDeletedMessage(new RemoteClientPort(port, clientSessionId), msg);
      return;
    }
  }

  let targetPort = port;
  if (isRemoteClient) {
    // Tools carry their identity per call and create no port-owned subscriptions.
    // Correlate their replies without retaining a remote session after settlement.
    const hasRemoteSession = ctx.remoteClientPorts?.has(clientSessionId) === true;
    const needsRemoteSession = msg.t !== 'tool' || hasRemoteSession;
    targetPort = needsRemoteSession
      ? getOrCreateRemoteClientPort(ctx, port, clientSessionId)
      : new RemoteClientPort(port, clientSessionId);
  }

  const disconnectsRemoteClient = isDisconnect && isRemoteClient;
  if (disconnectsRemoteClient) {
    try {
      const virtualPort = ctx.remoteClientPorts?.get(clientSessionId);
      const hasVirtualPort = virtualPort !== undefined;
      if (hasVirtualPort) {
        (ctx.disconnectedClientSessions ??= new Set()).add(clientSessionId);
        ctx.remoteClientPorts?.delete(clientSessionId);
        await cleanupPortWithDisconnect(ctx, virtualPort);
      }
      ok(targetPort, msg.id, undefined);
    } catch (error) {
      fail(targetPort, msg.id, error);
    }
    return;
  }

  const configuresApp = msg.t === 'appConfig';
  if (configuresApp) {
    const hasNoAppOptions = ctx.appOptions === undefined;
    if (hasNoAppOptions) {
      ctx.appOptions = structuredClone(msg.options);
    } else {
      const optionsConflict = !firebaseOptionsEqual(ctx.appOptions, msg.options);
      if (optionsConflict) (ctx.rejectedConfigPorts ??= new WeakSet()).add(targetPort);
    }
    return;
  }
  // A rejected app port still owns host-side resources until its explicit
  // disconnect handshake completes. Never swallow that teardown frame.
  const rejectsConfig = ctx.rejectedConfigPorts?.has(targetPort) === true && !isDisconnect;
  if (rejectsConfig) {
    const isOperation = msg.t === 'op' || msg.t === 'tool';
    const isDataSubscription = msg.t === 'sub' && msg.target !== 'events';
    if (isOperation) {
      fail(targetPort, msg.id, configConflictError());
    } else if (isDataSubscription) {
      const error = configConflictError();
      targetPort.postMessage({
        t: 'snap',
        subId: msg.subId,
        value: { __error: { code: error.code, message: error.message } },
      });
    }
    return;
  }
  const targetPortIsClosed = ctx.disconnectedPorts?.has(targetPort) === true && !isDisconnect;
  if (targetPortIsClosed) {
    refuseDeletedMessage(targetPort, msg);
    return;
  }
  // Op provenance, bound at dispatch by `opProvenance` (see its docs). Opened
  // as the sandbox's SYNCHRONOUS ambient window so firestore/rtdb/auth emits —
  // which run inside `dispatchMessage` before any await — pick it up. Storage
  // ops emit AFTER async awaits, outside this window, so they thread the same
  // provenance EXPLICITLY instead (see `handleOp`'s storage cases). Without the
  // lens on admin ops, `verdictFor` mislabeled a rules BYPASS as ALLOW (the
  // RTDB/Firestore asymmetry the traffic-metrics work flagged).
  const isRemoteRelay = msg.relaySource === 'remote'
    || Boolean(msg.clientSessionId);
  const isOperation = msg.t === 'op';
  const tracksFirestoreActivity = !isRemoteRelay && (isOperation
    ? isFirestoreReadOp(msg.method)
    : msg.t === 'sub'
      && msg.target !== null
      && typeof msg.target === 'object'
      && '__ref' in msg.target);
  const prov = opProvenance(
    msg,
    tracksFirestoreActivity ? activityJourneyId(ctx, targetPort) : undefined,
  );
  const runWithProvenance = ctx.sandbox.runWithProvenance;
  const hasProvenanceRunner = prov !== undefined && runWithProvenance !== undefined;
  if (hasProvenanceRunner) {
    await runWithProvenance.call(ctx.sandbox, prov, () => dispatchMessage(ctx, targetPort, msg));
    return;
  }
  return dispatchMessage(ctx, targetPort, msg);
}

function refuseDeletedMessage(port: PortLike, msg: InboundMessage): void {
  const isOperation = msg.t === 'op' || msg.t === 'tool';
  const isDataSubscription = msg.t === 'sub' && msg.target !== 'events';
  const error = { code: 'app/app-deleted', message: 'Firebase App was deleted' };
  if (isOperation) {
    fail(port, msg.id, Object.assign(new Error(error.message), error));
  } else if (isDataSubscription) {
    port.postMessage({ t: 'snap', subId: msg.subId, value: { __error: error } });
  }
}

async function dispatchMessage(
  ctx: HostCtx,
  port: PortLike,
  msg: InboundMessage,
): Promise<void> {
  const isOperation = msg.t === 'op';
  const isSubscription = msg.t === 'sub';
  const isUnsubscribe = msg.t === 'unsub';
  const isDisconnect = msg.t === 'disconnect';
  const isClockSubscription = msg.t === 'clock-subscribe';
  const isTool = msg.t === 'tool';
  if (isOperation) {
    const isActionCode = isAuthActionCodeOp(msg);
    const isCustomToken = msg.method === 'auth.signInWithCustomToken';
    const isAuth = isAuthOp(msg.method);
    const isAi = isAiOp(msg.method);
    const isMessaging = isMessagingOp(msg.method);
    if (isActionCode) {
      await handleAuthActionCodeOp(ctx, port, msg);
    } else if (isCustomToken) {
      await handleCustomTokenSignIn(ctx, port, msg);
    } else if (isAuth) {
      await handleAuthOp(ctx, port, msg);
    } else if (isAi) {
      await handleAiOp(ctx, port, msg);
    } else if (isMessaging) {
      await handleMessagingOp(ctx, port, msg);
    } else {
      await handleOp(ctx, port, msg);
    }
  } else if (isSubscription) {
    const isAuth = isAuthSub(msg);
    const isEvent = isEventSub(msg);
    const isRtdb = isRtdbSub(msg);
    const isAi = isAiSub(msg);
    const isMessaging = isMessagingSub(msg);
    const isPresence = isPresenceSub(msg);
    if (isAuth) {
      handleAuthSub(ctx, port, msg);
    } else if (isEvent) {
      handleEventSub(ctx, port, msg);
    } else if (isRtdb) {
      handleRtdbSub(ctx, port, msg);
    } else if (isAi) {
      // AI streams are FINITE subs registered in ctx.subs (so `unsub` cancels
      // them); they auto-unsub on the terminal done/error snap. host-ai.ts.
      handleAiSub(ctx, port, msg);
    } else if (isMessaging) {
      handleMessagingSub(ctx, port, msg);
    } else if (isPresence) {
      handlePresenceSub(ctx, port, msg);
    } else {
      handleSub(ctx, port, msg);
    }
  } else if (isUnsubscribe) {
    // An unsub may target an auth sub, an event-stream sub, a presence sub, or
    // a Firestore listener — try the cheap routing registries first, then fall
    // through to the Firestore listener teardown.
    const needsFirestoreUnsubscribe =
      !handleAuthUnsub(ctx, port, msg.subId) &&
      !handleEventUnsub(ctx, port, msg.subId) &&
      !handlePresenceUnsub(ctx, port, msg.subId);
    if (needsFirestoreUnsubscribe) {
      handleUnsub(ctx, port, msg);
    }
  } else if (isDisconnect) {
    try {
      await cleanupPortWithDisconnect(ctx, port);
      ok(port, msg.id, undefined);
    } catch (error) {
      fail(port, msg.id, error);
    }
  } else if (isClockSubscription) {
    subscribeClock(ctx, port);
  } else if (isTool) {
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
  // to tear down), its per-port session, and its retained subscription intents
  // (#754).
  attempt(() => { authSubsFor(ctx).delete(port); });
  attempt(() => { cleanupPortSession(ctx, port); });
  attempt(() => { dropPortSubscriptionIntents(ctx, port); });

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
  attempt(() => { unsubscribeClock(ctx, port); });

  const portSubs = ctx.subs.get(port);
  const hasPortSubscriptions = portSubs !== undefined;
  if (hasPortSubscriptions) {
    for (const unsub of portSubs.values()) attempt(unsub);
    ctx.subs.delete(port);
  }
  const hasOneFailure = failures.length === 1;
  if (hasOneFailure) throw failures[0];
  const hasMultipleFailures = failures.length > 1;
  if (hasMultipleFailures) {
    throw new AggregateError(failures, 'Multiple SharedWorker port resources failed to tear down');
  }
}

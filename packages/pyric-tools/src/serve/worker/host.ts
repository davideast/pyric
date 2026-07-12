/**
 * SharedWorker host — op handlers and subscription registry.
 *
 * WHY INJECTED DEPS
 * -----------------
 * The host is deliberately decoupled from `SharedWorkerGlobalScope` so
 * unit tests can drive it with a REAL pyric sandbox + fake MessagePort
 * objects — no browser or SharedWorker runtime required. The entry point
 * (`entry.ts`) creates the real sandbox + db and wires the connecting ports
 * to this module.
 *
 * ARCHITECTURE
 * ------------
 * One `HostCtx` is shared across ALL connected ports. It holds:
 *   - `db` — the single modular Firestore handle (from pyric/firestore's
 *     `getFirestore(sandbox)` — sandbox-live mode so auth changes propagate).
 *   - `sandbox` — the underlying Sandbox, needed for `setRules` and for
 *     constructing sentinels via FieldValue.
 *   - `subs` — per-port subscription registry: Map<PortLike, Map<subId, unsub>>
 *
 * Each connecting port calls `handleMessage(ctx, port, msg)`. The function
 * is exported so tests can call it directly.
 *
 * SENTINEL RESOLUTION
 * -------------------
 * Write data crossing the port may contain `SentinelMarker` objects
 * (`{ __sentinel: 'serverTimestamp' }` etc.). Before passing data to the
 * sandbox we walk the payload and replace each marker with the real
 * FieldValue object from `pyric/firestore`'s sentinel factories. The
 * sandbox's value-resolver then executes them as usual.
 *
 * SUBSCRIPTION FAN-OUT
 * --------------------
 * Because all ports share ONE sandbox, an onSnapshot listener registered
 * via the sandbox automatically fires for writes from ANY port. We just
 * need to forward the snapshot to the correct originating port(s).
 *
 * TRANSACTIONS + READ-SET VALIDATION
 * ------------------------------------
 * `runTransaction` on the worker is the full-fidelity path: the host calls
 * the sandbox's `runTransaction`, which runs the update function, handles
 * optimistic-concurrency retries, and commits atomically. The client now
 * sends a `reads` array alongside `writes`; the worker re-reads each doc
 * inside the sandbox transaction and validates that no concurrent write
 * changed any of them between the client's read and this commit. A mismatch
 * signals `{ code: 'aborted' }` on the wire so the client can re-run
 * `updateFn` — see `txnCommit` handler for full details.
 */

import type {
  InboundMessage,
  OpMessage,
  ToolMessage,
} from './protocol.js';
import {
  isAuthSub,
  isEventSub,
  isRtdbSub,
  isAiSub,
  isMessagingSub,
} from './protocol.js';
// The canonical agent tool dispatcher — reused on the worker so a bridged agent
// executes against THIS sandbox (one backend for app + Studio + agent), instead
// of a separate in-page sandbox.
import { buildSandboxDispatcher } from '../../bridge/client/dispatch.js';

import { type HostCtx, type PortLike, ok, fail } from './host-context.js';
import {
  authSubsFor,
  isAuthOp,
  handleAuthOp,
  handleAuthSub,
  handleAuthUnsub,
  cleanupPortSession,
} from './host-auth.js';
import {
  eventSubsFor,
  handleEventSub,
  handleEventUnsub,
} from './host-events.js';
import { isAiOp, handleAiOp, handleAiSub } from './host-ai.js';
import {
  isMessagingOp,
  handleMessagingOp,
  handleMessagingSub,
  cleanupPortMessaging,
} from './host-messaging.js';
import {
  lensDb,
  lensProvenance,
  sessionDb,
  opProvenance,
} from './host/core.js';
import { isFirestoreReadOp, handleFirestoreReadOp } from './host/firestore-reads.js';
import { isFirestoreWriteOp, handleFirestoreWriteOp } from './host/firestore-writes.js';
import { isRulesOp, handleRulesOp } from './host/rules.js';
import { isAdminFirestoreOp, handleAdminFirestoreOp } from './host/admin-firestore.js';
import { isRtdbOp, handleRtdbOp } from './host/rtdb.js';
import { isStorageOp, handleStorageOp } from './host/storage.js';
import { isConnectionOp, handleConnectionOp } from './host/connection.js';
import { isStudioOp, handleStudioOp } from './host/studio.js';
import { handleSub, handleRtdbSub, handleUnsub, dropPortSessionSubs } from './host/subscriptions.js';

// Re-export so host.ts's public surface is unchanged after the decomposition.
export { ensureAuth, portSession } from './host-auth.js';
export type { HostCtx, PortLike } from './host-context.js';
// Instance-id + named-branch surface (part of the host's public shape:
// serve-init imports getOrCreateInstanceId; tests import the rest).
export {
  INSTANCE_ID_KEY,
  randomUuid,
  getOrCreateInstanceId,
  BRANCH_PREFIX,
  BRANCH_REGISTRY_KEY,
  listBranchNames,
} from './host/connection.js';

// ─── Op handlers ──────────────────────────────────────────────────────────

async function handleOp(ctx: HostCtx, port: PortLike, msg: OpMessage): Promise<void> {
  // Explicit lens (Studio admin / as / app-session) → lensDb; no lens → the
  // PORT'S SESSION (#754), so app ops run as whoever this tab signed in as.
  const db = msg.actAs ? lensDb(ctx, msg.actAs) : sessionDb(ctx, port);
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

  // Auth (`auth.*`), AI (`ai.*`), and messaging (`messaging.*`) ops are routed
  // to their handlers by dispatchMessage BEFORE reaching handleOp, so any
  // method landing here is genuinely unknown.
  fail(port, msg.id, new Error(`Unknown method: ${String((msg as { method: unknown }).method)}`));
}

// ─── Main dispatch ────────────────────────────────────────────────────────

/**
 * Handle one inbound message from a port.
 *
 * This is the primary unit-testable seam. Tests create a real `HostCtx`
 * backed by an in-memory pyric sandbox and call this function directly
 * with fake port objects, exercising the full op+subscription lifecycle
 * without a real SharedWorker.
 */
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

export async function handleMessage(
  ctx: HostCtx,
  port: PortLike,
  msg: InboundMessage,
): Promise<void> {
  // Op provenance, bound at dispatch by `opProvenance` (see its docs). Opened
  // as the sandbox's SYNCHRONOUS ambient window so firestore/rtdb/auth emits —
  // which run inside `dispatchMessage` before any await — pick it up. Storage
  // ops emit AFTER async awaits, outside this window, so they thread the same
  // provenance EXPLICITLY instead (see `handleOp`'s storage cases). Without the
  // lens on admin ops, `verdictFor` mislabeled a rules BYPASS as ALLOW (the
  // RTDB/Firestore asymmetry the traffic-metrics work flagged).
  const prov = opProvenance(msg);
  if (prov && ctx.sandbox.runWithProvenance) {
    return ctx.sandbox.runWithProvenance(prov, () => dispatchMessage(ctx, port, msg));
  }
  return dispatchMessage(ctx, port, msg);
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
    } else {
      handleSub(ctx, port, msg);
    }
  } else if (msg.t === 'unsub') {
    // An unsub may target an auth sub, an event-stream sub, or a Firestore
    // listener — try the cheap routing registries first, then fall through to
    // the Firestore listener teardown.
    if (
      !handleAuthUnsub(ctx, port, msg.subId) &&
      !handleEventUnsub(ctx, port, msg.subId)
    ) {
      handleUnsub(ctx, port, msg);
    }
  } else if (msg.t === 'tool') {
    await handleTool(ctx, port, msg);
  }
}

// ─── Port cleanup ─────────────────────────────────────────────────────────

/**
 * Tear down all subscriptions for a disconnected port.
 * Called when a port's `close` event fires (browser best-effort) or
 * when the entry point explicitly cleans up a port.
 */
export function cleanupPort(ctx: HostCtx, port: PortLike): void {
  // Drop the port's auth subscriptions (routing entries — no real listener
  // to tear down), its per-port session, and its session-bound sub records
  // (#754).
  authSubsFor(ctx).delete(port);
  cleanupPortSession(ctx, port);
  dropPortSessionSubs(ctx, port);

  // Drop the port's event-stream subscriptions too (also routing entries off
  // the single shared `sandbox.onEvent` subscription — nothing to unsubscribe,
  // just stop fanning out to a dead port).
  eventSubsFor(ctx).delete(port);

  // Drop the port's messaging broker client so a closed tab's last-reported
  // visibility stops feeding the routing rule. Its delivery-handler unsubs
  // live in `ctx.subs` and are torn down with the loop below.
  cleanupPortMessaging(ctx, port);

  const portSubs = ctx.subs.get(port);
  if (!portSubs) return;
  for (const unsub of portSubs.values()) {
    unsub();
  }
  ctx.subs.delete(port);
}

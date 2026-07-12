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

import {
  onSnapshot,
  SandboxError,
  type DocumentReference,
  type CollectionReference,
  type Query,
} from 'pyric/firestore';
import type { Sandbox, PersistenceBackend } from 'pyric/sandbox';
import { serializeToBuckets, bundleRecords, parseBundle, deserializeFromBuckets } from 'pyric/sandbox';
import {
  ref as rtdbRef,
  onValue as rtdbOnValue,
  type DatabaseReference,
} from 'pyric/database/modular';

import type {
  InboundMessage,
  OpMessage,
  FirestoreSubMessage,
  RtdbValueSubMessage,
  UnsubMessage,
  ToolMessage,
} from './protocol.js';
import {
  serializeError,
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

import { type HostCtx, type PortLike, post, ok, fail } from './host-context.js';
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
  resolveTarget,
  serializeDocSnap,
  lensDb,
  lensProvenance,
  sessionDb,
  lensRtdb,
  opProvenance,
} from './host/core.js';
import { isFirestoreReadOp, handleFirestoreReadOp } from './host/firestore-reads.js';
import { isFirestoreWriteOp, handleFirestoreWriteOp } from './host/firestore-writes.js';
import { isRulesOp, handleRulesOp } from './host/rules.js';
import { isAdminFirestoreOp, handleAdminFirestoreOp } from './host/admin-firestore.js';
import { isRtdbOp, handleRtdbOp, rtdbSnapToWire } from './host/rtdb.js';
import { isStorageOp, handleStorageOp } from './host/storage.js';

// Re-export so host.ts's public surface is unchanged after the decomposition.
export { ensureAuth, portSession } from './host-auth.js';
export type { HostCtx, PortLike } from './host-context.js';

/** Build hash injected by the bundler's esbuild `define`. Undefined when the
 *  compiled host is imported directly (tests) — guarded with `typeof`. */
declare const __PYRIC_WORKER_VERSION__: string;

/**
 * Per-SharedWorker instance id — generated once and persisted to the RAW idb
 * (local-only, like the session record above; it must NEVER reach the
 * committable server file). Because IndexedDB is per (origin + browser profile),
 * two profiles on the same `localhost:<port>` get two distinct ids — which is
 * exactly how the UI tells same-port-different-profile sandboxes apart.
 */
export const INSTANCE_ID_KEY = 'pyric:worker:instance';

/**
 * `crypto.randomUUID()` is secure-context-only (https or localhost), so it is
 * `undefined` over plain http on a non-localhost host (a Tailscale or LAN
 * hostname). `crypto.getRandomValues` is NOT gated, so build a v4 UUID from it as
 * the fallback. Without this the worker throws on init over Tailscale and the
 * whole sandbox (auth, firestore, bridge) silently fails to come up.
 */
export function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
}

export async function getOrCreateInstanceId(idb: PersistenceBackend): Promise<string> {
  const rec = (await idb.getRecord(INSTANCE_ID_KEY, 'id')) as { value?: string } | undefined;
  if (rec && typeof rec.value === 'string') return rec.value;
  const id = randomUuid();
  await idb.putRecords(INSTANCE_ID_KEY, new Map([['id', { value: id }]]));
  return id;
}

// ── Phase 3: named branches ─────────────────────────────────────────────────
// A branch is a named saved state bundle in the RAW idb (local-only, like the
// instance id + session; it must NEVER reach the committable server file). They
// let one instance keep several named states it can switch between
// (switchBranch = loadSnapshot the bundle, a clobber). A registry record holds
// the ordered name list, since the backend lists records WITHIN a key, not keys.
export const BRANCH_PREFIX = 'pyric:worker:branch:';
export const BRANCH_REGISTRY_KEY = 'pyric:worker:branches';

export async function listBranchNames(idb?: PersistenceBackend): Promise<string[]> {
  if (!idb) return [];
  const rec = (await idb.getRecord(BRANCH_REGISTRY_KEY, 'names')) as { value?: string[] } | undefined;
  return Array.isArray(rec?.value) ? rec.value : [];
}

async function writeBranchRegistry(idb: PersistenceBackend, names: string[]): Promise<void> {
  await idb.putRecords(BRANCH_REGISTRY_KEY, new Map([['names', { value: names }]]));
}

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

  switch (msg.method) {
    case 'getVersion': {
      // The build hash is injected by the bundler (esbuild `define`). `typeof`
      // guards the non-bundled path (tests import the compiled host directly,
      // where the global is undefined) → reports 'dev'.
      ok(port, msg.id, {
        version: typeof __PYRIC_WORKER_VERSION__ !== 'undefined' ? __PYRIC_WORKER_VERSION__ : 'dev',
        instanceId: ctx.instanceId,
      });
      break;
    }

    case 'exportState': {
      // Phase 2 (transfer): serialize the FULL sandbox state to a portable bundle
      // string using the SAME chunk format the persist layer uses, so wrapper
      // types (Timestamp / Bytes / GeoPoint / VectorValue) round-trip. The string
      // crosses the MessagePort cleanly (unlike the raw snapshot object).
      const snap = ctx.sandbox.snapshot();
      ok(port, msg.id, { bundle: bundleRecords(serializeToBuckets(snap.firestore, snap.services, 0)) });
      break;
    }

    case 'importState': {
      // Phase 2 (clobber): replace this sandbox's ENTIRE state with the imported
      // bundle via the public loadSnapshot() (reset + rebuild firestore + restore
      // services; listeners re-evaluate, persist re-flushes).
      ctx.sandbox.loadSnapshot(deserializeFromBuckets(parseBundle(msg.bundle)));
      ok(port, msg.id, { ok: true });
      break;
    }

    case 'saveBranch': {
      // Phase 3: snapshot the live sandbox into a named branch bundle (raw idb).
      if (!ctx.sessionBackend) {
        ok(port, msg.id, { ok: false, error: 'no persistence backend' });
        break;
      }
      const snap = ctx.sandbox.snapshot();
      const bundle = bundleRecords(serializeToBuckets(snap.firestore, snap.services, 0));
      await ctx.sessionBackend.putRecords(BRANCH_PREFIX + msg.name, new Map([['bundle', { value: bundle }]]));
      const names = await listBranchNames(ctx.sessionBackend);
      if (!names.includes(msg.name)) await writeBranchRegistry(ctx.sessionBackend, [...names, msg.name]);
      ok(port, msg.id, { ok: true });
      break;
    }

    case 'listBranches': {
      ok(port, msg.id, { branches: await listBranchNames(ctx.sessionBackend) });
      break;
    }

    case 'switchBranch': {
      // Phase 3: loadSnapshot the named branch bundle (a clobber).
      const rec = ctx.sessionBackend
        ? ((await ctx.sessionBackend.getRecord(BRANCH_PREFIX + msg.name, 'bundle')) as { value?: string } | undefined)
        : undefined;
      if (!rec?.value) {
        ok(port, msg.id, { ok: false, error: `no such branch: ${msg.name}` });
        break;
      }
      ctx.sandbox.loadSnapshot(deserializeFromBuckets(parseBundle(rec.value)));
      ok(port, msg.id, { ok: true });
      break;
    }

    case 'deleteBranch': {
      if (ctx.sessionBackend) {
        await ctx.sessionBackend.clear(BRANCH_PREFIX + msg.name);
        await writeBranchRegistry(
          ctx.sessionBackend,
          (await listBranchNames(ctx.sessionBackend)).filter((n) => n !== msg.name),
        );
      }
      ok(port, msg.id, { ok: true });
      break;
    }

    case 'setPolicy': {
      // Store the dial's PolicyRequest as the worker-side runtime governance
      // (Pyric Studio F3). This is the source of truth Studio reflects + a
      // future in-worker agent runtime consults. It does NOT push into a
      // running bridge process — see the limitation note on `ctx.policy` /
      // `PolicyRequest`. Additive + idempotent: last write wins.
      ctx.policy = msg.policy;
      ok(port, msg.id, null);
      break;
    }

    case 'getPolicy': {
      // Read back the active runtime policy (null until the dial set one), so
      // Studio can reflect persisted state across reconnects within a worker
      // lifetime and a freshly-connecting port can hydrate the dial.
      ok(port, msg.id, ctx.policy ?? null);
      break;
    }

    case 'getSnapshot': {
      // Export the current sandbox snapshot (Pyric Studio rules re-run): Studio
      // forks it locally to test edited rules / re-issue as the user on a branch.
      ok(port, msg.id, ctx.sandbox.snapshot());
      break;
    }

    default: {
      // Auth ops (`auth.*`) and AI ops (`ai.*`) are routed to handleAuthOp /
      // handleAiOp by handleMessage before reaching here, so any method
      // landing in this default is genuinely unknown. (We can't use a `never` exhaustiveness check anymore because
      // OpMessage now includes the auth variants this switch deliberately skips.)
      fail(port, msg.id, new Error(`Unknown method: ${String((msg as { method: unknown }).method)}`));
    }
  }
}

// ─── Subscription handler ─────────────────────────────────────────────────

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

function handleSub(ctx: HostCtx, port: PortLike, msg: FirestoreSubMessage): void {
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

function handleRtdbSub(ctx: HostCtx, port: PortLike, msg: RtdbValueSubMessage): void {
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

function handleUnsub(ctx: HostCtx, port: PortLike, msg: UnsubMessage): void {
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
  _sessionSubs.get(ctx)?.delete(port);

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

// ─── Internal helpers ─────────────────────────────────────────────────────

function ensurePortSubs(ctx: HostCtx, port: PortLike): void {
  if (!ctx.subs.has(port)) {
    ctx.subs.set(port, new Map());
  }
}

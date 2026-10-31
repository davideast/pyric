/**
 * `connectRemoteSandbox()` — Node-side client for the browser-hosted
 * SharedWorker sandbox (remote sandbox, slice 1 / checkpoint 1).
 *
 * Server-side Node code (ultimately `pyric-admin`'s remote dispatch arm)
 * reaches the ONE sandbox the app + Studio + agent share:
 *
 *   Node process -> `pyric sandbox --bridge` -> browser tab
 *                 (attach/consumer leg)        (peer leg)
 *                                        ──MessagePort──> SharedWorker
 *
 * DISCOVERY mirrors `pyric mcp-proxy` (`serve/discovery.ts`): the
 * `.pyric/serve.json` pointer in cwd, health-probed across both loopback
 * families with the pointer's `instanceId` pinned so a cross-family
 * port-squatter can't split-brain the connection.
 *
 * FAIL-FAST, NEVER FALL BACK: when no browser tab is connected the connect
 * (and every later op that races a closing tab) fails with a clear
 * "open <serve url>" error. There is deliberately NO silent in-process
 * fallback — a silently split backend is exactly the failure this client
 * exists to avoid.
 *
 * SUBSCRIPTION OWNERSHIP: the bridge process owns the durable sub registry
 * and re-issues it to every newly registered peer (tab refresh/replacement),
 * so a subscription made here survives peer churn — RTDB value semantics
 * make the replay safe (each resubscribe re-delivers a fresh snapshot;
 * consumers are last-value-wins).
 *
 * RECONNECT: the lazy handle (`remoteSandbox`, what `@pyric/cli/register`
 * installs) treats a host that drops an attached connection, such as a hosted
 * Vite dev server restarting on a config edit, as a lost connection, and
 * reconnects on ADR 0019's backoff (#949, #1107). Live listeners are
 * resubscribed. An RTDB write or read in flight at the drop is sent again on
 * the next connection, as the SDK does; other calls in flight fail once. A
 * call issued while the connection is lost waits up to 10 seconds for it and
 * is then sent once, or fails unsent. Before the first attach, a failed
 * connect still fails the call. The eager `connectRemoteSandbox` handle does
 * not reconnect.
 *
 * NODE-ONLY: uses `ws` and `node:fs` — exported via a `node`-conditional
 * subpath (`@pyric/cli/remote`), never bundled for the browser.
 */
import { WebSocket } from 'ws';
import { Socket } from 'node:net';
import type { AuthUserRecord, CreateUserRequest, UpdateUserRequest } from 'pyric/auth';
import type { FullMetadata } from 'pyric/storage';
import { fetchFromByteRoute, uploadOverByteRoute, type RemoteByteRoute } from 'pyric/storage/internal';
import {
  REMOTE_SANDBOX,
  SandboxContextImpl,
  type RemoteSandbox as RemoteSandboxBase,
  type AuthState,
  type SandboxContext,
} from 'pyric/sandbox';
import type {
  BridgeMessage,
  WorkerOpPayload,
  WorkerSubPayload,
} from '../bridge/protocol.js';
import { isBridgeMessage, MAX_BRIDGE_FRAME_BYTES, NO_SANDBOX_ERROR_MESSAGE, STORAGE_BYTE_ROUTE_CAPABILITY } from '../bridge/protocol.js';
import { encodeBridgeMessage } from '../bridge/frame-output.js';
import { createOperationBudget } from '../bridge/operation-budget.js';
import { watchHostLiveness, type HostLiveness } from './host-liveness.js';
import { createHeldCalls, type ReleasedOp } from './held-calls.js';
import { MAX_STORAGE_OP_BYTES, storagePayloadTooLarge } from '../serve/worker/protocol.js';
import { hasValidAttachFields } from '../bridge/attach-validation.js';
import { hasValidReplyOutcome, snapshotError } from '../serve/worker/outbound-validation.js';
import { rtdbFateAtDrop, type DropFate } from '../serve/worker/rtdb-drop-fates.js';
import type { AnsweringHost, Discovered } from '../serve/discovery.js';
import { resolveRemoteHost } from './resolve-host.js';
import { versionSkewGuidance as skewGuidance } from './version-skew.js';

/** Sits just above the bridge's own 30s `callTimeoutMs` so a legitimately
 *  slow worker op still completes (same layering as `mcp-proxy`'s 35s). */
const DEFAULT_OP_TIMEOUT_MS = 35_000;

/** How long the attach handshake may take before connect() fails. */
const ATTACH_TIMEOUT_MS = 5_000;

/** Why an op in flight at a drop failed: the host may have applied it. */
const CONNECTION_LOST = 'The remote sandbox connection was lost. Requests already sent may have completed; check state before retrying.';

function remoteError(
  code: string,
  message: string,
  denialContext?: unknown,
  envelope?: unknown,
): Error & { code: string; denialContext?: unknown; envelope?: unknown } {
  const err = new Error(message) as Error & { code: string; denialContext?: unknown; envelope?: unknown };
  err.code = code;
  // Structured denial context (spike gap 6): a relayed permission-denied
  // carries the same "why did this deny" frame a local SandboxError has —
  // plain JSON off the wire, re-attached here.
  if (denialContext !== undefined) err.denialContext = denialContext;
  if (envelope !== undefined) err.envelope = envelope;
  return err;
}

function noTabError(serveUrl: string): Error & { code: string } {
  return remoteError(
    'unavailable',
    `no browser tab is connected to the sandbox — open ${serveUrl} in a browser and retry.`,
  );
}

/** An app server that persisted a production download URL asks for the URL the
 *  host it reaches serves for the same object. */
export { localStorageUrl } from './local-storage-url.js';
export type { ReleasedOp } from './held-calls.js';

// ─── Public types ──────────────────────────────────────────────────────────

export interface ConnectRemoteSandboxOptions {
  /** Project root for `.pyric/serve.json` discovery. Default: `process.cwd()`. */
  cwd?: string;
  /** Explicit serve base URL (e.g. `http://127.0.0.1:5000`) — skips discovery. */
  url?: string;
  /**
   * Serve base URL from configuration (`PYRIC_SANDBOX=remote:<url>`), which may
   * be stale. It is used when the host answering there is this project's host
   * or the one `instanceId` pins. Otherwise the connect falls back to this
   * project's running host, with one warning per URL, or fails naming the URL
   * as stale. Ignored when `url` is set.
   */
  configuredUrl?: string;
  /** Host identity the launcher that set `configuredUrl` pinned (`PYRIC_SANDBOX_INSTANCE`). */
  instanceId?: string;
  /** Discovery of this project's host. Injected in tests; defaults to the shared serve discovery. */
  discover?: (cwd: string) => Promise<Discovered | null>;
  /** Health probe of an explicit `url`. Injected in tests. */
  probe?: (url: string) => Promise<AnsweringHost | null>;
  /** Where the stale-URL fallback warning goes. Default: stderr. */
  warn?: (message: string) => void;
  /** Per-op timeout in ms on the Node side (default 35s, above the bridge's 30s). */
  opTimeoutMs?: number;
  /**
   * Called once when an attached connection closes without the client asking
   * (the host stopped or restarted). When set, the close settles each op in
   * flight by its fate at a drop and hands the caller, as `resend`, the RTDB
   * writes and reads to send again on its next connection; it leaves listeners
   * quiet, so the caller can reconnect and resubscribe them. When absent, the
   * close rejects every pending op and ends every listener with `unavailable`.
   */
  onConnectionLost?: (reason: string, resend: ReleasedOp[]) => void;
}

/**
 * The raw relay channel: any worker-protocol op or snap-delivering
 * subscription, verbatim. The typed conveniences below are built on this;
 * checkpoint 2's `pyric-admin` remote-dispatch arm consumes it directly.
 */
export interface RemoteSandboxChannel {
  /** Dispatch one worker op. Resolves with the worker's `res.value`;
   *  rejects with an Error carrying `.code`. NOTE: callers choose their own
   *  `actAs` lens — nothing is pinned here. */
  op(op: WorkerOpPayload): Promise<unknown>;
  /**
   * Register a worker subscription. `onSnap` receives each snap value;
   * an establishment failure (the worker host's `{ __error }` snap) routes
   * to `onError` instead. Returns the unsubscribe function.
   */
  subscribe(
    sub: WorkerSubPayload,
    onSnap: (value: unknown) => void,
    onError?: (err: Error & { code: string }) => void,
  ): () => void;
  /**
   * The host's HTTP byte route for Storage bytes, once attached, or undefined
   * when the host takes bytes as frames (a browser tab's SharedWorker).
   */
  byteRoute?(): Promise<RemoteByteRoute | undefined>;
}

/** Wire shape of an RTDB snapshot as the worker host serializes it. */
export interface RemoteRtdbSnapshot {
  key: string | null;
  exists: boolean;
  value: unknown;
  size: number;
}

/**
 * Thin RTDB conveniences over the channel. Every call pins
 * `actAs: { mode: 'admin' }` — firebase-admin's rules-bypass semantics,
 * matching what `pyric-admin`'s database backend needs. Use the raw
 * `channel` for lensed (rules-evaluated) access.
 */
export interface RemoteRtdb {
  /** Read the value at `path` (null when absent). */
  get(path: string): Promise<unknown>;
  set(path: string, value: unknown): Promise<void>;
  update(path: string, values: Record<string, unknown>): Promise<void>;
  remove(path: string): Promise<void>;
  /** Push `value` under a CLIENT-minted 20-char push id (the worker-protocol
   *  contract: `rtdb.push` carries the key, so `.key` is known synchronously
   *  on the pyric-admin side). Resolves with the minted key + full path. */
  push(path: string, value?: unknown): Promise<{ key: string; path: string }>;
  /** Subscribe to the value at `path` (initial snapshot + every change). */
  onValue(
    path: string,
    callback: (snapshot: RemoteRtdbSnapshot) => void,
    onError?: (err: Error & { code: string }) => void,
  ): () => void;
  /** The same conveniences on the RTDB instance named `name`. */
  forInstance(name: string): RemoteRtdb;
}

/**
 * Thin Storage conveniences over the channel: bytes plus browse/metadata.
 * Every call pins `actAs: { mode: 'admin' }` (firebase-admin's rules-bypass
 * semantics, matching {@link RemoteRtdb}); use the raw `channel` for lensed
 * (rules-evaluated) access. A host with an HTTP byte route moves bytes there
 * with no size cap; a host without one takes base64 frames capped at 8 MiB
 * raw ({@link MAX_STORAGE_OP_BYTES}) on both ends.
 */
export interface RemoteStorage {
  /** Upload `data` at `path` (replaces any existing object). Resolves with
   *  the stored object's `FullMetadata`. */
  putBytes(
    path: string,
    data: Uint8Array,
    options?: { contentType?: string; metadata?: Record<string, unknown> },
  ): Promise<FullMetadata>;
  /** Download the object's bytes. Rejects `storage/object-not-found` when
   *  absent, `payload-too-large` when over the op cap. */
  getBytes(path: string): Promise<Buffer>;
  /** Delete the object at `path`. Idempotent (missing = no-op). */
  deleteObject(path: string): Promise<void>;
  /** Read the object's `FullMetadata`. */
  getMetadata(path: string): Promise<FullMetadata>;
  /** Does an object exist at `path`? (`getMetadata` with not-found → false.) */
  exists(path: string): Promise<boolean>;
  /** Enumerate immediate child items + prefixes under `path`. */
  listAll(path: string): Promise<{
    items: Array<{ fullPath: string; name: string }>;
    prefixes: Array<{ fullPath: string; name: string }>;
  }>;
}

/** Admin auth user-CRUD passthrough (never lensed — auth ops operate the
 *  worker's user pool directly, mirroring `pyric/auth`'s sandbox ops). */
export interface RemoteAuthAdmin {
  listUsers(): Promise<AuthUserRecord[]>;
  createUser(request: CreateUserRequest): Promise<AuthUserRecord>;
  updateUser(uid: string, request: UpdateUserRequest): Promise<AuthUserRecord>;
  deleteUser(uid: string): Promise<void>;
  clearUsers(): Promise<void>;
}

/**
 * The Node-side remote sandbox handle. Extends `pyric/sandbox`'s branded
 * {@link RemoteSandboxBase} — structurally a full `Sandbox`, so it can be
 * passed to `pyric-admin/app`'s `initializeApp({ sandbox })`, whose RTDB and
 * Auth backends dispatch on the brand and route through {@link channel}.
 *
 * Sandbox members that are genuinely sync-only (`admin`, `snapshot()`,
 * `history()`, `onEvent`, `currentUser`, …) cannot be mirrored over the
 * wire in slice 1 and throw a remediating `unimplemented` error naming
 * what to do instead. Implemented members: `withAuth` (pure local pair
 * construction) and `dispose` (aliases {@link close}).
 */
export interface RemoteSandbox extends RemoteSandboxBase {
  /** The raw worker op/sub relay channel (narrowed to the wire payload types). */
  readonly channel: RemoteSandboxChannel;
  /** RTDB conveniences (admin lens pinned). */
  readonly rtdb: RemoteRtdb;
  /** Storage conveniences (admin lens pinned). */
  readonly storage: RemoteStorage;
  /** Admin auth user CRUD. */
  readonly auth: RemoteAuthAdmin;
  /** Close the connection. In-flight ops reject, except an RTDB onDisconnect, which never settles; subscriptions stop. */
  close(): void;
}

// ─── Core (transport-injected — the test seam) ─────────────────────────────

/** Minimal transport the core writes to. `connectRemoteSandbox` adapts a
 *  `ws` socket; tests inject an in-process pipe to a `ConsumerSession`. */
export interface RemoteTransport {
  send(msg: BridgeMessage): void;
  /**
   * OPTIONAL event-loop hold hooks (exit-hang fix). The WS adapter unrefs
   * its socket once connected so an IDLE remote client never pins the Node
   * event loop (a finished script exits); the core calls `ref()` when work
   * becomes outstanding (first pending op / live subscription) and
   * `unref()` when the last one settles, so in-flight delivery keeps the
   * process alive. Pure in-process transports (tests) may omit both.
   */
  ref?(): void;
  unref?(): void;
}

export interface RemoteSandboxCore {
  /** Feed one parsed message from the transport into the core. */
  handleMessage(msg: BridgeMessage): void;
  /** Send the attach handshake. `ready` settles on the ack. */
  start(): void;
  /** The capabilities the attach acknowledgement advertised. */
  capabilities(): readonly string[];
  /** Resolves on `attach-ack`; rejects when no browser tab is connected. */
  ready: Promise<void>;
  channel: RemoteSandboxChannel;
  /** Report a transport failure to pending calls and active listeners, as `code` (default `unavailable`); an onDisconnect stays unsettled. */
  fail(reason: string, code?: string): void;
  /** Close explicitly; reject pending calls (as `code`, default `unavailable`) except an onDisconnect, which stays unsettled, and quietly detach listeners. Idempotent. */
  dispose(reason?: string, code?: string): void;
  /**
   * Settle a drop the caller reconnects from: every call in flight meets its
   * fate (`fateAtDrop`), listeners detach quietly, and the calls to send again
   * are returned unsettled, in issue order. Idempotent: a second call returns
   * none.
   */
  releaseInFlight(lostMessage: string): ReleasedOp[];
}

/** An `rtdb.push` carries its key when `pyric-admin` minted it; one without asks the host to mint it. */
function isKeylessPush(payload: WorkerOpPayload): boolean {
  const isPush = payload.method === 'rtdb.push';
  if (!isPush) return false;
  return payload.key === undefined;
}

/**
 * What becomes of a call in flight at a drop. RTDB calls follow the shared
 * table, as on the web hosted client, except a push without a key: sent
 * again, the host would mint a second key and add a second child.
 */
function fateAtDrop(payload: WorkerOpPayload): DropFate {
  if (isKeylessPush(payload)) return 'fail';
  return rtdbFateAtDrop(payload.method);
}

/**
 * Transport-agnostic client core: correlation ids/subIds are minted HERE
 * (this leg's id space; the bridge re-mints for the peer leg), pending ops
 * carry a Node-side timeout above the bridge's 30s, and `{ __error }` snap
 * values are routed to the subscription's error handler.
 */
export function createRemoteSandboxCore(
  transport: RemoteTransport,
  opts: { serveUrl: string; opTimeoutMs?: number },
): RemoteSandboxCore {
  const serveUrl = opts.serveUrl;
  const opTimeoutMs = opts.opTimeoutMs ?? DEFAULT_OP_TIMEOUT_MS;

  const operationBudget = createOperationBudget();
  let opCounter = 0;
  let subCounter = 0;
  let disposed: string | null = null;
  let advertised: readonly string[] = [];

  const pending = new Map<string, ReleasedOp & { timer: ReturnType<typeof setTimeout> }>();
  const subs = new Map<
    string,
    { onSnap: (value: unknown) => void; onError?: (err: Error & { code: string }) => void }
  >();

  let readyResolve!: () => void;
  let readyReject!: (e: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // `ready` may legitimately go unobserved after dispose — never unhandled.
  ready.catch(() => {});

  /**
   * Version-skew guidance (integration-smoke fix). Set once when the
   * `attach-ack`'s `serveVersion` stamp is present AND differs from this
   * client's own @pyric/cli version: an old worker can accept a newer op
   * frame and die mid-handling, which surfaces as a bare timeout — so the
   * mismatch warns ONCE on stderr at attach, and op-timeout errors append
   * the same guidance. Old servers omit the stamp → stays null → silent.
   */
  let versionSkewGuidance: string | null = null;

  function send(msg: BridgeMessage): void {
    transport.send(msg);
  }

  /**
   * Event-loop hold accounting (exit-hang fix): ref the transport while ANY
   * op or subscription is outstanding, unref when the last one settles.
   * Transition-edged so the hooks fire once per busy/idle flip.
   */
  let holdingLoop = false;
  function updateLoopHold(): void {
    const busy = pending.size + subs.size > 0;
    const becameBusy = busy && !holdingLoop;
    const becameIdle = !busy && holdingLoop;
    if (becameBusy) {
      holdingLoop = true;
      transport.ref?.();
    } else if (becameIdle) {
      holdingLoop = false;
      transport.unref?.();
    }
  }

  function op(payload: WorkerOpPayload): Promise<unknown> {
    const disposalReason = disposed;
    const isDisposed = disposalReason !== null && disposalReason.length > 0;
    if (isDisposed) {
      return Promise.reject(remoteError('unavailable', disposalReason));
    }
    const id = `rop-${opCounter + 1}`;
    const message: BridgeMessage = { type: 'worker-op', id, op: payload };
    const reservation = operationBudget.reserve(message);
    const isRefused = !reservation.accepted;
    if (isRefused) {
      return Promise.reject(remoteError(reservation.error.code, reservation.error.message));
    }
    opCounter += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const isPending = pending.has(id);
        if (isPending) {
          pending.delete(id);
          updateLoopHold();
          const hasVersionGuidance = Boolean(versionSkewGuidance);
          reject(
            remoteError(
              'deadline-exceeded',
              `remote sandbox op timed out after ${opTimeoutMs}ms (op: ${payload.method}). Is pyric sandbox still running?` +
                // A version-skewed old worker accepts frames it cannot
                // handle and never responds — a timeout is its signature.
                (hasVersionGuidance ? ` ${versionSkewGuidance}` : ''),
            ),
          );
        }
      }, opTimeoutMs);
      pending.set(id, { payload, resolve, reject, timer });
      updateLoopHold();
      try {
        send(message);
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        updateLoopHold();
        const isError = err instanceof Error;
        reject(
          remoteError(
            'unavailable',
            `failed to send op to serve: ${isError ? err.message : String(err)}`,
          ),
        );
      }
    }).finally(reservation.release);
  }

  function subscribe(
    sub: WorkerSubPayload,
    onSnap: (value: unknown) => void,
    onError?: (err: Error & { code: string }) => void,
  ): () => void {
    const disposalReason = disposed;
    const isDisposed = disposalReason !== null && disposalReason.length > 0;
    if (isDisposed) throw remoteError('unavailable', disposalReason);
    const subId = `rsub-${++subCounter}`;
    subs.set(subId, { onSnap, onError });
    updateLoopHold();
    send({ type: 'worker-sub', subId, sub });
    return () => {
      const wasUnregistered = !subs.delete(subId);
      if (wasUnregistered) return;
      updateLoopHold();
      const isConnected = !disposed;
      if (isConnected) {
        try {
          send({ type: 'worker-unsub', subId });
        } catch {}
      }
    };
  }

  function handleMessage(msg: BridgeMessage): void {
    const isUnknownMessage = !isBridgeMessage(msg);
    if (isUnknownMessage) return;
    switch (msg.type) {
      case 'attach-ack': {
        // Version-skew stamp: warn ONCE when the serve process runs a
        // different @pyric/cli version (absent stamp = old server = silent).
        const guidance = versionSkewGuidance === null
          ? skewGuidance(msg.serveVersion, 'Restart pyric sandbox and reload the browser tab.')
          : null;
        if (guidance !== null) {
          versionSkewGuidance = guidance;
          process.stderr.write(`pyric: ${versionSkewGuidance}\n`);
        }
        advertised = Array.isArray(msg.capabilities) ? msg.capabilities.filter(item => typeof item === 'string') : [];
        const hasPeer = msg.peerConnected;
        if (hasPeer) readyResolve();
        else readyReject(noTabError(serveUrl));
        return;
      }
      case 'worker-res': {
        const call = pending.get(msg.id);
        const isLateReply = call === undefined;
        if (isLateReply) return;
        clearTimeout(call.timer);
        pending.delete(msg.id);
        updateLoopHold();
        const hasInvalidOutcome = !hasValidReplyOutcome(msg);
        if (hasInvalidOutcome) {
          call.reject(remoteError('unavailable', 'The sandbox sent a malformed operation reply. The operation may have completed; check state before retrying.'));
          return;
        }
        const succeeded = msg.ok;
        if (succeeded) {
          call.resolve(msg.value);
        } else {
          const code = msg.error?.code ?? 'unknown';
          let message = msg.error?.message ?? 'unknown sandbox error';
          // Enrich the bridge's generic no-peer error with actionable guidance.
          const hasNoSandbox = message === NO_SANDBOX_ERROR_MESSAGE;
          const hasUnknownMethod = /^Unknown method:/.test(message);
          if (hasNoSandbox) {
            message = noTabError(serveUrl).message;
          } else if (hasUnknownMethod) {
            // Version skew: a live tab whose SharedWorker predates this op.
            // Other open pages of this origin keep the old worker alive.
            message +=
              '. The running sandbox may predate this feature. Restart pyric sandbox ' +
              'and close other open pages of this origin, then reload.';
          }
          call.reject(remoteError(code, message, msg.error?.denialContext, msg.error?.envelope));
        }
        return;
      }
      case 'worker-snap': {
        const sub = subs.get(msg.subId);
        const isUnsubscribed = sub === undefined;
        if (isUnsubscribed) return;
        const payload = snapshotError(msg);
        const hasListenerError = payload !== undefined;
        if (hasListenerError) {
          // A listener error is TERMINAL (Firestore's onSnapshot contract:
          // after onError, no further snapshots and the listener is dead).
          // Auto-unsubscribe BEFORE delivering: drop the local record (so a
          // consumer's own unsubscribe becomes an idempotent no-op and the
          // event-loop hold releases — an errored sub must not pin the
          // process forever) and tell the worker to tear down whatever
          // listener it may have registered (harmless no-op for a
          // registration failure that never registered one).
          subs.delete(msg.subId);
          updateLoopHold();
          const isConnected = !disposed;
          if (isConnected) {
            try {
              send({ type: 'worker-unsub', subId: msg.subId });
            } catch {}
          }
          const err = remoteError(payload.code, payload.message, payload.denialContext, payload.envelope);
          const onError = sub.onError;
          const hasErrorHandler = onError !== undefined;
          if (hasErrorHandler) onError(err);
          else console.error('pyric remote sandbox: uncaught error in subscription:', err);
          return;
        }
        try {
          sub.onSnap(msg.value);
        } catch {
          // Consumer callback failures must not break the relay loop.
        }
        return;
      }
      case 'ping': {
        send({ type: 'pong', id: msg.id });
        return;
      }
      default:
        return;
    }
  }

  function dispose(reason?: string, code = 'unavailable'): void {
    const isDisposed = Boolean(disposed);
    if (isDisposed) return;
    disposed = reason ?? 'remote sandbox connection closed';
    const err = remoteError(code, disposed);
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      // A sent onDisconnect never settles, as on a drop: @firebase/database
      // ends a closed connection through repoInterrupt, which clears its
      // request callbacks. The presence sample leaves it without a handler.
      const isForgotten = fateAtDrop(call.payload) === 'forget';
      if (!isForgotten) call.reject(err);
    }
    pending.clear();
    subs.clear();
    updateLoopHold();
    readyReject(err); // no-op if already settled
  }

  function releaseInFlight(lostMessage: string): ReleasedOp[] {
    const isDisposed = Boolean(disposed);
    if (isDisposed) return [];
    disposed = lostMessage;
    const lost = remoteError('unavailable', lostMessage);
    const released: ReleasedOp[] = [];
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      const fate = fateAtDrop(call.payload);
      if (fate === 'resend') released.push({ payload: call.payload, resolve: call.resolve, reject: call.reject });
      else if (fate === 'disconnect') call.reject(new Error('disconnect'));
      else if (fate === 'fail') call.reject(lost);
      // 'forget': a sent onDisconnect never settles, as on Firebase.
    }
    pending.clear();
    subs.clear();
    updateLoopHold();
    readyReject(lost); // no-op if already settled
    return released;
  }

  /** Transport failure ends active listeners; explicit client close remains silent. */
  function fail(reason: string, code = 'unavailable'): void {
    const listeners = [...subs.values()];
    dispose(reason, code);
    const error = remoteError(code, reason);
    for (const listener of listeners) {
      try { listener.onError?.(error); } catch { /* One callback cannot retain other listeners. */ }
    }
  }

  return {
    handleMessage,
    fail,
    start: () => send({ type: 'attach', protocol: 1 }),
    capabilities: () => advertised,
    ready,
    channel: { op, subscribe },
    dispose,
    releaseInFlight,
  };
}

// ─── Typed conveniences over the raw channel ───────────────────────────────

/** firebase-admin's rules-bypass lens, pinned on every RTDB convenience op. */
const ADMIN_LENS = { mode: 'admin' } as const;

/**
 * The RTDB conveniences over the channel, on `instance` (the instance name;
 * absent is the default instance). `forInstance` returns the same
 * conveniences on another instance.
 */
export function buildRemoteRtdb(channel: RemoteSandboxChannel, instance?: string): RemoteRtdb {
  const on = { instance };
  return {
    async get(path) {
      const snap = (await channel.op({
        method: 'rtdb.get',
        path,
        actAs: ADMIN_LENS,
        ...on,
      })) as RemoteRtdbSnapshot;
      return snap.value ?? null;
    },
    async set(path, value) {
      await channel.op({ method: 'rtdb.set', path, value, actAs: ADMIN_LENS, ...on });
    },
    async update(path, values) {
      await channel.op({ method: 'rtdb.update', path, values, actAs: ADMIN_LENS, ...on });
    },
    async remove(path) {
      await channel.op({ method: 'rtdb.remove', path, actAs: ADMIN_LENS, ...on });
    },
    async push(path, value) {
      // The key is the worker's, minted from the sandbox clock. This arm can
      // wait for the reply, so it never mints one of its own from the wall
      // clock of a different process.
      let op: WorkerOpPayload = { method: 'rtdb.push', path, actAs: ADMIN_LENS, ...on };
      if (value !== undefined) {
        op = { method: 'rtdb.push', path, value, actAs: ADMIN_LENS, ...on };
      }
      return (await channel.op(op)) as { key: string; path: string };
    },
    onValue(path, callback, onError) {
      return channel.subscribe(
        { target: { service: 'rtdb', ...on, path }, actAs: ADMIN_LENS },
        (value) => callback(value as RemoteRtdbSnapshot),
        onError,
      );
    },
    forInstance(name) {
      return buildRemoteRtdb(channel, name);
    },
  };
}

/** Read the session token from the host's init.json, as a page does; kept once read, asked again after a failure. */
function sessionTokenFrom(base: string): () => Promise<string | null> {
  let token: Promise<string | null> | undefined;
  return async () => {
    token ??= fetch(`${base}/__pyric/init.json`)
      .then(response => (response.ok ? response.json() : null))
      .then((body: { sessionToken?: unknown } | null) => (typeof body?.sessionToken === 'string' ? body.sessionToken : null))
      .catch(() => null);
    const value = await token;
    if (value === null) token = undefined;
    return value;
  };
}

export function buildRemoteStorage(channel: RemoteSandboxChannel): RemoteStorage {
  return {
    async putBytes(path, data, options) {
      const route = await channel.byteRoute?.();
      const routed = route !== undefined;
      if (routed) {
        const operations = { op: (payload: { method: string }) => channel.op(payload as WorkerOpPayload) };
        return (await uploadOverByteRoute(operations, route, {
          path,
          data: new Blob([data as Uint8Array<ArrayBuffer>]),
          contentType: options?.contentType,
          metadata: options?.metadata as Record<string, unknown> | undefined,
          actAs: ADMIN_LENS,
        })) as FullMetadata;
      }
      // A host without a byte route takes bytes as frames, capped per
      // operation: reject before encoding so an oversized payload never
      // reaches the wire (the host enforces the same cap on decode).
      if (data.byteLength > MAX_STORAGE_OP_BYTES) {
        throw storagePayloadTooLarge(data.byteLength, `storage payload for '${path}'`);
      }
      return (await channel.op({
        method: 'storage.putBytes',
        path,
        dataB64: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64'),
        ...(options?.contentType !== undefined ? { contentType: options.contentType } : {}),
        ...(options?.metadata !== undefined ? { metadata: options.metadata } : {}),
        actAs: ADMIN_LENS,
      })) as FullMetadata;
    },
    async getBytes(path) {
      const route = await channel.byteRoute?.();
      const routed = route !== undefined;
      if (routed) {
        const metadata = await this.getMetadata(path);
        const response = await fetchFromByteRoute(route, { bucket: metadata.bucket, path });
        return Buffer.from(await response.arrayBuffer());
      }
      const res = (await channel.op({
        method: 'storage.getBytes',
        path,
        actAs: ADMIN_LENS,
      })) as { dataB64: string };
      return Buffer.from(res.dataB64, 'base64');
    },
    async deleteObject(path) {
      await channel.op({ method: 'storage.deleteObject', path, actAs: ADMIN_LENS });
    },
    async getMetadata(path) {
      return (await channel.op({
        method: 'storage.getMetadata',
        path,
        actAs: ADMIN_LENS,
      })) as FullMetadata;
    },
    async exists(path) {
      try {
        await this.getMetadata(path);
        return true;
      } catch (err) {
        if ((err as { code?: string }).code === 'storage/object-not-found') return false;
        throw err;
      }
    },
    async listAll(path) {
      return (await channel.op({
        method: 'storage.listAll',
        path,
        actAs: ADMIN_LENS,
      })) as {
        items: Array<{ fullPath: string; name: string }>;
        prefixes: Array<{ fullPath: string; name: string }>;
      };
    },
  };
}

export function buildRemoteAuthAdmin(channel: RemoteSandboxChannel): RemoteAuthAdmin {
  return {
    async listUsers() {
      return (await channel.op({ method: 'auth.listUsers' })) as AuthUserRecord[];
    },
    async createUser(request) {
      return (await channel.op({
        method: 'auth.adminCreateUser',
        request: request as Record<string, unknown>,
      })) as AuthUserRecord;
    },
    async updateUser(uid, request) {
      return (await channel.op({
        method: 'auth.adminUpdateUser',
        uid,
        request: request as Record<string, unknown>,
      })) as AuthUserRecord;
    },
    async deleteUser(uid) {
      await channel.op({ method: 'auth.adminDeleteUser', uid });
    },
    async clearUsers() {
      await channel.op({ method: 'auth.adminClearUsers' });
    },
  };
}

// ─── Handle construction ────────────────────────────────────────────────────

/** A member of `Sandbox` that slice 1 cannot express over the wire throws
 *  this branded, remediating error instead of silently misbehaving. */
function notAvailableRemotely(member: string, remedy: string): Error & { code: string } {
  return remoteError(
    'unimplemented',
    `${member} is not available on a remote sandbox — ${remedy}`,
  );
}

/**
 * Build the branded remote sandbox handle over an established channel.
 *
 * Split out of {@link connectRemoteSandbox} so the in-process test harness
 * (fake ports + `createConsumerSession`, no WS) constructs the EXACT handle
 * production hands to `pyric-admin`.
 *
 * The handle satisfies `Sandbox` structurally:
 *   - `withAuth` / `dispose` are real (pure local construction / teardown).
 *   - Everything whose contract is sync-only or worker-owned (`admin`,
 *     `snapshot`, `loadSnapshot`, `history`, `onEvent`, `reset`,
 *     `currentUser`, `onCurrentUserChanged`, tab sync, persistence) throws
 *     a remediating `unimplemented` error. Notably `onEvent`: the unified
 *     event stream (`target: 'events'`) is not relayable until slice 2's
 *     bounded backpressure lands, and no remote dispatch arm may depend on
 *     it — a throw (not a silent no-op) keeps a subscriber from believing
 *     it is observing events that will never arrive.
 */
export function createRemoteSandboxHandle(opts: {
  channel: RemoteSandboxChannel;
  serveUrl: string;
  close: () => void;
}): RemoteSandbox {
  const { channel, serveUrl, close } = opts;
  const throwMember = (member: string, remedy: string): never => {
    throw notAvailableRemotely(member, remedy);
  };
  const handle: RemoteSandbox = {
    [REMOTE_SANDBOX]: true as const,
    serveUrl,
    channel,
    rtdb: buildRemoteRtdb(channel),
    storage: buildRemoteStorage(channel),
    auth: buildRemoteAuthAdmin(channel),
    close,

    // ── Implemented Sandbox members ─────────────────────────────────────
    withAuth(auth: AuthState): SandboxContext {
      // Pure local pair construction — contexts carry identity, the data
      // stays behind the channel.
      return new SandboxContextImpl(handle, auth);
    },
    dispose(): void {
      close();
    },

    // ── Sync-only / worker-owned members: remediating throws ───────────
    onEvent: () =>
      throwMember(
        'onEvent',
        'the unified event stream is not relayed over the bridge yet (slice 2); ' +
          `observe activity in the browser tab at ${serveUrl} or in Pyric Studio instead`,
      ),
    history: () =>
      throwMember(
        'history()',
        'the event log lives in the browser worker; inspect it in Pyric Studio ' +
          'or subscribe from the page that hosts the sandbox',
      ),
    get admin(): never {
      return throwMember(
        'admin',
        'the sync Firestore admin plane cannot span the wire; dispatch async worker ops ' +
          "through the handle's channel instead (e.g. channel.op({ method: 'admin.getDocument', path }))",
      );
    },
    reset: () =>
      throwMember(
        'reset()',
        `reset the sandbox from the browser tab at ${serveUrl} or from Pyric Studio`,
      ),
    resetAll: () =>
      throwMember(
        'resetAll()',
        "use the async worker op instead: channel.op({ method: 'resetAll' })",
      ),
    snapshot: () =>
      throwMember(
        'snapshot()',
        "use the async worker op instead: channel.op({ method: 'getSnapshot' })",
      ),
    loadSnapshot: () =>
      throwMember(
        'loadSnapshot()',
        "use the async worker ops instead: channel.op({ method: 'importState', bundle })",
      ),
    get currentUser(): never {
      return throwMember(
        'currentUser',
        'the browser tab owns the auth session; ' +
          "read it asynchronously via channel.op({ method: 'auth.getCurrentUser' })",
      );
    },
    onCurrentUserChanged: () =>
      throwMember(
        'onCurrentUserChanged',
        'the browser tab owns the auth session; subscribe there instead',
      ),
    enableTabSync: () =>
      throwMember('enableTabSync', 'tab sync is a browser concern; enable it in the page'),
    enablePersistence: () =>
      throwMember(
        'enablePersistence',
        'the browser worker owns persistence; it is already enabled by `pyric sandbox`',
      ),
    flush: () =>
      throwMember('flush()', 'the browser worker owns persistence and flushes itself'),
    clearPersistence: () =>
      throwMember(
        'clearPersistence()',
        'clear the persisted state from the browser tab or Pyric Studio',
      ),
    registerPersistableService: () =>
      throwMember(
        'registerPersistableService',
        'the browser worker owns persistence; services register there',
      ),
  };
  return handle;
}

// ─── connect ───────────────────────────────────────────────────────────────

/**
 * Discover the running `pyric sandbox --bridge`, attach to its bridge WS as a
 * worker-relay CONSUMER (never a peer — attaching cannot kick the browser
 * tab out of last-connection-wins), and return the typed remote handle.
 *
 * Fails fast when no serve is discoverable or no browser tab is connected —
 * there is deliberately no in-process fallback (see module doc).
 */
export async function connectRemoteSandbox(
  options: ConnectRemoteSandboxOptions = {},
): Promise<RemoteSandbox> {
  const cwd = options.cwd ?? process.cwd();

  // Two URLs on purpose: `serveUrl` is the CANONICAL display URL that lands in
  // "open <url>" guidance — it MUST match the origin serve's banner/auto-open
  // use (`http://localhost:<port>` for the default host), or a user following
  // the guidance opens a DIFFERENT browser origin (127.0.0.1 vs localhost →
  // separate SharedWorkers → split sandboxes). `wsBase` is connectivity: the
  // literal loopback family the health probe actually reached.
  const { serveUrl, wsBase } = await resolveRemoteHost({
    cwd,
    url: options.url,
    configuredUrl: options.configuredUrl,
    instanceId: options.instanceId,
    discover: options.discover,
    probe: options.probe,
    warn: options.warn,
  });

  const wsUrl = `${wsBase.replace(/^http/, 'ws')}/__pyric/sandbox`;
  const ws = new WebSocket(wsUrl, { maxPayload: MAX_BRIDGE_FRAME_BYTES });

  // Event-loop hold (exit-hang fix): `ws` exposes no ref/unref of its own —
  // reach the underlying net.Socket (present once connected). Unref'ing only
  // changes loop-exit accounting, never delivery: while ANY pending op or
  // live subscription holds a ref (the core's updateLoopHold), frames flow
  // normally; when idle, a finished script exits instead of hanging.
  const wsSocket = (): Socket | undefined => {
    const hasUnderlyingSocket = '_socket' in ws;
    if (hasUnderlyingSocket) {
      const socket = ws._socket;
      const isNetworkSocket = socket instanceof Socket;
      if (isNetworkSocket) return socket;
    }
    return;
  };

  const core = createRemoteSandboxCore(
    {
      send(msg) {
        const payload = encodeBridgeMessage(msg);
        const exceedsFrameLimit = payload === undefined;
        if (exceedsFrameLimit) {
          const error = { code: 'resource-exhausted', message: 'Bridge request exceeds the 12 MiB encoded frame limit.' };
          // Deliver local refusal through the same owner that settles replies and releases work.
          const isOperation = msg.type === 'worker-op';
          if (isOperation) {
            core.handleMessage({ type: 'worker-res', id: msg.id, ok: false, error });
            return;
          }
          const isSubscription = msg.type === 'worker-sub';
          if (isSubscription) {
            core.handleMessage({ type: 'worker-snap', subId: msg.subId, value: { __error: error } });
            return;
          }
          throw remoteError(error.code, error.message);
        }
        ws.send(payload);
      },
      ref: () => wsSocket()?.ref(),
      unref: () => wsSocket()?.unref(),
    },
    { serveUrl, opTimeoutMs: options.opTimeoutMs },
  );

  let liveness: HostLiveness | undefined;
  let silenceReason: string | undefined;
  ws.on('message', (raw) => {
    liveness?.heard();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      core.fail('The remote sandbox sent invalid JSON. Requests already sent may have completed; check state before retrying.');
      ws.close();
      return;
    }
    const msg = parsed;
    const isUnrecognizedFrame = !isBridgeMessage(msg);
    if (isUnrecognizedFrame) {
      core.fail('The remote sandbox sent an unrecognized reply envelope. Requests already sent may have completed; check state before retrying.');
      ws.close();
      return;
    }
    const hasInvalidResponseId = msg.type === 'worker-res' && typeof msg.id !== 'string';
    const hasInvalidSubscriptionId = msg.type === 'worker-snap' && typeof msg.subId !== 'string';
    const hasInvalidCorrelation = hasInvalidResponseId || hasInvalidSubscriptionId;
    if (hasInvalidCorrelation) {
      core.fail('The remote sandbox sent an invalid reply correlation. Requests already sent may have completed; check state before retrying.');
      ws.close();
      return;
    }
    const isUnsupportedProtocol = msg.type === 'attach-ack' && msg.protocol !== 1;
    if (isUnsupportedProtocol) {
      core.fail('The remote sandbox uses an unsupported bridge protocol. Expected version 1.');
      ws.close();
      return;
    }
    const hasMalformedAttachment = msg.type === 'attach-ack' && !hasValidAttachFields(msg);
    if (hasMalformedAttachment) {
      core.fail('The remote sandbox sent a malformed attachment acknowledgment.');
      ws.close();
      return;
    }
    core.handleMessage(msg);
  });
  // A connection lost after the attach is handed to `onConnectionLost` once,
  // with listeners left quiet for its resubscription; one lost before the
  // attach, or with no such caller, ends the listeners as before.
  let attached = false;
  let closedByClient = false;
  let lossReported = false;
  const loseConnection = (reason: string): void => {
    const onConnectionLost = options.onConnectionLost;
    const isReconnectable = attached && !closedByClient && onConnectionLost !== undefined;
    if (!isReconnectable) {
      core.fail(reason);
      return;
    }
    // RTDB writes and reads go to the caller to send again, as the SDK does;
    // every other op in flight fails once, unreplayed, since the host may
    // already have applied it.
    const resend = core.releaseInFlight(CONNECTION_LOST);
    if (lossReported) return;
    lossReported = true;
    onConnectionLost(reason, resend);
  };
  ws.on('close', (code) => {
    liveness?.stop();
    // A policy close (1008) is the host refusing this client, not a restart:
    // it is final, as ADR 0019 rules, so retrying would only be refused again.
    // Its `permission-denied` code tells the lazy handle not to retry.
    const isPolicyClose = code === 1008;
    if (isPolicyClose) {
      core.fail('remote sandbox connection closed by the host for a policy violation', REFUSED_CODE);
      return;
    }
    loseConnection(silenceReason ?? 'remote sandbox connection closed (serve stopped or connection lost)');
  });
  ws.on('error', (err) => loseConnection(`remote sandbox connection failed: ${err.message}`));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(remoteError('deadline-exceeded', `timed out connecting to ${wsUrl}`)),
      ATTACH_TIMEOUT_MS,
    );
    ws.once('open', () => {
      clearTimeout(timer);
      // Idle default: an open-but-idle connection must not pin the event
      // loop (both the eager and lazy `remoteSandbox` paths come through
      // here). The core re-refs while ops/subs are outstanding.
      wsSocket()?.unref();
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(remoteError('unavailable', `failed to connect to ${wsUrl}: ${err.message}`));
    });
  });

  core.start();
  try {
    await withTimeout(core.ready, ATTACH_TIMEOUT_MS, `timed out attaching to the bridge at ${wsUrl}`);
  } catch (err) {
    try {
      ws.close();
    } catch {}
    throw err;
  }
  attached = true;
  // Pings go straight to the socket: they bypass the operation budget and
  // never ref it, so an idle script still exits. A silent host is a drop.
  const startHeartbeat = (): HostLiveness =>
    watchHostLiveness({
      send: (message) => ws.send(JSON.stringify(message)),
      onSilent: (timeoutMs) => {
        silenceReason = `the remote sandbox sent nothing for ${timeoutMs / 1000}s`;
        ws.terminate();
      },
    });
  const isOpen = ws.readyState === WebSocket.OPEN;
  if (isOpen) liveness = startHeartbeat();

  // A host with a byte route takes Storage bytes over HTTP, authorized by the
  // session token its init.json hands a local process.
  const offersByteRoute = core.capabilities().includes(STORAGE_BYTE_ROUTE_CAPABILITY);
  const byteRoute: RemoteByteRoute | undefined = offersByteRoute
    ? { baseUrl: wsBase, sessionToken: sessionTokenFrom(wsBase) }
    : undefined;
  return createRemoteSandboxHandle({
    serveUrl,
    channel: { ...core.channel, byteRoute: async () => byteRoute },
    close() {
      closedByClient = true;
      liveness?.stop();
      core.dispose('remote sandbox connection closed by the client');
      try {
        ws.close();
      } catch {}
    },
  });
}

// ─── Lazy connect (`remoteSandbox`) ────────────────────────────────────────

/**
 * {@link remoteSandbox}'s return type: the branded handle plus `ready` for
 * eager checkers. `ready` kicks off the connection when first accessed and
 * settles with the same fail-fast errors {@link connectRemoteSandbox} throws
 * (no serve discovered / no browser tab connected).
 */
export interface LazyRemoteSandbox extends RemoteSandbox {
  readonly ready: Promise<void>;
}

/**
 * Synchronous construction, lazy connection — the ambient-init seam.
 *
 * `@pyric/cli/register` installs this behind the
 * `Symbol.for('pyric.remote.sandboxFactory')` global so `pyric-admin`'s bare
 * `initializeApp()` can mint a full branded handle without awaiting anything.
 * The wire connection (discovery → WS attach) happens on the FIRST op (or
 * `ready` access), so the existing fail-fast — "no browser tab is connected —
 * open <url>" — surfaces on first use instead of at construction. A failed
 * connect is NOT latched: the next op retries, matching the error's own
 * "…and retry" guidance. `connectRemoteSandbox` (eager) is unchanged.
 *
 * A connection the host drops (a hosted dev server restarting on the same
 * url) is a lost connection, not a stopped sandbox. The handle reconnects with
 * backoff and resubscribes live listeners. RTDB writes and reads in flight at
 * the drop are sent again after the listeners, with no deadline; other calls
 * in flight fail once with `unavailable`. A call issued while the connection
 * is lost waits up to 10 seconds from its issue for the reconnect and is then
 * sent once; past that it fails with `unavailable`, unsent. A host that
 * refuses this client (a policy close) is final: waiting calls fail with
 * `permission-denied`. `close()` fails every waiting call and sends none.
 */
export function remoteSandbox(options: ConnectRemoteSandboxOptions = {}): LazyRemoteSandbox {
  return createLazyRemoteSandbox(
    (onConnectionLost) => connectRemoteSandbox({ ...options, onConnectionLost }),
    options,
  );
}

/** The code of a connection the host refused (a policy close, 1008): final, never retried. */
const REFUSED_CODE = 'permission-denied';

/** Longest wait between reconnects. */
const RECONNECT_MAX_DELAY_MS = 5_000;

/** The wait before reconnect attempt `attempt` (from 0): ADR 0019's schedule, 250 ms doubling to 5 s, with jitter. */
function reconnectDelay(attempt: number): number {
  const base = Math.min(RECONNECT_MAX_DELAY_MS, 250 * 2 ** attempt);
  const jitter = Math.random() * Math.min(250, base / 10);
  return Math.min(RECONNECT_MAX_DELAY_MS, base + jitter);
}

/**
 * A listener on the lazy handle. `detach` is its subscription on the current
 * connection, if any; `last` is the value it last delivered, and `resumed`
 * marks the first value after a resubscription, which is not raised again
 * when it equals `last`.
 */
interface LazySubscription {
  sub: WorkerSubPayload;
  onSnap: (value: unknown) => void;
  onError?: (err: Error & { code: string }) => void;
  detach: (() => void) | null;
  last: { value: unknown } | null;
  resumed: boolean;
}

function isSameValue(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function deliverSnapshot(subscription: LazySubscription, value: unknown): void {
  const last = subscription.last;
  const isRepeat = subscription.resumed && last !== null && isSameValue(last.value, value);
  subscription.resumed = false;
  subscription.last = { value };
  if (isRepeat) return;
  subscription.onSnap(value);
}

function asRemoteError(err: unknown): Error & { code: string } {
  const hasCode = err instanceof Error && 'code' in err;
  if (hasCode) return err as Error & { code: string };
  return remoteError('unavailable', String(err));
}

/** The error every call gets once the lazy handle is closed. */
function closedByClientError(): Error & { code: string } {
  return remoteError('unavailable', 'remote sandbox connection closed by the client');
}

function resentCalls(count: number): string {
  if (count === 1) return ' 1 call in flight waits to be sent again.';
  return ` ${count} calls in flight wait to be sent again.`;
}

/** The one warning a drop logs, naming the calls in flight that wait to be sent again. */
function connectionLostWarning(reason: string, serveUrl: string, resent: number): string {
  const hasResent = resent > 0;
  if (!hasResent) {
    return `pyric: ${reason} at ${serveUrl}; calls wait up to 10 seconds for it, and live listeners reconnect when the host answers.`;
  }
  return (
    `pyric: ${reason} at ${serveUrl}; calls wait up to 10 seconds for it, calls in flight are sent again, ` +
    `and live listeners reconnect when the host answers.${resentCalls(resent)}`
  );
}

/**
 * The lazy wrapper with the connect function injected — the test seam
 * (tests inject a fake connect; production injects `connectRemoteSandbox`).
 * `connect` receives the callback its connection reports a loss through,
 * with the calls in flight to send again on the next connection.
 */
export function createLazyRemoteSandbox(
  connect: (onConnectionLost: (reason: string, resend?: ReleasedOp[]) => void) => Promise<RemoteSandbox>,
  options: { url?: string; configuredUrl?: string; warn?: (message: string) => void } = {},
): LazyRemoteSandbox {
  /** The connect in progress, or the one that attached. */
  let inner: Promise<RemoteSandbox> | null = null;
  /** The attached connection, while it lasts. */
  let current: RemoteSandbox | null = null;
  let everAttached = false;
  let lastAttemptFailure: string | undefined;
  let connection = 0;
  let closed = false;
  const subscriptions = new Set<LazySubscription>();
  const held = createHeldCalls({ lastAttempt: () => lastAttemptFailure });
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;

  function ensure(): Promise<RemoteSandbox> {
    if (closed) return Promise.reject(closedByClientError());
    if (!inner) {
      connection += 1;
      const id = connection;
      inner = connect((reason, resend = []) => connectionLost(id, reason, resend)).then(attached, attemptFailed);
    }
    return inner;
  }

  /** Subscriptions attach first, then held calls go: the ones in flight at the drop, then the rest in issue order. */
  function attached(h: RemoteSandbox): RemoteSandbox {
    if (closed) {
      h.close();
      throw closedByClientError();
    }
    // Discovery resolved the real URL — reflect it on the outer handle.
    (handle as { serveUrl: string }).serveUrl = h.serveUrl;
    reconnectAttempt = 0;
    lastAttemptFailure = undefined;
    everAttached = true;
    current = h;
    for (const subscription of subscriptions) attach(subscription, h);
    held.flush(h.channel);
    return h;
  }

  function attemptFailed(err: unknown): never {
    // Before the first attach the failure surfaces on this op, unlatched: the
    // remediation is "open <url> and retry", so the next op re-attempts. After
    // it, the failure is a host still restarting, and the schedule retries.
    inner = null;
    const error = asRemoteError(err);
    lastAttemptFailure = error.message;
    if (everAttached) retryAfter(error);
    throw err;
  }

  /** Every failure is retried on the schedule except a host refusing this client, which is final. */
  function retryAfter(error: Error & { code: string }): void {
    const isRefused = error.code === REFUSED_CODE;
    if (isRefused) {
      refuse(error);
      return;
    }
    reconnectAttempt += 1;
    scheduleReconnect();
  }

  /** A host that refuses this client refuses every retry: held calls fail unsent, and waiting listeners end. */
  function refuse(error: Error & { code: string }): void {
    held.fail(error);
    for (const subscription of subscriptions) {
      if (subscription.detach === null) endSubscription(subscription, error);
    }
  }

  /** A listener error is terminal: the listener leaves the set and is not resubscribed. */
  function endSubscription(subscription: LazySubscription, err: Error & { code: string }): void {
    subscriptions.delete(subscription);
    subscription.detach = null;
    const onError = subscription.onError;
    if (onError) onError(err);
    else console.error('pyric remote sandbox: uncaught error in subscription:', err);
  }

  function attach(subscription: LazySubscription, h: RemoteSandbox): void {
    const isAttachable = subscriptions.has(subscription) && subscription.detach === null;
    if (!isAttachable) return;
    try {
      subscription.detach = h.channel.subscribe(
        subscription.sub,
        (value) => deliverSnapshot(subscription, value),
        (err) => endSubscription(subscription, err),
      );
    } catch (err) {
      // A connection that closed under this attach has already reported its
      // loss, and the reconnect resubscribes; any other refusal ends the listener.
      const wasConnectionLost = current !== h || closed;
      if (!wasConnectionLost) endSubscription(subscription, asRemoteError(err));
    }
  }

  function connectionLost(id: number, reason: string, resend: ReleasedOp[]): void {
    if (closed) {
      for (const call of resend) call.reject(closedByClientError());
      return;
    }
    const isCurrentConnection = id === connection;
    if (!isCurrentConnection) return;
    inner = null;
    current = null;
    held.holdAgain(resend);
    // Once per drop, not per retry: a listener whose host never returns does
    // not wait silently, and a long outage does not flood the log.
    const message = connectionLostWarning(reason, handle.serveUrl, resend.length);
    if (options.warn) options.warn(message);
    else process.stderr.write(`${message}\n`);
    for (const subscription of subscriptions) {
      subscription.detach = null;
      subscription.resumed = true;
    }
    scheduleReconnect();
  }

  /** True after a drop, until the next attach. */
  function isLost(): boolean {
    return everAttached && current === null && !closed;
  }

  /**
   * Reconnect while a listener or a held call waits for one, on the schedule,
   * never ahead of it. The pending timer holds the event loop, as a live
   * listener does.
   */
  function scheduleReconnect(): void {
    const isScheduled = reconnectTimer !== null;
    const isConnecting = inner !== null;
    const hasWaitingListener = [...subscriptions].some((subscription) => subscription.detach === null);
    const hasHeldCall = held.size > 0;
    const hasWaitingWork = hasWaitingListener || hasHeldCall;
    const needsReconnect = !closed && !isScheduled && !isConnecting && hasWaitingWork;
    if (!needsReconnect) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      // A failure reschedules from attemptFailed.
      ensure().catch(() => {});
    }, reconnectDelay(reconnectAttempt));
  }

  function cancelReconnect(): void {
    if (reconnectTimer === null) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  /** A call issued after a drop waits for the next attach, up to the hold deadline. */
  function heldUntilReconnect<T>(call: Promise<T>): Promise<T> {
    scheduleReconnect();
    return call;
  }

  const channel: RemoteSandboxChannel = {
    op(payload) {
      const live = current;
      if (live) return live.channel.op(payload);
      if (isLost()) return heldUntilReconnect(held.hold(payload, Date.now()));
      return ensure().then((h) => h.channel.op(payload));
    },
    byteRoute() {
      if (isLost()) return heldUntilReconnect(held.holdByteRoute(Date.now()));
      return ensure().then((h) => h.channel.byteRoute?.());
    },
    subscribe(sub, onSnap, onError) {
      const subscription: LazySubscription = { sub, onSnap, onError, detach: null, last: null, resumed: false };
      subscriptions.add(subscription);
      if (isLost()) {
        // It attaches with the others when the host answers, with no deadline.
        scheduleReconnect();
      } else {
        ensure().then(
          (h) => attach(subscription, h),
          (err) => {
            // A listener made while no host answers fails fast, as an op does.
            const isLive = subscriptions.has(subscription);
            if (isLive) endSubscription(subscription, asRemoteError(err));
          },
        );
      }
      return () => {
        const wasLive = subscriptions.delete(subscription);
        if (!wasLive) return;
        subscription.detach?.();
        subscription.detach = null;
        const hasNoWaitingWork = subscriptions.size === 0 && held.size === 0;
        if (hasNoWaitingWork) cancelReconnect();
      };
    },
  };

  const handle = createRemoteSandboxHandle({
    channel,
    // Before discovery the URL is unknown; op-level errors always carry the
    // real URL (they come from the inner connect), and `serveUrl` is patched
    // to the discovered value as soon as the first connect succeeds.
    serveUrl: (options.url ?? options.configuredUrl)?.replace(/\/$/, '') ?? '<pyric sandbox url (pending discovery)>',
    close() {
      if (closed) return;
      closed = true;
      cancelReconnect();
      subscriptions.clear();
      held.fail(closedByClientError());
      const settled = inner;
      inner = null;
      current = null;
      if (settled) {
        settled.then(
          (h) => h.close(),
          () => {},
        );
      }
    },
  }) as RemoteSandbox & { ready: Promise<void> };

  // `ready` — the eager checker: accessing it starts the connection. Marked
  // handled (same pattern as the core's `ready`) so a mere existence check
  // (`handle.ready instanceof Promise`) never surfaces an unhandled rejection.
  Object.defineProperty(handle, 'ready', {
    get: (): Promise<void> => {
      const p = ensure().then(() => undefined);
      p.catch(() => {});
      return p;
    },
    enumerable: true,
    configurable: true,
  });

  return handle as LazyRemoteSandbox;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(remoteError('deadline-exceeded', message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

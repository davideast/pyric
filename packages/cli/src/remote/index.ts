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
 * "open <serve url>" error. There is deliberately NO silent headless
 * fallback — a silently split backend is exactly the failure this client
 * exists to avoid.
 *
 * SUBSCRIPTION OWNERSHIP: the bridge process owns the durable sub registry
 * and re-issues it to every newly registered peer (tab refresh/replacement),
 * so a subscription made here survives peer churn — RTDB value semantics
 * make the replay safe (each resubscribe re-delivers a fresh snapshot;
 * consumers are last-value-wins).
 *
 * NODE-ONLY: uses `ws` and `node:fs` — exported via a `node`-conditional
 * subpath (`@pyric/cli/remote`), never bundled for the browser.
 */
import { WebSocket } from 'ws';
import type { AuthUserRecord, CreateUserRequest, UpdateUserRequest } from 'pyric/auth';
import type { FullMetadata } from 'pyric/storage';
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
import { isBridgeMessage, NO_SANDBOX_ERROR_MESSAGE } from '../bridge/protocol.js';
import { cliVersion } from '../pkg-version.js';
import { MAX_STORAGE_OP_BYTES, storagePayloadTooLarge } from '../serve/worker/protocol.js';
import { discoverServe } from '../serve/discovery.js';

/** Sits just above the bridge's own 30s `callTimeoutMs` so a legitimately
 *  slow worker op still completes (same layering as `mcp-proxy`'s 35s). */
const DEFAULT_OP_TIMEOUT_MS = 35_000;

/** How long the attach handshake may take before connect() fails. */
const ATTACH_TIMEOUT_MS = 5_000;

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

// ─── Public types ──────────────────────────────────────────────────────────

export interface ConnectRemoteSandboxOptions {
  /** Project root for `.pyric/serve.json` discovery. Default: `process.cwd()`. */
  cwd?: string;
  /** Explicit serve base URL (e.g. `http://127.0.0.1:5000`) — skips discovery. */
  url?: string;
  /** Per-op timeout in ms on the Node side (default 35s, above the bridge's 30s). */
  opTimeoutMs?: number;
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
}

/**
 * Thin Storage conveniences over the channel — the byte-carrying base64 ops
 * plus browse/metadata. Every call pins `actAs: { mode: 'admin' }`
 * (firebase-admin's rules-bypass semantics, matching {@link RemoteRtdb});
 * use the raw `channel` for lensed (rules-evaluated) access. Bytes are
 * capped at 8 MiB raw ({@link MAX_STORAGE_OP_BYTES}) on both ends —
 * streaming transfers are not supported on the sandbox backend.
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
  /** Storage conveniences (admin lens pinned; 8 MiB per-op byte cap). */
  readonly storage: RemoteStorage;
  /** Admin auth user CRUD. */
  readonly auth: RemoteAuthAdmin;
  /** Close the connection. In-flight ops reject; subscriptions stop. */
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
  /** Resolves on `attach-ack`; rejects when no browser tab is connected. */
  ready: Promise<void>;
  channel: RemoteSandboxChannel;
  /** Fail everything in flight (transport closed). Idempotent. */
  dispose(reason?: string): void;
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

  let opCounter = 0;
  let subCounter = 0;
  let disposed: string | null = null;

  const pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
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
    if (busy && !holdingLoop) {
      holdingLoop = true;
      transport.ref?.();
    } else if (!busy && holdingLoop) {
      holdingLoop = false;
      transport.unref?.();
    }
  }

  function op(payload: WorkerOpPayload): Promise<unknown> {
    if (disposed) {
      return Promise.reject(remoteError('unavailable', disposed));
    }
    return new Promise<unknown>((resolve, reject) => {
      const id = `rop-${++opCounter}`;
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          updateLoopHold();
          reject(
            remoteError(
              'deadline-exceeded',
              `remote sandbox op timed out after ${opTimeoutMs}ms (op: ${payload.method}). Is pyric sandbox still running?` +
                // A version-skewed old worker accepts frames it cannot
                // handle and never responds — a timeout is its signature.
                (versionSkewGuidance ? ` ${versionSkewGuidance}` : ''),
            ),
          );
        }
      }, opTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      updateLoopHold();
      try {
        send({ type: 'worker-op', id, op: payload });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        updateLoopHold();
        reject(
          remoteError(
            'unavailable',
            `failed to send op to serve: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });
  }

  function subscribe(
    sub: WorkerSubPayload,
    onSnap: (value: unknown) => void,
    onError?: (err: Error & { code: string }) => void,
  ): () => void {
    if (disposed) throw remoteError('unavailable', disposed);
    const subId = `rsub-${++subCounter}`;
    subs.set(subId, { onSnap, onError });
    updateLoopHold();
    send({ type: 'worker-sub', subId, sub });
    return () => {
      if (!subs.delete(subId)) return;
      updateLoopHold();
      if (!disposed) {
        try {
          send({ type: 'worker-unsub', subId });
        } catch {}
      }
    };
  }

  function handleMessage(msg: BridgeMessage): void {
    if (!isBridgeMessage(msg)) return;
    switch (msg.type) {
      case 'attach-ack': {
        // Version-skew stamp: warn ONCE when the serve process runs a
        // different @pyric/cli version (absent stamp = old server = silent).
        if (
          versionSkewGuidance === null &&
          typeof msg.serveVersion === 'string' &&
          msg.serveVersion !== cliVersion()
        ) {
          versionSkewGuidance =
            `pyric sandbox is running version ${msg.serveVersion}, this client is ` +
            `${cliVersion()}. Restart pyric sandbox and reload the browser tab.`;
          process.stderr.write(`pyric: ${versionSkewGuidance}\n`);
        }
        if (msg.peerConnected) readyResolve();
        else readyReject(noTabError(serveUrl));
        return;
      }
      case 'worker-res': {
        const call = pending.get(msg.id);
        if (!call) return; // late (already timed out) — drop
        clearTimeout(call.timer);
        pending.delete(msg.id);
        updateLoopHold();
        if (msg.ok) {
          call.resolve(msg.value);
        } else {
          const code = msg.error?.code ?? 'unknown';
          let message = msg.error?.message ?? 'unknown sandbox error';
          // Enrich the bridge's generic no-peer error with actionable guidance.
          if (message === NO_SANDBOX_ERROR_MESSAGE) {
            message = noTabError(serveUrl).message;
          } else if (/^Unknown method:/.test(message)) {
            // Version skew: a live tab whose SharedWorker predates this op.
            // Other open pages of this origin keep the old worker alive.
            message +=
              '. The running sandbox may predate this feature. Restart pyric sandbox ' +
              'and close other open pages of this origin, then reload.';
          }
          call.reject(remoteError(code, message, msg.error?.denialContext, (msg.error as any)?.envelope));
        }
        return;
      }
      case 'worker-snap': {
        const sub = subs.get(msg.subId);
        if (!sub) return; // unsubscribed — drop
        const value = (msg.value ?? {}) as Record<string, unknown>;
        if (value.__error) {
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
          if (!disposed) {
            try {
              send({ type: 'worker-unsub', subId: msg.subId });
            } catch {}
          }
          const payload = value.__error as { code: string; message: string; denialContext?: unknown; envelope?: unknown };
          const err = remoteError(payload.code, payload.message, payload.denialContext, payload.envelope);
          if (sub.onError) sub.onError(err);
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

  function dispose(reason?: string): void {
    if (disposed) return;
    disposed = reason ?? 'remote sandbox connection closed';
    const err = remoteError('unavailable', disposed);
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(err);
    }
    pending.clear();
    subs.clear();
    updateLoopHold();
    readyReject(err); // no-op if already settled
  }

  return {
    handleMessage,
    start: () => send({ type: 'attach', protocol: 1 }),
    ready,
    channel: { op, subscribe },
    dispose,
  };
}

// ─── Typed conveniences over the raw channel ───────────────────────────────

/** firebase-admin's rules-bypass lens, pinned on every RTDB convenience op. */
const ADMIN_LENS = { mode: 'admin' } as const;

export function buildRemoteRtdb(channel: RemoteSandboxChannel): RemoteRtdb {
  return {
    async get(path) {
      const snap = (await channel.op({
        method: 'rtdb.get',
        path,
        actAs: ADMIN_LENS,
      })) as RemoteRtdbSnapshot;
      return snap.value ?? null;
    },
    async set(path, value) {
      await channel.op({ method: 'rtdb.set', path, value, actAs: ADMIN_LENS });
    },
    async update(path, values) {
      await channel.op({ method: 'rtdb.update', path, values, actAs: ADMIN_LENS });
    },
    async remove(path) {
      await channel.op({ method: 'rtdb.remove', path, actAs: ADMIN_LENS });
    },
    async push(path, value) {
      const key = generatePushId();
      const res = (await channel.op({
        method: 'rtdb.push',
        path,
        key,
        ...(value !== undefined ? { value } : {}),
        actAs: ADMIN_LENS,
      })) as { key: string; path: string };
      return res;
    },
    onValue(path, callback, onError) {
      return channel.subscribe(
        { target: { service: 'rtdb', path }, actAs: ADMIN_LENS },
        (value) => callback(value as RemoteRtdbSnapshot),
        onError,
      );
    },
  };
}

export function buildRemoteStorage(channel: RemoteSandboxChannel): RemoteStorage {
  return {
    async putBytes(path, data, options) {
      // Client-side cap: reject BEFORE encoding/sending so an oversized
      // payload never hits the wire (the host enforces the same cap on
      // decode — belt and braces across the relay).
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
 * there is deliberately no headless fallback (see module doc).
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
  let serveUrl: string;
  let wsBase: string;
  if (options.url) {
    serveUrl = options.url.replace(/\/$/, '');
    wsBase = serveUrl;
  } else {
    const found = await discoverServe(cwd);
    if (!found) {
      throw remoteError(
        'not-found',
        'no running `pyric sandbox --bridge` found (looked for .pyric/serve.json in ' +
          `${cwd} and the default ports) — start your dev server with the bridge enabled and retry.`,
      );
    }
    serveUrl = found.url;
    wsBase = found.base;
  }

  const wsUrl = `${wsBase.replace(/^http/, 'ws')}/__pyric/sandbox`;
  const ws = new WebSocket(wsUrl);

  // Event-loop hold (exit-hang fix): `ws` exposes no ref/unref of its own —
  // reach the underlying net.Socket (present once connected). Unref'ing only
  // changes loop-exit accounting, never delivery: while ANY pending op or
  // live subscription holds a ref (the core's updateLoopHold), frames flow
  // normally; when idle, a finished script exits instead of hanging.
  const wsSocket = (): { ref(): void; unref(): void } | undefined =>
    (ws as unknown as { _socket?: { ref(): void; unref(): void } })._socket;

  const core = createRemoteSandboxCore(
    {
      send: (msg) => ws.send(JSON.stringify(msg)),
      ref: () => wsSocket()?.ref(),
      unref: () => wsSocket()?.unref(),
    },
    { serveUrl, opTimeoutMs: options.opTimeoutMs },
  );

  ws.on('message', (raw) => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (isBridgeMessage(msg)) core.handleMessage(msg);
  });
  ws.on('close', () => core.dispose('remote sandbox connection closed (serve stopped or connection lost)'));
  ws.on('error', (err) => core.dispose(`remote sandbox connection failed: ${err.message}`));

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

  return createRemoteSandboxHandle({
    serveUrl,
    channel: core.channel,
    close() {
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
 */
export function remoteSandbox(options: ConnectRemoteSandboxOptions = {}): LazyRemoteSandbox {
  return createLazyRemoteSandbox(() => connectRemoteSandbox(options), options);
}

/**
 * The lazy wrapper with the connect function injected — the test seam
 * (tests inject a fake connect; production injects `connectRemoteSandbox`).
 */
export function createLazyRemoteSandbox(
  connect: () => Promise<RemoteSandbox>,
  options: { url?: string } = {},
): LazyRemoteSandbox {
  let inner: Promise<RemoteSandbox> | null = null;
  let closed = false;

  function ensure(): Promise<RemoteSandbox> {
    if (closed) {
      return Promise.reject(
        remoteError('unavailable', 'remote sandbox connection closed by the client'),
      );
    }
    if (!inner) {
      inner = connect().then(
        (h) => {
          if (closed) {
            h.close();
            throw remoteError('unavailable', 'remote sandbox connection closed by the client');
          }
          // Discovery resolved the real URL — reflect it on the outer handle.
          (handle as { serveUrl: string }).serveUrl = h.serveUrl;
          return h;
        },
        (err) => {
          // Fail-fast surfaces on this op, but don't latch: the remediation
          // is "open <url> and retry", so the next op re-attempts the connect.
          inner = null;
          throw err;
        },
      );
    }
    return inner;
  }

  const channel: RemoteSandboxChannel = {
    op: (payload) => ensure().then((h) => h.channel.op(payload)),
    subscribe(sub, onSnap, onError) {
      let cancelled = false;
      let innerUnsub: (() => void) | null = null;
      ensure().then(
        (h) => {
          if (cancelled) return;
          innerUnsub = h.channel.subscribe(sub, onSnap, onError);
        },
        (err) => {
          if (cancelled) return;
          const e =
            err instanceof Error && 'code' in err
              ? (err as Error & { code: string })
              : remoteError('unavailable', String(err));
          if (onError) onError(e);
          else console.error('pyric remote sandbox: subscription failed to connect:', e);
        },
      );
      return () => {
        cancelled = true;
        if (innerUnsub) {
          innerUnsub();
          innerUnsub = null;
        }
      };
    },
  };

  const handle = createRemoteSandboxHandle({
    channel,
    // Before discovery the URL is unknown; op-level errors always carry the
    // real URL (they come from the inner connect), and `serveUrl` is patched
    // to the discovered value as soon as the first connect succeeds.
    serveUrl: options.url?.replace(/\/$/, '') ?? '<pyric sandbox url (pending discovery)>',
    close() {
      if (closed) return;
      closed = true;
      const settled = inner;
      inner = null;
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

// ─── RTDB push-id generator ────────────────────────────────────────────────
// Client-minted push ids (the worker-protocol contract: `rtdb.push` carries
// the key so `.key` is synchronously known to callers). Standard Firebase
// algorithm — 8 chars of timestamp + 12 random, monotonic within one ms.
// Inlined (like pyric-admin does) because pyric doesn't export its generator.

const PUSH_CHARS =
  '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';

let lastPushTime = 0;
const lastRandChars: number[] = new Array(12).fill(0);

function generatePushId(now: number = Date.now()): string {
  const duplicateTime = now === lastPushTime;
  lastPushTime = now;

  const timeStampChars: string[] = new Array(8);
  let ts = now;
  for (let i = 7; i >= 0; i--) {
    timeStampChars[i] = PUSH_CHARS.charAt(ts % 64);
    ts = Math.floor(ts / 64);
  }
  if (ts !== 0) {
    throw new Error('RTDB push-id: timestamp overflow.');
  }
  let id = timeStampChars.join('');

  if (!duplicateTime) {
    for (let i = 0; i < 12; i++) {
      lastRandChars[i] = Math.floor(Math.random() * 64);
    }
  } else {
    let i: number;
    for (i = 11; i >= 0 && lastRandChars[i] === 63; i--) {
      lastRandChars[i] = 0;
    }
    if (i < 0) {
      for (let j = 0; j < 12; j++) {
        lastRandChars[j] = Math.floor(Math.random() * 64);
      }
    } else {
      lastRandChars[i] = (lastRandChars[i] ?? 0) + 1;
    }
  }

  for (let i = 0; i < 12; i++) {
    id += PUSH_CHARS.charAt(lastRandChars[i]!);
  }
  return id;
}

/**
 * `connectRemoteSandbox()` — Node-side client for the browser-hosted
 * SharedWorker sandbox (remote sandbox, slice 1 / checkpoint 1).
 *
 * Server-side Node code (ultimately `pyric-admin`'s remote dispatch arm)
 * reaches the ONE sandbox the app + Studio + agent share:
 *
 *   Node process ──ws──> `pyric serve --bridge` ──ws──> browser tab
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
 * subpath (`pyric-tools/remote`), never bundled for the browser.
 */
import { WebSocket } from 'ws';
import type { AuthUserRecord, CreateUserRequest, UpdateUserRequest } from 'pyric/auth';
import type {
  BridgeMessage,
  WorkerOpPayload,
  WorkerSubPayload,
} from '../bridge/protocol.js';
import { isBridgeMessage, NO_SANDBOX_ERROR_MESSAGE } from '../bridge/protocol.js';
import { discoverServe } from '../serve/discovery.js';

/** Sits just above the bridge's own 30s `callTimeoutMs` so a legitimately
 *  slow worker op still completes (same layering as `mcp-proxy`'s 35s). */
const DEFAULT_OP_TIMEOUT_MS = 35_000;

/** How long the attach handshake may take before connect() fails. */
const ATTACH_TIMEOUT_MS = 5_000;

function remoteError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
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

/** Admin auth user-CRUD passthrough (never lensed — auth ops operate the
 *  worker's user pool directly, mirroring `pyric/auth`'s sandbox ops). */
export interface RemoteAuthAdmin {
  listUsers(): Promise<AuthUserRecord[]>;
  createUser(request: CreateUserRequest): Promise<AuthUserRecord>;
  updateUser(uid: string, request: UpdateUserRequest): Promise<AuthUserRecord>;
  deleteUser(uid: string): Promise<void>;
  clearUsers(): Promise<void>;
}

export interface RemoteSandbox {
  /** Base URL of the serve this handle is attached to (for error guidance). */
  readonly serveUrl: string;
  /** The raw worker op/sub relay channel. */
  readonly channel: RemoteSandboxChannel;
  /** RTDB conveniences (admin lens pinned). */
  readonly rtdb: RemoteRtdb;
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

  function send(msg: BridgeMessage): void {
    transport.send(msg);
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
          reject(
            remoteError(
              'deadline-exceeded',
              `remote sandbox op timed out after ${opTimeoutMs}ms (op: ${payload.method}) — is the serve still running?`,
            ),
          );
        }
      }, opTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        send({ type: 'worker-op', id, op: payload });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
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
    send({ type: 'worker-sub', subId, sub });
    return () => {
      if (!subs.delete(subId)) return;
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
        if (msg.peerConnected) readyResolve();
        else readyReject(noTabError(serveUrl));
        return;
      }
      case 'worker-res': {
        const call = pending.get(msg.id);
        if (!call) return; // late (already timed out) — drop
        clearTimeout(call.timer);
        pending.delete(msg.id);
        if (msg.ok) {
          call.resolve(msg.value);
        } else {
          const code = msg.error?.code ?? 'unknown';
          let message = msg.error?.message ?? 'unknown sandbox error';
          // Enrich the bridge's generic no-peer error with actionable guidance.
          if (message === NO_SANDBOX_ERROR_MESSAGE) {
            message = noTabError(serveUrl).message;
          }
          call.reject(remoteError(code, message));
        }
        return;
      }
      case 'worker-snap': {
        const sub = subs.get(msg.subId);
        if (!sub) return; // unsubscribed — drop
        const value = (msg.value ?? {}) as Record<string, unknown>;
        if (value.__error) {
          const payload = value.__error as { code: string; message: string };
          const err = remoteError(payload.code, payload.message);
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

// ─── connect ───────────────────────────────────────────────────────────────

/**
 * Discover the running `pyric serve --bridge`, attach to its bridge WS as a
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

  let serveUrl: string;
  if (options.url) {
    serveUrl = options.url.replace(/\/$/, '');
  } else {
    const found = await discoverServe(cwd);
    if (!found) {
      throw remoteError(
        'not-found',
        'no running `pyric serve --bridge` found (looked for .pyric/serve.json in ' +
          `${cwd} and the default ports) — start your dev server with the bridge enabled and retry.`,
      );
    }
    serveUrl = found.base;
  }

  const wsUrl = `${serveUrl.replace(/^http/, 'ws')}/__pyric/sandbox`;
  const ws = new WebSocket(wsUrl);

  const core = createRemoteSandboxCore(
    { send: (msg) => ws.send(JSON.stringify(msg)) },
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

  return {
    serveUrl,
    channel: core.channel,
    rtdb: buildRemoteRtdb(core.channel),
    auth: buildRemoteAuthAdmin(core.channel),
    close() {
      core.dispose('remote sandbox connection closed by the client');
      try {
        ws.close();
      } catch {}
    },
  };
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

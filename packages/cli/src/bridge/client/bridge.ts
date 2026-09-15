/**
 * Browser-side bridge client. Connects an in-page `Sandbox` to a
 * running pyric bridge process over WebSocket. Once connected,
 * MCP tool calls reaching the bridge are forwarded here and
 * dispatched against the in-page `Sandbox`; results flow back
 * over the same WS.
 *
 * Discovery order for the bridge URL:
 *   1. Explicit `opts.url`.
 *   2. `window.__PYRIC_BRIDGE_URL__` (set by the Vite plugin).
 *   3. `ws://${location.hostname}:5174/sandbox` (sidecar default).
 *
 * Reconnect strategy: simple exponential backoff up to 30s. The
 * connection is best-effort — if the bridge is down the host app
 * keeps working; tool calls just won't reach an external agent.
 *
 * Standby: when the bridge closes this connection with the REPLACED code
 * (another tab registered and won the last-connection-wins slot), the client
 * does NOT re-hello — that would kick the winner right back out and the two
 * tabs would fight forever. It health-polls the serve origin at a gentle
 * jittered cadence and reconnects only once `sandboxConnected` is false
 * (the winning tab closed or refreshed). Every other close keeps the
 * immediate reconnect loop — that path is what makes tab-refresh takeover
 * work.
 */

import type { LocalSandbox } from 'pyric/sandbox';
import { BROWSER_FRAME_LIMIT_CLOSE_CODE, BRIDGE_FRAME_LIMIT_MESSAGE, encodeBridgeMessage } from '../frame-output.js';
import type {
  AuthLens,
  BridgeMessage,
  HelloFromClient,
  ToolCallRequest,
  ToolCallResponse,
  WorkerOpFrame,
  WorkerResFrame,
  WorkerSubFrame,
  WorkerOpPayload,
  WorkerSubPayload,
} from '../protocol.js';
import {
  isBridgeMessage,
  MAX_BRIDGE_FRAME_BYTES,
  assertJsonSafeRelayValue,
  PEER_REPLACED_CLOSE_CODE,
  WORKER_RELAY_CAPABILITY,
} from '../protocol.js';
import { dispatchSandboxTool, SANDBOX_TOOL_NAMES } from './dispatch.js';
import { bridgeHealthUrls, resolveBridgeUrl } from './bridge-url.js';

const utf8 = new TextEncoder();

export interface ConnectBridgeOptions {
  /**
   * Bridge WebSocket URL. Overrides the discovery chain.
   * Example: `ws://localhost:5174/sandbox`.
   */
  url?: string;
  /**
   * Stable identifier for this sandbox session — surfaces in the
   * bridge's audit log entries. Default: a random UUID per page load.
   */
  sandboxId?: string;
  /**
   * Custom tool dispatcher. Defaults to the built-in sandbox tool
   * dispatcher (see `./dispatch.ts`). Hosts can replace this to
   * extend the tool surface.
   */
  dispatcher?: SandboxToolDispatcher;
  /**
   * Tool names to advertise to the bridge in the hello message.
   * Defaults to `SANDBOX_TOOL_NAMES`. Override when supplying a
   * custom dispatcher.
   */
  toolNames?: string[];
  /** Initial reconnect delay in ms (default 500). */
  initialReconnectDelayMs?: number;
  /** Max reconnect delay in ms (default 30_000). */
  maxReconnectDelayMs?: number;
  /**
   * Standby poll interval in ms (default 2_000). When the bridge closes this
   * connection with the REPLACED code (another tab took the peer slot), the
   * client polls the health endpoint at this cadence — plus per-poll jitter,
   * so two standby tabs don't stampede a freshly vacant slot — and only
   * reconnects when `sandboxConnected` is false.
   */
  standbyPollMs?: number;
  /** Injectable fetch for the standby health poll (tests). Default: global. */
  fetchImpl?: typeof fetch;
  /**
   * Disable the auto-reconnect loop (useful in tests where the test
   * harness explicitly controls connection lifecycle).
   */
  noReconnect?: boolean;
  /** Called whenever the client transitions connection state. */
  onStateChange?: (state: ConnectedBridgeState) => void;
  /**
   * Generic worker relay (remote sandbox, slice 1). When supplied, the
   * client advertises the `worker-relay` capability in its hello and routes
   * `worker-op` / `worker-sub` / `worker-unsub` frames through it — on the
   * worker path this forwards them into the SharedWorker port
   * (`relayWorkerOp` / `relayWorkerSub` in `serve/worker/client.ts`).
   */
  workerRelay?: WorkerRelay;
}

/** Host-supplied handlers that forward relay frames into the SharedWorker. */
export interface WorkerRelay {
  /** Dispatch one worker op; resolves with the worker's `res.value`. */
  op(op: WorkerOpPayload, clientSessionId?: string): Promise<unknown>;
  /**
   * Register a worker subscription; `onValue` receives every snap value
   * (including the `{ __error }` establishment-failure convention).
   * Returns the unsubscribe function.
   */
  subscribe(
    sub: WorkerSubPayload,
    onValue: (value: unknown) => void,
    clientSessionId?: string,
  ): () => void;
  /** Teardown a remote consumer session's virtual port and listeners. */
  disconnect?(clientSessionId: string): void;
}

export type ConnectedBridgeState =
  | { kind: 'connecting' }
  | { kind: 'connected'; bridgeVersion: string }
  | { kind: 'disconnected'; reason: string }
  | { kind: 'reconnecting'; attempt: number; delayMs: number }
  /**
   * Another tab holds the peer slot (this connection was closed with the
   * REPLACED code). The client health-polls until the slot is vacant, then
   * reconnects. Distinct from `reconnecting`: the bridge is healthy and
   * deliberately serving a different tab.
   */
  | { kind: 'standby' };

export interface SandboxToolDispatcher {
  /**
   * Dispatch a tool call. Throws if the tool isn't recognised
   * (the bridge advertises only what this dispatcher reports it
   * can handle, so unknowns indicate wire-level drift).
   */
  (
    sandbox: LocalSandbox,
    name: string,
    args: Record<string, unknown>,
    /**
     * The identity the bridge holds for the MCP caller, from the `tool-call`
     * frame. Absent means the caller never impersonated (the bridge omits the
     * default `app-session`), and the dispatch runs as it always has.
     */
    actAs?: AuthLens,
    /** Stable MCP execution owner, independent of impersonated identity. */
    callerId?: string,
  ): Promise<{
    ok: boolean;
    summary: string;
    data?: unknown;
  }>;
}

export interface ConnectedBridge {
  /** Close the bridge connection. Does NOT close the underlying sandbox. */
  disconnect(): void;
  /** Current connection state. */
  state(): ConnectedBridgeState;
}

const DEFAULT_INITIAL_DELAY = 500;
const DEFAULT_MAX_DELAY = 30_000;
const DEFAULT_STANDBY_POLL_MS = 2_000;
/** Per-poll jitter as a fraction of the poll interval (0..50% added), so two
 *  standby tabs don't race a freshly vacant slot in lockstep. */
const STANDBY_POLL_JITTER_RATIO = 0.5;
/** Consecutive unreachable/unparseable health polls before standby gives up
 *  and falls back to the plain reconnect loop (a restarted server has a
 *  vacant slot but may briefly serve nothing). */
const STANDBY_MAX_POLL_FAILURES = 3;

export function connectBridge(
  sandbox: LocalSandbox,
  opts: ConnectBridgeOptions = {},
): ConnectedBridge {
  const url = resolveBridgeUrl(opts.url);
  const sandboxId = opts.sandboxId ?? randomId();
  const dispatcher = opts.dispatcher ?? dispatchSandboxTool;
  const toolNames = opts.toolNames ?? [...SANDBOX_TOOL_NAMES];
  const initialDelay = opts.initialReconnectDelayMs ?? DEFAULT_INITIAL_DELAY;
  const maxDelay = opts.maxReconnectDelayMs ?? DEFAULT_MAX_DELAY;
  const noReconnect = opts.noReconnect ?? false;
  const onStateChange = opts.onStateChange ?? (() => {});
  const standbyPollMs = opts.standbyPollMs ?? DEFAULT_STANDBY_POLL_MS;
  // Wrap rather than alias: an unbound `window.fetch` reference throws
  // "Illegal invocation" in browsers.
  const fetchImpl = opts.fetchImpl ?? ((input: Parameters<typeof fetch>[0]) => fetch(input));

  const workerRelay = opts.workerRelay ?? null;

  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let standbyTimer: ReturnType<typeof setTimeout> | null = null;
  let standbyPollFailures = 0;
  let currentState: ConnectedBridgeState = { kind: 'connecting' };
  /** Live relay subscriptions (bridge subId → worker unsubscribe). Torn down
   *  on every socket close: the bridge re-issues its registry to the NEXT
   *  registered peer, so keeping these would double-deliver. */
  const relaySubs = new Map<string, () => void>();

  function teardownRelaySubs() {
    for (const unsubscribe of relaySubs.values()) {
      try {
        unsubscribe();
      } catch {}
    }
    relaySubs.clear();
  }

  function setState(next: ConnectedBridgeState) {
    currentState = next;
    try {
      onStateChange(next);
    } catch {
      // host callback failures must not interrupt the loop.
    }
  }

  function send(msg: BridgeMessage) {
    const socket = ws;
    const canSend = socket !== null && socket.readyState === WebSocket.OPEN;
    if (canSend) {
      try {
        const payload = encodeBridgeMessage(msg);
        const exceedsFrameLimit = payload === undefined;
        if (exceedsFrameLimit) {
          socket.close(BROWSER_FRAME_LIMIT_CLOSE_CODE, BRIDGE_FRAME_LIMIT_MESSAGE);
          return;
        }
        socket.send(payload);
      } catch {
        // socket likely closing; reconnect will pick up after close event
      }
    }
  }

  function connect() {
    if (closed) return;
    setState({ kind: 'connecting' });
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (err) {
      const isError = err instanceof Error;
      const message = isError ? err.message : String(err);
      scheduleReconnect(`failed to open WebSocket: ${message}`);
      return;
    }
    ws = socket;

    socket.onopen = () => {
      attempt = 0;
      const hello: HelloFromClient = {
        type: 'hello',
        protocol: 1,
        tools: toolNames,
        sandboxId,
      };
      const hasWorkerRelay = workerRelay !== null;
      if (hasWorkerRelay) hello.capabilities = [WORKER_RELAY_CAPABILITY];
      send(hello);
    };

    socket.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      const isText = typeof data === 'string';
      const exceedsFrameLimit = isText && utf8.encode(data).byteLength > MAX_BRIDGE_FRAME_BYTES;
      if (exceedsFrameLimit) {
        socket.close(BROWSER_FRAME_LIMIT_CLOSE_CODE, BRIDGE_FRAME_LIMIT_MESSAGE);
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(isText ? data : '');
      } catch {
        return;
      }
      const parsed = value;
      const isUnrecognizedMessage = !isBridgeMessage(parsed);
      if (isUnrecognizedMessage) return;

      const acknowledgesPeer = parsed.type === 'hello-ack';
      if (acknowledgesPeer) {
        const isUnsupportedProtocol = parsed.protocol !== 1;
        if (isUnsupportedProtocol) {
          const reason = 'Unsupported bridge protocol. Expected version 1.';
          closed = true;
          setState({ kind: 'disconnected', reason });
          socket.close(1000, reason);
          return;
        }
        setState({ kind: 'connected', bridgeVersion: parsed.bridgeVersion });
        return;
      }
      const isToolCall = parsed.type === 'tool-call';
      if (isToolCall) {
        void handleToolCall(parsed);
        return;
      }
      const isWorkerOperation = parsed.type === 'worker-op';
      if (isWorkerOperation) {
        void handleWorkerOp(parsed);
        return;
      }
      const isWorkerSubscription = parsed.type === 'worker-sub';
      if (isWorkerSubscription) {
        handleWorkerSub(parsed);
        return;
      }
      const isWorkerUnsubscribe = parsed.type === 'worker-unsub';
      if (isWorkerUnsubscribe) {
        const unsubscribe = relaySubs.get(parsed.subId);
        const hasSubscription = unsubscribe !== undefined;
        if (hasSubscription) {
          relaySubs.delete(parsed.subId);
          try {
            unsubscribe();
          } catch {}
        }
        return;
      }
      const disconnectsWorkerClient = parsed.type === 'worker-client-disconnect';
      if (disconnectsWorkerClient) {
        workerRelay?.disconnect?.(parsed.clientSessionId);
        return;
      }
      const isPing = parsed.type === 'ping';
      if (isPing) {
        send({ type: 'pong', id: parsed.id });
        return;
      }
      // Other message types (tool-result, pong, hello) are peer-only; ignore.
    };

    socket.onclose = (event: CloseEvent) => {
      const reason = event.reason || `closed (code ${event.code})`;
      ws = null;
      // Relay subs are per-connection: the bridge owns the durable registry
      // and re-issues it after the next hello, so live worker listeners from
      // THIS connection must go now (or the next connection double-delivers).
      teardownRelaySubs();
      const isReplacedByPeer = event.code === PEER_REPLACED_CLOSE_CODE;
      if (isReplacedByPeer) {
        // Another tab won the peer slot. Re-helloing now would kick it right
        // back out (last-connection-wins) and the two tabs would fight over
        // the slot forever — re-firing every relayed subscription and
        // failing all in-flight worker ops once per cycle. Go standby:
        // health-poll until the slot is genuinely vacant.
        enterStandby();
        return;
      }
      scheduleReconnect(reason);
    };

    socket.onerror = () => {
      // The browser doesn't provide error detail; rely on onclose
      // for the reconnect trigger.
    };
  }

  async function handleToolCall(req: ToolCallRequest) {
    let response: ToolCallResponse;
    try {
      const result = await dispatcher(sandbox, req.name, req.args ?? {}, req.actAs, req.callerId);
      response = {
        type: 'tool-result',
        id: req.id,
        ok: true,
        result,
      };
    } catch (err) {
      const isError = err instanceof Error;
      response = {
        type: 'tool-result',
        id: req.id,
        ok: false,
        error: {
          code: isError ? err.name : 'Error',
          message: isError ? err.message : String(err),
        },
      };
    }
    send(response);
  }

  async function handleWorkerOp(req: WorkerOpFrame) {
    const hasNoWorkerRelay = workerRelay === null;
    if (hasNoWorkerRelay) return; // capability not advertised — drop (wire drift)
    try {
      const value = await workerRelay.op(req.op, req.clientSessionId);
      // Anti-corruption guard: a Blob/ArrayBuffer/TypedArray result would be
      // SILENTLY mangled by the JSON WS legs ({} / index-keyed object) — turn
      // it into a loud error naming the base64 storage ops instead.
      assertJsonSafeRelayValue(`op '${req.op.method}'`, value);
      send({ type: 'worker-res', id: req.id, clientSessionId: req.clientSessionId, ok: true, value });
    } catch (err) {
      const denialContext = (err as { denialContext?: unknown }).denialContext;
      const isError = err instanceof Error;
      const error: NonNullable<WorkerResFrame['error']> = {
        code: (err as { code?: string }).code ?? 'unknown',
        message: isError ? err.message : String(err),
      };
      // Structured denial context stays JSON-safe across the relay.
      const hasDenialContext = denialContext !== undefined;
      if (hasDenialContext) error.denialContext = denialContext;
      send({
        type: 'worker-res',
        id: req.id,
        clientSessionId: req.clientSessionId,
        ok: false,
        error,
      });
    }
  }

  function handleWorkerSub(req: WorkerSubFrame) {
    const hasNoWorkerRelay = workerRelay === null;
    if (hasNoWorkerRelay) return; // capability not advertised — drop (wire drift)
    const isAlreadySubscribed = relaySubs.has(req.subId);
    if (isAlreadySubscribed) return;
    try {
      const unsubscribe = workerRelay.subscribe(req.sub, (value) => {
        // Same anti-corruption guard as handleWorkerOp: a binary snap value
        // would be silently mangled by the JSON WS legs — fail the sub with
        // the snap-error convention (routes to onError on the Node side)
        // instead of delivering garbage.
        try {
          assertJsonSafeRelayValue(`subscription '${req.subId}'`, value);
        } catch (err) {
          const isError = err instanceof Error;
          send({
            type: 'worker-snap',
            subId: req.subId,
            clientSessionId: req.clientSessionId,
            value: {
              __error: {
                code: (err as { code?: string }).code ?? 'invalid-argument',
                message: isError ? err.message : String(err),
              },
            },
          });
          return;
        }
        send({ type: 'worker-snap', subId: req.subId, clientSessionId: req.clientSessionId, value });
      }, req.clientSessionId);
      relaySubs.set(req.subId, unsubscribe);
    } catch (err) {
      // Synchronous establishment failure — relay it via the worker host's
      // snap-error convention so the far side's subscribe can reject.
      const denialContext = (err as { denialContext?: unknown }).denialContext;
      const isError = err instanceof Error;
      const error: NonNullable<WorkerResFrame['error']> = {
        code: (err as { code?: string }).code ?? 'unknown',
        message: isError ? err.message : String(err),
      };
      const hasDenialContext = denialContext !== undefined;
      if (hasDenialContext) error.denialContext = denialContext;
      send({
        type: 'worker-snap',
        subId: req.subId,
        clientSessionId: req.clientSessionId,
        value: {
          __error: error,
        },
      });
    }
  }

  // ── Standby: another tab holds the peer slot ─────────────────────────────

  function enterStandby() {
    if (closed) return;
    if (noReconnect) {
      setState({ kind: 'disconnected', reason: 'replaced by a newer sandbox peer' });
      return;
    }
    attempt = 0;
    standbyPollFailures = 0;
    setState({ kind: 'standby' });
    scheduleStandbyPoll();
  }

  function scheduleStandbyPoll() {
    if (closed) return;
    const delay = standbyPollMs * (1 + Math.random() * STANDBY_POLL_JITTER_RATIO);
    standbyTimer = setTimeout(() => {
      standbyTimer = null;
      void pollForVacantSlot();
    }, delay);
  }

  async function pollForVacantSlot(): Promise<void> {
    if (closed) return;
    // null = health unreadable (unreachable / non-JSON / shape drift).
    let vacant: boolean | null = null;
    for (const target of bridgeHealthUrls(url)) {
      try {
        const res = await fetchImpl(target);
        const hasFailedResponse = !res.ok;
        if (hasFailedResponse) continue;
        const body = (await res.json()) as { sandboxConnected?: unknown };
        const hasPeerStatus = typeof body.sandboxConnected === 'boolean';
        if (hasPeerStatus) {
          vacant = !body.sandboxConnected;
          break;
        }
      } catch {
        // try the next candidate
      }
    }
    if (closed) return;
    const hasVacantSlot = vacant === true;
    if (hasVacantSlot) {
      // The winning tab is gone (refresh / close) — claim the slot. The
      // bridge replays its sub registry to us on hello; its re-issue dedup
      // keeps unchanged listeners quiet.
      connect();
      return;
    }
    const hasActivePeer = vacant === false;
    if (hasActivePeer) {
      standbyPollFailures = 0;
      scheduleStandbyPoll();
      return;
    }
    // Health unreadable: a restarting server has a vacant slot but may
    // briefly serve nothing. After a few consecutive failures fall back to
    // the plain reconnect loop rather than idling in standby forever.
    standbyPollFailures += 1;
    const hasRepeatedPollFailures = standbyPollFailures >= STANDBY_MAX_POLL_FAILURES;
    if (hasRepeatedPollFailures) {
      scheduleReconnect('standby health poll unreachable');
      return;
    }
    scheduleStandbyPoll();
  }

  function scheduleReconnect(reason: string) {
    if (closed) return;
    if (noReconnect) {
      setState({ kind: 'disconnected', reason });
      return;
    }
    attempt += 1;
    const delay = Math.min(initialDelay * 2 ** (attempt - 1), maxDelay);
    setState({ kind: 'reconnecting', attempt, delayMs: delay });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  // Boot the loop.
  connect();

  return {
    disconnect() {
      closed = true;
      teardownRelaySubs();
      const pendingReconnect = reconnectTimer;
      const hasReconnectTimer = pendingReconnect !== null;
      if (hasReconnectTimer) {
        clearTimeout(pendingReconnect);
        reconnectTimer = null;
      }
      const pendingStandby = standbyTimer;
      const hasStandbyTimer = pendingStandby !== null;
      if (hasStandbyTimer) {
        clearTimeout(pendingStandby);
        standbyTimer = null;
      }
      const socket = ws;
      const hasSocket = socket !== null;
      if (hasSocket) {
        try {
          socket.close();
        } catch {
          // ignore
        }
        ws = null;
      }
      setState({ kind: 'disconnected', reason: 'client closed' });
    },
    state() {
      return currentState;
    },
  };
}

// ── Internal helpers ─────────────────────────────────────────────────

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for ancient environments.
  return `sb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

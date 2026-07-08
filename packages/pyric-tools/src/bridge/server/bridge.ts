/**
 * Bridge core — process-local state for forwarding MCP tool calls
 * from external clients to the (one) connected sandbox peer in the
 * browser. Transport-agnostic: the HTTP MCP server and the WS server
 * both plug into this through `dispatch()` / `handleSandboxMessage()`
 * / `registerSandboxPeer()`.
 *
 * Multi-tab is naive: last-connection-wins. New peer replaces the
 * old, pending calls against the old peer reject with a clear error.
 *
 * Mode determines architecture:
 *  - sandbox: every tool call is forwarded over WS to the browser.
 *    The bridge does not execute tools itself; it acts as a relay
 *    with a tool-name allow-list pinned by the peer's `hello`.
 *  - prod: tools execute in-process via `composeMcpRegistry` with
 *    the supplied `scope` + `adminDeps`. No peer needed.
 */

import { randomUUID } from 'node:crypto';
import type {
  BridgeMessage,
  BridgeMode,
  HealthReport,
  ToolCallResponse,
  WorkerOpPayload,
  WorkerSubPayload,
  WorkerResFrame,
  WorkerSnapFrame,
} from '../protocol.js';
import {
  NO_SANDBOX_ERROR_MESSAGE,
  NO_WORKER_RELAY_ERROR_MESSAGE,
  WORKER_RELAY_CAPABILITY,
} from '../protocol.js';
import type { ConfirmHandler, ConfirmDecision } from './confirm.js';

/** Subset of `@inbrowser/agent`'s `ToolResult` shape the bridge emits. */
export interface BridgeToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
}

/** Function the bridge calls to send a message to the current sandbox peer. */
export type SendToPeer = (msg: BridgeMessage) => void;

export interface BridgeOptions {
  /** Mode set at process start; switching requires restart. */
  mode: BridgeMode;
  /**
   * Project id surfaced in /health and audit-log paths. For sandbox
   * mode, default is `'sandbox'`. For prod mode, required (typically
   * the Firebase project id).
   */
  project?: string;
  /** Bridge version surfaced in /health + Hello messages. */
  version: string;
  /**
   * Per-call request timeout in ms when forwarding to the browser.
   * Defaults to 30s; the bridge rejects the MCP call with a clear
   * "sandbox call timed out" error after this.
   */
  callTimeoutMs?: number;
  /**
   * Hook called whenever a tool finishes (success or failure).
   * Use this for the audit log — write the entry to disk here.
   * The bridge does not own audit-log persistence.
   */
  onToolEvent?: (event: BridgeToolEvent) => void;
  /**
   * Per-action confirmation handler. Required for prod-mode bridges
   * to gate dangerous tools on real human approval (see
   * the design rationale). The wrapper in
   * `mcp.ts` consults this handler before invoking each in-process
   * prod tool. Sandbox mode ignores it (forwarded tool calls are
   * not gated; the browser sandbox is the trust boundary).
   *
   * If omitted in prod mode, the standalone server installs a
   * `createDenyAllHandler()` as a fail-safe.
   */
  confirmHandler?: ConfirmHandler;
}

export interface BridgeToolEvent {
  timestamp: string;
  mode: BridgeMode;
  project: string;
  tool: string;
  args: Record<string, unknown>;
  result: BridgeToolResult | { ok: false; summary: string; error?: { code: string; message: string } };
  durationMs: number;
  /**
   * Confirmation decision for prod-mode in-process tools. Omitted
   * for sandbox-forwarded calls (no confirmation needed) and for
   * prod calls that ran with no handler configured (a misconfig).
   */
  confirmation?: {
    policy: string;
    decision: 'approved' | 'denied';
    reason: ConfirmDecision['reason'];
    elapsed_ms: number;
    prompt_shown_at?: string;
  };
}

export interface Bridge {
  readonly mode: BridgeMode;
  readonly project: string;
  readonly version: string;
  readonly startedAt: string;
  /** Stable per-process identity (see HealthReport.instanceId). */
  readonly instanceId: string;
  /** Confirmation handler; null in sandbox mode. */
  readonly confirmHandler: ConfirmHandler | null;
  /**
   * Record a tool event in the bridge's audit pipeline. Called by
   * the in-process tool wrapper in `mcp.ts` after a prod tool
   * finishes (whether it ran or was denied). Sandbox-forwarded
   * tools log via the existing onToolEvent path inside dispatch().
   */
  recordToolEvent(event: BridgeToolEvent): void;

  /**
   * Register a browser-side peer. Returns a disconnect function the
   * caller MUST invoke when the WS closes. Last-wins: a new
   * registration disconnects the previous peer (its pending calls
   * fail with a clear error).
   *
   * `capabilities` come from the peer's `hello` — the bridge only sends
   * `worker-*` frames to a peer that declared `'worker-relay'`.
   */
  registerSandboxPeer(
    send: SendToPeer,
    tools: string[],
    sandboxId: string,
    capabilities?: string[],
  ): () => void;

  /** True if a sandbox peer is currently registered. */
  isSandboxConnected(): boolean;

  /**
   * Generation counter of the CURRENT peer registration (0 = no peer has
   * ever registered). The transport captures this right after registering
   * and tags every inbound message with it, so a frame arriving on a
   * REPLACED peer's socket (tab refresh mid-flight) can never resolve a new
   * peer's pending call or deliver a stale subscription snapshot.
   */
  peerGeneration(): number;

  /** Tool names the bridge currently exposes to MCP. */
  toolNames(): string[];

  /** Dispatch a tool call. Forwards to peer in sandbox mode. */
  dispatch(name: string, args: Record<string, unknown>): Promise<BridgeToolResult>;

  /**
   * Relay a generic worker op to the peer's SharedWorker. Resolves with the
   * worker's `res.value`; rejects with an Error carrying `.code` on worker
   * failure, timeout, no peer, or a peer without the worker relay.
   */
  dispatchWorkerOp(op: WorkerOpPayload): Promise<unknown>;

  /**
   * Register a worker subscription. Ownership lives HERE: the registry
   * survives peer churn, and every registered sub is re-issued to a new
   * peer on registration (RTDB value / auth-state subs re-deliver a fresh
   * initial snapshot, so replay is cursor-free). `onSnap` receives every
   * relayed snap value verbatim — including the worker host's
   * `{ __error: { code, message } }` establishment-failure convention.
   * Returns the unsubscribe function.
   */
  subscribeWorker(sub: WorkerSubPayload, onSnap: (value: unknown) => void): () => void;

  /**
   * Handle a message from the sandbox peer (tool-result, pong, …).
   * `generation` is the peer generation the transport captured at
   * registration; when provided, `worker-res`/`worker-snap` frames from a
   * stale generation are dropped.
   */
  handleSandboxMessage(msg: BridgeMessage, generation?: number): void;

  /** /health endpoint payload. */
  health(): HealthReport;
}

interface PendingCall {
  id: string;
  resolve: (result: BridgeToolResult) => void;
  timer: ReturnType<typeof setTimeout>;
  tool: string;
}

interface ActivePeer {
  send: SendToPeer;
  tools: Set<string>;
  sandboxId: string;
  capabilities: Set<string>;
}

interface PendingWorkerOp {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

interface WorkerSubEntry {
  sub: WorkerSubPayload;
  onSnap: (value: unknown) => void;
}

/** Build the typed Error worker-op rejections carry. */
function workerOpError(code: string, message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

export function createBridge(opts: BridgeOptions): Bridge {
  const mode = opts.mode;
  const project = opts.project ?? (mode === 'sandbox' ? 'sandbox' : 'unknown');
  const version = opts.version;
  const callTimeoutMs = opts.callTimeoutMs ?? 30_000;
  const startedAt = new Date().toISOString();
  // Per-process identity (see HealthReport.instanceId): the discovery pointer
  // records this so a proxy can verify it reached THIS server, not a different
  // sandbox squatting the same port on the other loopback family.
  const instanceId = randomUUID();
  const onToolEvent = opts.onToolEvent;
  const confirmHandler = opts.confirmHandler ?? null;

  let peer: ActivePeer | null = null;
  const pending = new Map<string, PendingCall>();
  // ── worker relay state ──
  // Generation counter: bumped on every peer registration. Inbound frames
  // tagged with an older generation are stale (a replaced tab's socket) and
  // must not resolve ops / deliver snaps registered under the new peer.
  let generation = 0;
  const workerPending = new Map<string, PendingWorkerOp>();
  // Subscription ownership lives on the bridge: entries survive peer churn
  // and are re-issued to every newly registered relay-capable peer.
  const workerSubs = new Map<string, WorkerSubEntry>();

  function failAllPending(reason: string) {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.resolve({
        ok: false,
        summary: reason,
      });
    }
    pending.clear();
    for (const op of workerPending.values()) {
      clearTimeout(op.timer);
      op.reject(workerOpError('unavailable', reason));
    }
    workerPending.clear();
  }

  function peerHasRelay(): boolean {
    return peer !== null && peer.capabilities.has(WORKER_RELAY_CAPABILITY);
  }

  function registerSandboxPeer(
    send: SendToPeer,
    tools: string[],
    sandboxId: string,
    capabilities: string[] = [],
  ): () => void {
    if (peer) {
      // Last-wins: kick the old peer and reject its pending calls.
      failAllPending('sandbox peer replaced by a newer connection');
    }
    generation += 1;
    const myPeer: ActivePeer = {
      send,
      tools: new Set(tools),
      sandboxId,
      capabilities: new Set(capabilities),
    };
    peer = myPeer;
    // Re-issue every registered worker subscription to the new peer. RTDB
    // value / auth-state semantics make this safe and cursor-free: each
    // (re)subscribe delivers a fresh initial snapshot and consumers are
    // last-value-wins, so the Node side just sees one extra snapshot.
    if (myPeer.capabilities.has(WORKER_RELAY_CAPABILITY)) {
      for (const [subId, entry] of workerSubs) {
        try {
          myPeer.send({ type: 'worker-sub', subId, sub: entry.sub });
        } catch {
          // Socket failure surfaces via the transport's close handler.
        }
      }
    }
    return () => {
      if (peer === myPeer) {
        failAllPending(NO_SANDBOX_ERROR_MESSAGE);
        peer = null;
      }
    };
  }

  function isSandboxConnected(): boolean {
    return peer !== null;
  }

  function peerGeneration(): number {
    return generation;
  }

  function toolNames(): string[] {
    if (mode === 'sandbox') {
      return peer ? Array.from(peer.tools).sort() : [];
    }
    // Prod mode: caller provides tool names via composeMcpRegistry
    // wiring. Bridge core doesn't own that registry; the caller
    // (standalone server or vite plugin) supplies dispatch handlers
    // for prod tools directly. See createProdBridge in standalone.ts.
    return [];
  }

  async function dispatch(
    name: string,
    args: Record<string, unknown>,
  ): Promise<BridgeToolResult> {
    const startedAtMs = Date.now();
    let result: BridgeToolResult;
    try {
      if (mode === 'sandbox') {
        result = await dispatchSandbox(name, args);
      } else {
        // Prod mode dispatch is wired by the caller (standalone or
        // vite plugin) when constructing the MCP server. createBridge
        // itself only models sandbox-mode forwarding. Calling
        // dispatch() on a prod bridge therefore indicates a wiring
        // error.
        result = {
          ok: false,
          summary: 'bridge.dispatch() called in prod mode — prod tools dispatch via composeMcpRegistry directly, not through the bridge',
        };
      }
    } catch (err) {
      result = {
        ok: false,
        summary: err instanceof Error ? err.message : String(err),
      };
    }
    if (onToolEvent) {
      try {
        onToolEvent({
          timestamp: new Date(startedAtMs).toISOString(),
          mode,
          project,
          tool: name,
          args,
          result,
          durationMs: Date.now() - startedAtMs,
        });
      } catch {
        // Audit-log failures must not break tool dispatch.
      }
    }
    return result;
  }

  function dispatchSandbox(
    name: string,
    args: Record<string, unknown>,
  ): Promise<BridgeToolResult> {
    if (!peer) {
      return Promise.resolve({ ok: false, summary: NO_SANDBOX_ERROR_MESSAGE });
    }
    if (!peer.tools.has(name)) {
      return Promise.resolve({
        ok: false,
        summary: `tool '${name}' is not registered with the connected sandbox peer`,
      });
    }
    return new Promise<BridgeToolResult>((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          resolve({
            ok: false,
            summary: `sandbox call timed out after ${callTimeoutMs}ms (tool: ${name})`,
          });
        }
      }, callTimeoutMs);
      pending.set(id, { id, resolve, timer, tool: name });
      try {
        peer!.send({
          type: 'tool-call',
          id,
          name,
          args,
        });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        resolve({
          ok: false,
          summary: `failed to send tool call to sandbox: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  }

  function dispatchWorkerOp(op: WorkerOpPayload): Promise<unknown> {
    if (!peer) {
      return Promise.reject(workerOpError('unavailable', NO_SANDBOX_ERROR_MESSAGE));
    }
    if (!peerHasRelay()) {
      return Promise.reject(workerOpError('unimplemented', NO_WORKER_RELAY_ERROR_MESSAGE));
    }
    return new Promise<unknown>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        if (workerPending.has(id)) {
          workerPending.delete(id);
          reject(
            workerOpError(
              'deadline-exceeded',
              `sandbox worker op timed out after ${callTimeoutMs}ms (op: ${op.method})`,
            ),
          );
        }
      }, callTimeoutMs);
      workerPending.set(id, { resolve, reject, timer, method: op.method });
      try {
        peer!.send({ type: 'worker-op', id, op });
      } catch (err) {
        clearTimeout(timer);
        workerPending.delete(id);
        reject(
          workerOpError(
            'unavailable',
            `failed to send worker op to sandbox: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });
  }

  function subscribeWorker(
    sub: WorkerSubPayload,
    onSnap: (value: unknown) => void,
  ): () => void {
    const subId = randomUUID();
    workerSubs.set(subId, { sub, onSnap });
    if (peerHasRelay()) {
      try {
        peer!.send({ type: 'worker-sub', subId, sub });
      } catch {
        // Socket failure surfaces via the transport's close handler; the
        // registry entry replays on the next peer registration.
      }
    }
    // No peer (or a relay-less peer) is NOT an error here: the registry is
    // replayed on the next registration, mirroring RTDB's offline semantics.
    return () => {
      if (!workerSubs.delete(subId)) return;
      if (peerHasRelay()) {
        try {
          peer!.send({ type: 'worker-unsub', subId });
        } catch {}
      }
    };
  }

  function handleSandboxMessage(msg: BridgeMessage, msgGeneration?: number): void {
    // Frames from a REPLACED peer's socket must not act on the current
    // peer's state (subscriptions make stale delivery likely on tab
    // refresh: the old tab's worker port keeps firing until its WS dies).
    const stale = msgGeneration !== undefined && msgGeneration !== generation;
    switch (msg.type) {
      case 'worker-res': {
        if (stale) return;
        const res = msg as WorkerResFrame;
        const op = workerPending.get(res.id);
        if (!op) return; // late or unknown — drop silently
        clearTimeout(op.timer);
        workerPending.delete(res.id);
        if (res.ok) {
          op.resolve(res.value);
        } else {
          op.reject(
            workerOpError(res.error?.code ?? 'unknown', res.error?.message ?? 'unknown sandbox error'),
          );
        }
        return;
      }
      case 'worker-snap': {
        if (stale) return;
        const snap = msg as WorkerSnapFrame;
        const entry = workerSubs.get(snap.subId);
        if (!entry) return; // unsubscribed or unknown — drop silently
        try {
          entry.onSnap(snap.value);
        } catch {
          // Consumer callback failures must not break the relay loop.
        }
        return;
      }
      default:
        break;
    }
    switch (msg.type) {
      case 'tool-result': {
        const response = msg as ToolCallResponse;
        const call = pending.get(response.id);
        if (!call) return; // late or unknown — drop silently
        clearTimeout(call.timer);
        pending.delete(response.id);
        if (response.ok && response.result) {
          call.resolve({
            ok: response.result.ok,
            summary: response.result.summary,
            data: response.result.data,
          });
        } else {
          const error = response.error;
          call.resolve({
            ok: false,
            summary: error?.message ?? 'unknown sandbox error',
          });
        }
        break;
      }
      case 'pong': {
        // Keepalive ack; no-op.
        break;
      }
      case 'ping': {
        // Browser-initiated ping; echo back.
        if (peer) {
          peer.send({ type: 'pong', id: msg.id });
        }
        break;
      }
      case 'hello': {
        // Re-hello after reconnect would arrive here, but the
        // registration path is owned by the transport layer (it sees
        // the WS first). Ignore.
        break;
      }
      default:
        break;
    }
  }

  function health(): HealthReport {
    return {
      status: 'ok',
      mode,
      project,
      sandboxConnected: peer !== null,
      version,
      startedAt,
      instanceId,
    };
  }

  function recordToolEvent(event: BridgeToolEvent): void {
    if (!onToolEvent) return;
    try {
      onToolEvent(event);
    } catch {
      // Audit-log failures must not break tool dispatch.
    }
  }

  return {
    mode,
    project,
    version,
    startedAt,
    instanceId,
    confirmHandler,
    recordToolEvent,
    registerSandboxPeer,
    isSandboxConnected,
    peerGeneration,
    toolNames,
    dispatch,
    dispatchWorkerOp,
    subscribeWorker,
    handleSandboxMessage,
    health,
  };
}

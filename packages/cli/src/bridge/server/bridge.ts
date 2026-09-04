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
 * Every tool call is forwarded over WS to the browser. The bridge does not
 * execute data-plane tools itself; it acts as a relay with a tool-name
 * allow-list pinned by the peer's `hello`.
 */

import { randomUUID } from 'node:crypto';
import type {
  BridgeMessage,
  HealthReport,
  RemoteSetLensFrame,
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
import { createConsumerRegistry, type ConsumerRegistry } from './consumer-registry.js';

/** Subset of `@inbrowser/agent`'s `ToolResult` shape the bridge emits. */
export interface BridgeToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
}

/** Function the bridge calls to send a message to the current sandbox peer. */
export type SendToPeer = (msg: BridgeMessage) => void;

export interface BridgeOptions {
  /** Sandbox label surfaced in /health and audit-log paths. */
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
}

export interface BridgeToolEvent {
  timestamp: string;
  mode: 'sandbox';
  project: string;
  tool: string;
  args: Record<string, unknown>;
  result: BridgeToolResult | { ok: false; summary: string; error?: { code: string; message: string } };
  durationMs: number;
}

export interface Bridge {
  readonly project: string;
  readonly version: string;
  readonly startedAt: string;
  /** Stable per-process identity (see HealthReport.instanceId). */
  readonly instanceId: string;
  /** Registry of connected remote consumers. */
  readonly consumers: ConsumerRegistry;
  /** Broadcast presence snapshot to sandbox peer and Studio consumers. */
  broadcastConsumerPresence(): void;
  /**
   * Record a tool event in the bridge's audit pipeline. In-process sandbox
   * tools use this path; forwarded tools log inside dispatch().
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
   *
   * `onReplaced` fires when a NEWER registration displaces this peer. The
   * transport MUST use it to close the old socket: the browser side's
   * close handler tears down its relayed worker subscriptions — without
   * this, a replaced tab's SharedWorker listeners would live until the tab
   * closed, streaming snaps the bridge drops as stale-generation forever.
   */
  registerSandboxPeer(
    send: SendToPeer,
    tools: string[],
    sandboxId: string,
    capabilities?: string[],
    onReplaced?: () => void,
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

  /** Dispatch a tool call to the connected sandbox peer. */
  dispatch(name: string, args: Record<string, unknown>): Promise<BridgeToolResult>;

  /**
   * Relay a generic worker op to the peer's SharedWorker. Resolves with the
   * worker's `res.value`; rejects with an Error carrying `.code`.
   */
  dispatchWorkerOp(op: WorkerOpPayload, clientSessionId?: string): Promise<unknown>;

  /**
   * Register a worker subscription. Survives peer churn and is re-issued.
   * Returns the unsubscribe function.
   */
  subscribeWorker(
    sub: WorkerSubPayload,
    onSnap: (value: unknown) => void,
    clientSessionId?: string,
  ): () => void;

  /** Detach an in-flight consumer's pending ops without notifying peer or tombstoning session. */
  detachConsumer(clientSessionId: string): void;

  /** Tear down consumer subscriptions, cancel pending ops, and notify peer. */
  disconnectConsumer(clientSessionId: string): void;

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
  onReplaced?: () => void;
}

interface PendingWorkerOp {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
  clientSessionId?: string;
}

interface WorkerSubEntry {
  sub: WorkerSubPayload;
  onSnap: (value: unknown) => void;
  clientSessionId?: string;
  /** JSON of the last snap value delivered to `onSnap` (re-issue dedup baseline). */
  lastDeliveredJson?: string;
  /** Set when re-issued to a newly registered peer to suppress byte-identical initial snaps. */
  awaitingReissueSnap?: boolean;
}

/** Build the typed Error worker-op rejections carry. `denialContext` (spike
 *  gap 6) is re-attached when the wire error carried one, so the structured
 *  denial frame survives the bridge hop. */
function workerOpError(
  code: string,
  message: string,
  denialContext?: unknown,
  envelope?: unknown,
): Error & { code: string; denialContext?: unknown; envelope?: unknown } {
  return Object.assign(new Error(message), {
    code,
    ...(denialContext !== undefined ? { denialContext } : {}),
    ...(envelope !== undefined ? { envelope } : {}),
  });
}

export function createBridge(opts: BridgeOptions): Bridge {
  const project = opts.project ?? 'sandbox';
  const version = opts.version;
  const callTimeoutMs = opts.callTimeoutMs ?? 30_000;
  const startedAt = new Date().toISOString();
  const instanceId = randomUUID();
  const onToolEvent = opts.onToolEvent;

  let peer: ActivePeer | null = null;
  const pending = new Map<string, PendingCall>();
  let generation = 0;
  const workerPending = new Map<string, PendingWorkerOp>();
  const workerSubs = new Map<string, WorkerSubEntry>();
  const consumers = createConsumerRegistry();

  function broadcastConsumerPresence(): void {
    consumers.broadcastPresence(peer ? peer.send : undefined);
  }

  function failAllPending(reason: string) {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.resolve({ ok: false, summary: reason });
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
    onReplaced?: () => void,
  ): () => void {
    if (peer) {
      // Last-wins: kick the old peer and reject its pending calls.
      failAllPending('sandbox peer replaced by a newer connection');
      // Tear the old peer down (the transport closes its socket). The
      // browser's close handler tears down its relayed worker
      // subscriptions — otherwise the replaced tab's SharedWorker
      // listeners would keep posting snaps this bridge drops as
      // stale-generation until the tab closed.
      try {
        peer.onReplaced?.();
      } catch {
        // A failing transport hook must not block the new registration.
      }
    }
    generation += 1;
    const myPeer: ActivePeer = {
      send,
      tools: new Set(tools),
      sandboxId,
      capabilities: new Set(capabilities),
      onReplaced,
    };
    peer = myPeer;
    // Re-issue every registered worker subscription to the new peer — the
    // replay is cursor-free because each (re)subscribe delivers a fresh
    // initial snapshot. That snapshot is a DUPLICATE whenever nothing
    // changed while the peer churned, so `awaitingReissueSnap` arms the
    // per-sub dedup (see WorkerSubEntry) — without it, tabs cycling through
    // last-wins registration re-fire every consumer listener with
    // byte-identical data on every registration.
    if (myPeer.capabilities.has(WORKER_RELAY_CAPABILITY)) {
      for (const [subId, entry] of workerSubs) {
        entry.awaitingReissueSnap = true;
        try {
          myPeer.send({
            type: 'worker-sub',
            subId,
            clientSessionId: entry.clientSessionId,
            sub: entry.sub,
          });
        } catch {}
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
    return peer ? Array.from(peer.tools).sort() : [];
  }

  async function dispatch(
    name: string,
    args: Record<string, unknown>,
  ): Promise<BridgeToolResult> {
    const startedAtMs = Date.now();
    let result: BridgeToolResult;
    try {
      result = await dispatchSandbox(name, args);
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
          mode: 'sandbox',
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
    if (!peer) return Promise.resolve({ ok: false, summary: NO_SANDBOX_ERROR_MESSAGE });
    if (!peer.tools.has(name)) {
      return Promise.resolve({ ok: false, summary: `tool '${name}' is not registered with the connected sandbox peer` });
    }
    return new Promise<BridgeToolResult>((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        if (pending.delete(id)) {
          resolve({ ok: false, summary: `sandbox call timed out after ${callTimeoutMs}ms (tool: ${name})` });
        }
      }, callTimeoutMs);
      pending.set(id, { id, resolve, timer, tool: name });
      try {
        peer!.send({ type: 'tool-call', id, name, args });
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        resolve({ ok: false, summary: `failed to send tool call to sandbox: ${err instanceof Error ? err.message : String(err)}` });
      }
    });
  }

  function dispatchWorkerOp(op: WorkerOpPayload, clientSessionId?: string): Promise<unknown> {
    if (!peer) return Promise.reject(workerOpError('unavailable', NO_SANDBOX_ERROR_MESSAGE));
    if (!peerHasRelay()) return Promise.reject(workerOpError('unimplemented', NO_WORKER_RELAY_ERROR_MESSAGE));
    return new Promise<unknown>((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        if (workerPending.delete(id)) {
          reject(workerOpError('deadline-exceeded', `sandbox worker op timed out after ${callTimeoutMs}ms (op: ${op.method})`));
        }
      }, callTimeoutMs);
      workerPending.set(id, { resolve, reject, timer, method: op.method, clientSessionId });
      try {
        peer!.send({ type: 'worker-op', id, clientSessionId, op });
      } catch (err) {
        clearTimeout(timer);
        workerPending.delete(id);
        reject(workerOpError('unavailable', `failed to send worker op to sandbox: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  }

  function subscribeWorker(
    sub: WorkerSubPayload,
    onSnap: (value: unknown) => void,
    clientSessionId?: string,
  ): () => void {
    const subId = randomUUID();
    workerSubs.set(subId, { sub, onSnap, clientSessionId });
    if (peerHasRelay()) {
      try {
        peer!.send({ type: 'worker-sub', subId, clientSessionId, sub });
      } catch {}
    }
    return () => {
      const entry = workerSubs.get(subId);
      if (!workerSubs.delete(subId)) return;
      if (peerHasRelay()) {
        try {
          peer!.send({ type: 'worker-unsub', subId, clientSessionId: entry?.clientSessionId });
        } catch {}
      }
    };
  }

  function detachConsumer(clientSessionId: string): void {
    for (const [id, op] of workerPending) {
      if (op.clientSessionId === clientSessionId) {
        clearTimeout(op.timer);
        workerPending.delete(id);
        op.reject(workerOpError('unavailable', 'consumer socket detached'));
      }
    }
  }

  function disconnectConsumer(clientSessionId: string): void {
    for (const [subId, entry] of workerSubs) {
      if (entry.clientSessionId === clientSessionId) {
        workerSubs.delete(subId);
        if (peerHasRelay()) {
          try { peer!.send({ type: 'worker-unsub', subId, clientSessionId }); } catch {}
        }
      }
    }
    detachConsumer(clientSessionId);
    if (peerHasRelay()) {
      try { peer!.send({ type: 'worker-client-disconnect', clientSessionId }); } catch {}
    }
    consumers.unregister(clientSessionId);
    broadcastConsumerPresence();
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
            workerOpError(
              res.error?.code ?? 'unknown',
              res.error?.message ?? 'unknown sandbox error',
              res.error?.denialContext,
              (res.error as any)?.envelope,
            ),
          );
        }
        return;
      }
      case 'worker-snap': {
        if (stale) return;
        const snap = msg as WorkerSnapFrame;
        const entry = workerSubs.get(snap.subId);
        if (!entry) return; // unsubscribed or unknown — drop silently
        const json = JSON.stringify(snap.value);
        const duplicate = entry.awaitingReissueSnap === true && json === entry.lastDeliveredJson;
        entry.awaitingReissueSnap = false;
        entry.lastDeliveredJson = json;
        if (duplicate) return;
        try {
          entry.onSnap(snap.value);
        } catch {}
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
          call.resolve({ ok: response.result.ok, summary: response.result.summary, data: response.result.data });
        } else {
          call.resolve({ ok: false, summary: response.error?.message ?? 'unknown sandbox error' });
        }
        break;
      }
      case 'remote-set-lens': {
        const frame = msg as RemoteSetLensFrame;
        const ok = consumers.setLens(frame.clientSessionId, frame.lens);
        broadcastConsumerPresence();
        if (peer && frame.id) {
          peer.send({
            type: 'remote-set-lens-ack',
            id: frame.id,
            clientSessionId: frame.clientSessionId,
            ok,
            ...(ok ? {} : { error: { code: 'not-found', message: 'Client session not found' } }),
          });
        }
        break;
      }
      case 'pong':
        break;
      case 'ping':
        if (peer) peer.send({ type: 'pong', id: msg.id });
        break;
      case 'hello':
        break;
      default:
        break;
    }
  }

  function health(): HealthReport {
    return {
      status: 'ok',
      mode: 'sandbox',
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
    } catch {}
  }

  return {
    project,
    version,
    startedAt,
    instanceId,
    consumers,
    broadcastConsumerPresence,
    recordToolEvent,
    registerSandboxPeer,
    isSandboxConnected,
    peerGeneration,
    toolNames,
    dispatch,
    dispatchWorkerOp,
    subscribeWorker,
    detachConsumer,
    disconnectConsumer,
    handleSandboxMessage,
    health,
  };
}

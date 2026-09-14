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
  RemoteSetLensAckFrame,
  ToolCallRequest,
  WorkerOpPayload,
  WorkerSubPayload,
  WorkerMessageFrame,
} from '../protocol.js';
import {
  NO_SANDBOX_ERROR_MESSAGE,
  NO_WORKER_RELAY_ERROR_MESSAGE,
  WORKER_RELAY_CAPABILITY,
  WORKER_PORT_CAPABILITY,
} from '../protocol.js';
import { createOperationBudget } from '../operation-budget.js';
import { createConsumerRegistry, type ConsumerRegistry } from './consumer-registry.js';
import { createWorkerSessions } from './worker-sessions.js';
import { createCallerIdentity, type CallerIdentityStore } from '../../auth/identity.js';

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
  /** Local project directory identity supplied by the owning serve session. */
  projectKey?: string;
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

/**
 * Identifies the evaluation run a tool event belongs to. Read once per server
 * process from the environment, so every event in one run carries the same
 * identifiers and its own position in the call sequence.
 */
export interface BridgeToolEventRun {
  runId: string;
  taskId: string;
  variant: string;
  cli: string;
  model: string;
  effort: string;
  condition: string;
  seed: number;
  /** Position of this call within the run, counted from zero. */
  callIndex: number;
}

export interface BridgeToolEvent {
  timestamp: string;
  mode: 'sandbox';
  project: string;
  /** The tool name as the MCP client sent it, before any surface mapping. */
  tool: string;
  args: Record<string, unknown>;
  result: BridgeToolResult | { ok: false; summary: string; error?: { code: string; message: string } };
  durationMs: number;
  /**
   * Canonical operation id the call resolved to, or null when the rendered
   * tool name maps to no operation. The surface layer supplies this; the
   * default surface renders no mapping and leaves it null.
   */
  operation?: string | null;
  /** Discriminator value when the rendered surface has one, else null. */
  action?: string | null;
  /** True when the arguments failed schema validation before dispatch. */
  schemaRejected?: boolean;
  /** Mirrors the MCP `isError` flag of the returned result. */
  isError?: boolean;
  /**
   * True when the failing result reports a verdict rather than a fault: a
   * data-plane call Security Rules refused, or a rules lint that found
   * problems in the source. Both are the surface answering the question it was
   * asked, so a scorer counts them apart from error calls.
   */
  verdict?: boolean;
  /** Evaluation-run envelope. Absent outside an evaluation run. */
  run?: BridgeToolEventRun;
}

export interface Bridge {
  readonly project: string;
  readonly projectKey?: string;
  readonly version: string;
  readonly startedAt: string;
  /** Stable per-process identity (see HealthReport.instanceId). */
  readonly instanceId: string;
  /** Registry of connected remote consumers. */
  readonly consumers: ConsumerRegistry;
  readonly workerSessions: ReturnType<typeof createWorkerSessions>;
  /**
   * The identity this bridge attributes to its own MCP callers, written by
   * `auth_impersonate` / `auth_reset` and read by `auth_whoami`. Held per
   * bridge rather than per MCP session so the CLI and an agent talking to the
   * same bridge read the same answer. `dispatch` consults it: anything other
   * than the default `{ mode: 'app-session' }` rides the forwarded
   * `tool-call` frame as `actAs`, and the peer runs the tool under it.
   */
  readonly callerIdentity: CallerIdentityStore;
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
  peerCapabilities(): string[];
  forwardWorkerMessage(message: WorkerMessageFrame['message'], clientSessionId: string): void;

  /** Tool names the bridge currently exposes to MCP. */
  toolNames(): string[];

  /** Dispatch a tool call to the connected sandbox peer. */
  dispatch(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<BridgeToolResult>;

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
  budget: ReturnType<typeof createOperationBudget>;
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
  const workerSessions = createWorkerSessions({
    detach(clientSessionId) {
      detachConsumer(clientSessionId);
      consumers.unregister(clientSessionId);
      broadcastConsumerPresence();
      peer?.send({ type: 'worker-client-interrupted', clientSessionId });
    },
    close: disconnectConsumer,
  });
  const callerIdentity = createCallerIdentity();

  function broadcastConsumerPresence(): void {
    consumers.broadcastPresence(peer?.send);
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
    const previousPeer = peer;
    const replacesPeer = previousPeer !== null;
    if (replacesPeer) {
      // Last-wins: kick the old peer and reject its pending calls.
      failAllPending('sandbox peer replaced by a newer connection');
      // Tear the old peer down (the transport closes its socket). The
      // browser's close handler tears down its relayed worker
      // subscriptions — otherwise the replaced tab's SharedWorker
      // listeners would keep posting snaps this bridge drops as
      // stale-generation until the tab closed.
      try {
        previousPeer.onReplaced?.();
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
    const canRestoreSubscriptions = myPeer.capabilities.has(WORKER_RELAY_CAPABILITY);
    if (canRestoreSubscriptions) {
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
      const isCurrentPeer = peer === myPeer;
      if (isCurrentPeer) {
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
    const currentPeer = peer;
    const hasNoPeer = currentPeer === null;
    if (hasNoPeer) return [];
    return Array.from(currentPeer.tools).sort();
  }

  async function dispatch(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<BridgeToolResult> {
    const startedAtMs = Date.now();
    let result: BridgeToolResult;
    try {
      result = await dispatchSandbox(name, args, signal);
    } catch (err) {
      const isError = err instanceof Error;
      result = {
        ok: false,
        summary: isError ? err.message : String(err),
      };
    }
    const recordsToolEvents = onToolEvent !== undefined;
    if (recordsToolEvents) {
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
    signal?: AbortSignal,
  ): Promise<BridgeToolResult> {
    const currentPeer = peer;
    const hasNoPeer = currentPeer === null;
    if (hasNoPeer) return Promise.resolve({ ok: false, summary: NO_SANDBOX_ERROR_MESSAGE });
    const isUnregisteredTool = !currentPeer.tools.has(name);
    if (isUnregisteredTool) {
      return Promise.resolve({ ok: false, summary: `tool '${name}' is not registered with the connected sandbox peer` });
    }
    const cancellationResult = { ok: false, summary: 'Tool call canceled; any dispatched mutation may already have committed.' };
    const isCanceled = signal?.aborted === true;
    if (isCanceled) return Promise.resolve(cancellationResult);
    const id = randomUUID();
    const cancelPendingCall = (): void => {
      const call = pending.get(id);
      const hasSettled = call === undefined;
      if (hasSettled) return;
      clearTimeout(call.timer);
      pending.delete(id);
      call.resolve(cancellationResult);
    };
    return new Promise<BridgeToolResult>((resolve) => {
      const timer = setTimeout(() => {
        const wasPending = pending.delete(id);
        if (wasPending) {
          resolve({ ok: false, summary: `sandbox call timed out after ${callTimeoutMs}ms (tool: ${name})` });
        }
      }, callTimeoutMs);
      pending.set(id, { id, resolve, timer, tool: name });
      signal?.addEventListener('abort', cancelPendingCall, { once: true });
      try {
        // The caller's identity governs the tools it forwards. `app-session`
        // is the default every caller holds until it impersonates, and it is
        // sent as an ABSENT field so an un-impersonated call stays exactly the
        // frame the bridge has always sent.
        const identity = callerIdentity.get();
        const request: ToolCallRequest = {
          type: 'tool-call',
          id,
          name,
          args,
        };
        const hasIdentityOverride = identity.mode !== 'app-session';
        if (hasIdentityOverride) request.actAs = identity;
        currentPeer.send(request);
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        const isError = err instanceof Error;
        const detail = isError ? err.message : String(err);
        resolve({ ok: false, summary: `failed to send tool call to sandbox: ${detail}` });
      }
    }).finally(() => signal?.removeEventListener('abort', cancelPendingCall));
  }

  function workerOperationBudget(clientSessionId?: string): ReturnType<typeof createOperationBudget> {
    for (const operation of workerPending.values()) {
      const belongsToClient = operation.clientSessionId === clientSessionId;
      if (belongsToClient) return operation.budget;
    }
    return createOperationBudget();
  }

  function dispatchWorkerOp(op: WorkerOpPayload, clientSessionId?: string): Promise<unknown> {
    const currentPeer = peer;
    const hasNoPeer = currentPeer === null;
    if (hasNoPeer) return Promise.reject(workerOpError('unavailable', NO_SANDBOX_ERROR_MESSAGE));
    const hasNoWorkerRelay = !peerHasRelay();
    if (hasNoWorkerRelay) return Promise.reject(workerOpError('unimplemented', NO_WORKER_RELAY_ERROR_MESSAGE));
    const id = randomUUID();
    const request: BridgeMessage = { type: 'worker-op', id, clientSessionId, op };
    const budget = workerOperationBudget(clientSessionId);
    const reservation = budget.reserve(request);
    const isRefused = !reservation.accepted;
    if (isRefused) return Promise.reject(workerOpError(reservation.error.code, reservation.error.message));
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const wasPending = workerPending.delete(id);
        if (wasPending) {
          reject(workerOpError('deadline-exceeded', `sandbox worker op timed out after ${callTimeoutMs}ms (op: ${op.method})`));
        }
      }, callTimeoutMs);
      workerPending.set(id, { resolve, reject, timer, method: op.method, clientSessionId, budget });
      try {
        currentPeer.send(request);
      } catch (err) {
        clearTimeout(timer);
        workerPending.delete(id);
        const isError = err instanceof Error;
        const detail = isError ? err.message : String(err);
        reject(workerOpError('unavailable', `failed to send worker op to sandbox: ${detail}`));
      }
    }).finally(reservation.release);
  }

  function subscribeWorker(
    sub: WorkerSubPayload,
    onSnap: (value: unknown) => void,
    clientSessionId?: string,
  ): () => void {
    const subId = randomUUID();
    workerSubs.set(subId, { sub, onSnap, clientSessionId });
    const canRelaySubscription = peerHasRelay();
    if (canRelaySubscription) {
      try {
        peer?.send({ type: 'worker-sub', subId, clientSessionId, sub });
      } catch {}
    }
    return () => {
      const entry = workerSubs.get(subId);
      const wasUnsubscribed = !workerSubs.delete(subId);
      if (wasUnsubscribed) return;
      const canRelayRemoval = peerHasRelay();
      if (canRelayRemoval) {
        try {
          peer?.send({ type: 'worker-unsub', subId, clientSessionId: entry?.clientSessionId });
        } catch {}
      }
    };
  }

  function detachConsumer(clientSessionId: string): void {
    for (const [id, op] of workerPending) {
      const belongsToConsumer = op.clientSessionId === clientSessionId;
      if (belongsToConsumer) {
        clearTimeout(op.timer);
        workerPending.delete(id);
        op.reject(workerOpError('unavailable', 'consumer socket detached'));
      }
    }
  }

  function disconnectConsumer(clientSessionId: string): void {
    for (const [subId, entry] of workerSubs) {
      const belongsToConsumer = entry.clientSessionId === clientSessionId;
      if (belongsToConsumer) {
        workerSubs.delete(subId);
        const canRelayRemoval = peerHasRelay();
        if (canRelayRemoval) {
          try { peer?.send({ type: 'worker-unsub', subId, clientSessionId }); } catch {}
        }
      }
    }
    detachConsumer(clientSessionId);
    const supportsDisconnect = peerHasRelay() || peer?.capabilities.has(WORKER_PORT_CAPABILITY) === true;
    if (supportsDisconnect) {
      try { peer?.send({ type: 'worker-client-disconnect', clientSessionId }); } catch {}
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
      case 'worker-message-result': {
        if (stale) return;
        consumers.get(msg.clientSessionId)?.send(msg);
        return;
      }
      case 'worker-res': {
        if (stale) return;
        const res = msg;
        const op = workerPending.get(res.id);
        const isUnknownOperation = op === undefined;
        if (isUnknownOperation) return;
        clearTimeout(op.timer);
        workerPending.delete(res.id);
        const succeeded = res.ok;
        if (succeeded) {
          op.resolve(res.value);
        } else {
          op.reject(
            workerOpError(
              res.error?.code ?? 'unknown',
              res.error?.message ?? 'unknown sandbox error',
              res.error?.denialContext,
              res.error?.envelope,
            ),
          );
        }
        return;
      }
      case 'worker-snap': {
        if (stale) return;
        const snap = msg;
        const entry = workerSubs.get(snap.subId);
        const isUnknownSubscription = entry === undefined;
        if (isUnknownSubscription) return;
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
        const response = msg;
        const call = pending.get(response.id);
        const isUnknownCall = call === undefined;
        if (isUnknownCall) return;
        clearTimeout(call.timer);
        pending.delete(response.id);
        const succeeded = response.ok;
        if (succeeded) {
          const result = response.result;
          const hasResult = !!result;
          if (hasResult) {
            call.resolve({ ok: result.ok, summary: result.summary, data: result.data });
            break;
          }
        }
        call.resolve({ ok: false, summary: response.error?.message ?? 'unknown sandbox error' });
        break;
      }
      case 'remote-set-lens': {
        const frame = msg;
        const result = consumers.setLens(frame.clientSessionId, frame.lens);
        broadcastConsumerPresence();
        const currentPeer = peer;
        const needsAcknowledgement = currentPeer !== null && Boolean(frame.id);
        if (needsAcknowledgement) {
          const acknowledgement: RemoteSetLensAckFrame = {
            type: 'remote-set-lens-ack',
            id: frame.id,
            clientSessionId: frame.clientSessionId,
            ...result,
          };
          currentPeer.send(acknowledgement);
        }
        break;
      }
      case 'pong':
        break;
      case 'ping':
        peer?.send({ type: 'pong', id: msg.id });
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
    const hasNoRecorder = onToolEvent === undefined;
    if (hasNoRecorder) return;
    try {
      onToolEvent(event);
    } catch {}
  }

  return {
    project,
    projectKey: opts.projectKey,
    version,
    startedAt,
    instanceId,
    consumers,
    workerSessions,
    callerIdentity,
    broadcastConsumerPresence,
    recordToolEvent,
    registerSandboxPeer,
    isSandboxConnected,
    peerGeneration,
    peerCapabilities: () => [...(peer?.capabilities ?? [])],
    forwardWorkerMessage(message, clientSessionId) {
      const isWorkerPortUnavailable = peer?.capabilities.has(WORKER_PORT_CAPABILITY) !== true;
      if (isWorkerPortUnavailable) {
        throw workerOpError('unimplemented', 'This sandbox does not support browser worker ports.');
      }
      peer?.send({ type: 'worker-message', clientSessionId, message });
    },
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

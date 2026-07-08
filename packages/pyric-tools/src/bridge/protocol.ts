/**
 * Wire protocol shared by `pyric-tools/bridge` (Node bridge) and
 * `pyric-tools/bridge` (in-browser sandbox connector).
 *
 * The bridge process speaks MCP HTTP to external agents (Claude Code,
 * Cursor) on `/mcp` and WebSocket to the in-browser sandbox on
 * `/sandbox`. Data-plane and sandbox-management tool calls received
 * over MCP are forwarded to whichever browser tab is currently
 * connected; the browser dispatches them into the local
 * `LocalEnvironment` and returns the result.
 *
 * This module has NO runtime imports — only types — so it can be
 * referenced from both the `node` and `browser` builds without
 * pulling Node-specific or DOM-specific modules into the wrong
 * environment.
 */

// TYPE-ONLY imports (erased at build) — the wire payloads for the generic
// worker relay are the SharedWorker protocol's own op/sub messages, minus
// the port-level `t`/`id`/`subId` fields the relay re-mints per hop.
import type { OpMessage, SubMessage } from '../serve/worker/protocol.js';

/** Bridge mode set at process start. */
export type BridgeMode = 'sandbox' | 'prod';

/** Health report returned by the bridge's `GET /health` endpoint. */
export interface HealthReport {
  status: 'ok';
  mode: BridgeMode;
  /** Project id when `mode==='prod'`; sandbox identifier otherwise. */
  project: string;
  /** Whether a browser tab is currently connected over `/sandbox`. */
  sandboxConnected: boolean;
  /** Bridge package version. */
  version: string;
  /** ISO timestamp the bridge started. */
  startedAt: string;
  /**
   * Random identity, stable for this bridge process's lifetime. The discovery
   * pointer (`.pyric/serve.json`) records the same value, so a proxy can confirm
   * it reached the SAME server the pointer names — two sandboxes can collide on
   * one port across loopback families (IPv4 `*:P` + IPv6 `[::1]:P`), and `mode`
   * alone can't tell them apart. (Not `version` — that's hardcoded.)
   */
  instanceId: string;
}

/** Default port the standalone bridge binds to. */
export const DEFAULT_BRIDGE_PORT = 5174;

/** Default WS path the browser connects to. */
export const DEFAULT_SANDBOX_PATH = '/sandbox';

/** Default HTTP path the MCP client connects to. */
export const DEFAULT_MCP_PATH = '/mcp';

/** Default health endpoint path. */
export const DEFAULT_HEALTH_PATH = '/health';

// ── Bridge ↔ browser WebSocket protocol ──────────────────────────────
//
// All messages are JSON. Each message has a `type` discriminator.
// Both directions share the same envelope shape so the wire can be
// audited with a single parser.

/** Browser → bridge: "I'm here and ready to receive tool calls." */
export interface HelloFromClient {
  type: 'hello';
  /** Protocol version. Bump if the wire format changes incompatibly. */
  protocol: 1;
  /** Tool names the browser can dispatch. Bridge uses this to size MCP tool surface. */
  tools: string[];
  /** Stable identifier for this sandbox session (for audit log). */
  sandboxId: string;
  /**
   * Optional peer capabilities (additive). The bridge only sends `worker-*`
   * frames to a peer that declared {@link WORKER_RELAY_CAPABILITY} — an old
   * peer that omits it simply never receives them, and worker ops against it
   * fail fast with a clear error instead of timing out.
   */
  capabilities?: string[];
}

/** Bridge → browser: acknowledge connection. */
export interface HelloFromBridge {
  type: 'hello-ack';
  protocol: 1;
  /** Bridge version, for compatibility checks. */
  bridgeVersion: string;
}

/** Bridge → browser: please dispatch this tool call into the sandbox. */
export interface ToolCallRequest {
  type: 'tool-call';
  /** Correlation id — browser must echo in `ToolCallResponse`. */
  id: string;
  /** Tool name (e.g. `firestore_simulator_create`). */
  name: string;
  /** Tool arguments (JSON-serializable). */
  args: Record<string, unknown>;
}

/** Browser → bridge: tool call result. */
export interface ToolCallResponse {
  type: 'tool-result';
  /** Correlation id from the matching request. */
  id: string;
  /** When `ok===false`, `error` is populated and `result` is omitted. */
  ok: boolean;
  /** Tool result (matches `ToolResult` shape from `@inbrowser/agent`). */
  result?: {
    ok: boolean;
    summary: string;
    data?: unknown;
  };
  error?: {
    code: string;
    message: string;
  };
}

// ── Generic worker relay (remote sandbox, slice 1) ───────────────────
//
// Beyond `tool-call`, the bridge can relay ANY SharedWorker-protocol op or
// (snap-delivering) subscription between a Node consumer and the browser
// peer. The SAME frame shapes travel both legs:
//
//   Node consumer ──ws──> bridge ──ws──> browser tab ──port──> worker
//
// Correlation ids/subIds are re-minted per hop (consumer-minted on the
// consumer leg, bridge-minted UUIDs on the peer leg, page-local ids on the
// worker port) so each hop's pending/registry maps stay collision-free.

/** Peer capability flag: "I can relay worker-op / worker-sub frames". */
export const WORKER_RELAY_CAPABILITY = 'worker-relay';

/** `Omit` distributed over a union (plain `Omit` collapses union members). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/** A worker one-shot op, minus the port-level `t`/`id` the relay re-mints. */
export type WorkerOpPayload = DistributiveOmit<OpMessage, 't' | 'id'>;

/**
 * A worker subscription, minus the port-level `t`/`subId`. Slice 1 relays
 * snap-delivering subs (RTDB value, auth state, Firestore); the unified
 * event stream (`target: 'events'`) is NOT relayable yet — it needs bounded
 * backpressure first (slice 2).
 */
export type WorkerSubPayload = DistributiveOmit<SubMessage, 't' | 'subId'>;

/** Node consumer → bridge: attach as a worker-relay consumer (NOT a peer —
 *  a consumer never replaces the browser tab in last-connection-wins). */
export interface AttachFromConsumer {
  type: 'attach';
  protocol: 1;
}

/** Bridge → Node consumer: attach acknowledged. */
export interface AttachAckFromBridge {
  type: 'attach-ack';
  protocol: 1;
  bridgeVersion: string;
  /** Whether a browser tab is currently registered as the sandbox peer. */
  peerConnected: boolean;
}

/** Toward the worker: dispatch this one-shot op. (consumer→bridge and
 *  bridge→browser use the same shape; `id` is per-leg.) */
export interface WorkerOpFrame {
  type: 'worker-op';
  /** Correlation id — echoed back in the matching `worker-res`. */
  id: string;
  op: WorkerOpPayload;
}

/** Away from the worker: the relayed op result. */
export interface WorkerResFrame {
  type: 'worker-res';
  id: string;
  /** When `ok === false`, `error` is populated and `value` omitted. */
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string };
}

/** Toward the worker: register a subscription. Re-issued by the bridge to a
 *  NEW peer on reconnect/replacement (value subs re-deliver a fresh initial
 *  snapshot, so replay is cursor-free and last-value-wins-safe). */
export interface WorkerSubFrame {
  type: 'worker-sub';
  subId: string;
  sub: WorkerSubPayload;
}

/** Toward the worker: tear a subscription down. */
export interface WorkerUnsubFrame {
  type: 'worker-unsub';
  subId: string;
}

/** Away from the worker: one streamed snapshot for a subscription. A failed
 *  ESTABLISHMENT also arrives here as `value: { __error: { code, message } }`
 *  (the worker host's snap-error convention) — relays forward it verbatim. */
export interface WorkerSnapFrame {
  type: 'worker-snap';
  subId: string;
  value: unknown;
}

/** Either direction: ping for keepalive / liveness detection. */
export interface Ping {
  type: 'ping';
  /** Echo back as `pong.id`. */
  id: string;
}

/** Pong response to a Ping. */
export interface Pong {
  type: 'pong';
  id: string;
}

export type BridgeMessage =
  | HelloFromClient
  | HelloFromBridge
  | AttachFromConsumer
  | AttachAckFromBridge
  | ToolCallRequest
  | ToolCallResponse
  | WorkerOpFrame
  | WorkerResFrame
  | WorkerSubFrame
  | WorkerUnsubFrame
  | WorkerSnapFrame
  | Ping
  | Pong;

/** Type guard for runtime parsing. */
export function isBridgeMessage(value: unknown): value is BridgeMessage {
  if (value === null || typeof value !== 'object') return false;
  const t = (value as { type?: unknown }).type;
  return (
    t === 'hello' ||
    t === 'hello-ack' ||
    t === 'attach' ||
    t === 'attach-ack' ||
    t === 'tool-call' ||
    t === 'tool-result' ||
    t === 'worker-op' ||
    t === 'worker-res' ||
    t === 'worker-sub' ||
    t === 'worker-unsub' ||
    t === 'worker-snap' ||
    t === 'ping' ||
    t === 'pong'
  );
}

/** Error returned by MCP when no browser tab is currently connected. */
export const NO_SANDBOX_ERROR_MESSAGE =
  'sandbox not connected. Open your dev server in a browser and refresh the page so the bridge client can register.';

/** Error for worker ops against a peer that predates the worker relay. */
export const NO_WORKER_RELAY_ERROR_MESSAGE =
  'the connected browser tab does not support the worker relay — reload the tab (and update pyric if reloading does not help).';

// ─── Binary-payload guard (worker-op relay boundary) ────────────────────────
//
// Both WS legs of the worker relay are `JSON.stringify` — a `Blob` or
// `ArrayBuffer` in a relayed value silently becomes `{}` and a TypedArray /
// Buffer becomes an index-keyed object. Nothing errors; the far side just
// receives garbage (the live failure mode: relaying `storage.getBlob` yields
// `{}`). This guard turns that silent corruption into a loud, remediable
// rejection at the relay boundary. It is a cheap explicit TYPE check
// (Blob/ArrayBuffer/TypedArray/DataView), NOT a full JSON round-trip.

/** Human label for a non-JSON-safe binary value, or null when `value` (and
 *  every nested array/plain-object member) is free of binary containers. */
export function findBinaryPayload(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return 'Blob';
  if (value instanceof ArrayBuffer) return 'ArrayBuffer';
  if (ArrayBuffer.isView(value)) {
    return (value as { constructor?: { name?: string } }).constructor?.name ?? 'TypedArray';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findBinaryPayload(item);
      if (hit) return hit;
    }
    return null;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    const hit = findBinaryPayload(item);
    if (hit) return hit;
  }
  return null;
}

/**
 * Assert a worker-op result is safe to serialize onto the JSON relay.
 * Throws (code `invalid-argument`) naming the offending type and the
 * base64 storage ops to use instead — so a future caller relaying
 * `storage.getBlob` gets a clear error, not `{}`.
 */
export function assertJsonSafeRelayValue(
  method: string,
  value: unknown,
): void {
  const kind = findBinaryPayload(value);
  if (!kind) return;
  const err = new Error(
    `worker op '${method}' produced a binary payload (${kind}) that cannot cross the ` +
      'JSON bridge relay — it would be silently corrupted by JSON.stringify. Use the ' +
      "base64 storage ops instead ('storage.getBytes' / 'storage.putBytes'), which carry " +
      "bytes as JSON-safe 'dataB64' strings; 'storage.getBlob' is MessagePort-only.",
  ) as Error & { code: string };
  err.code = 'invalid-argument';
  throw err;
}

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
  | ToolCallRequest
  | ToolCallResponse
  | Ping
  | Pong;

/** Type guard for runtime parsing. */
export function isBridgeMessage(value: unknown): value is BridgeMessage {
  if (value === null || typeof value !== 'object') return false;
  const t = (value as { type?: unknown }).type;
  return (
    t === 'hello' ||
    t === 'hello-ack' ||
    t === 'tool-call' ||
    t === 'tool-result' ||
    t === 'ping' ||
    t === 'pong'
  );
}

/** Error returned by MCP when no browser tab is currently connected. */
export const NO_SANDBOX_ERROR_MESSAGE =
  'sandbox not connected. Open your dev server in a browser and refresh the page so the bridge client can register.';

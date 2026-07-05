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
 */

import type { Sandbox } from 'pyric/sandbox';
import type {
  BridgeMessage,
  HelloFromClient,
  ToolCallRequest,
  ToolCallResponse,
} from '../protocol.js';
import {
  isBridgeMessage,
  DEFAULT_BRIDGE_PORT,
  DEFAULT_SANDBOX_PATH,
} from '../protocol.js';
import { dispatchSandboxTool, SANDBOX_TOOL_NAMES } from './dispatch.js';

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
   * Disable the auto-reconnect loop (useful in tests where the test
   * harness explicitly controls connection lifecycle).
   */
  noReconnect?: boolean;
  /** Called whenever the client transitions connection state. */
  onStateChange?: (state: ConnectedBridgeState) => void;
}

export type ConnectedBridgeState =
  | { kind: 'connecting' }
  | { kind: 'connected'; bridgeVersion: string }
  | { kind: 'disconnected'; reason: string }
  | { kind: 'reconnecting'; attempt: number; delayMs: number };

export interface SandboxToolDispatcher {
  /**
   * Dispatch a tool call. Throws if the tool isn't recognised
   * (the bridge advertises only what this dispatcher reports it
   * can handle, so unknowns indicate wire-level drift).
   */
  (sandbox: Sandbox, name: string, args: Record<string, unknown>): Promise<{
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

export function connectBridge(
  sandbox: Sandbox,
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

  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let currentState: ConnectedBridgeState = { kind: 'connecting' };

  function setState(next: ConnectedBridgeState) {
    currentState = next;
    try {
      onStateChange(next);
    } catch {
      // host callback failures must not interrupt the loop.
    }
  }

  function send(msg: BridgeMessage) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(msg));
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
      scheduleReconnect(`failed to open WebSocket: ${err instanceof Error ? err.message : String(err)}`);
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
      send(hello);
    };

    socket.onmessage = (event: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch {
        return;
      }
      if (!isBridgeMessage(parsed)) return;

      if (parsed.type === 'hello-ack') {
        setState({ kind: 'connected', bridgeVersion: parsed.bridgeVersion });
        return;
      }
      if (parsed.type === 'tool-call') {
        void handleToolCall(parsed);
        return;
      }
      if (parsed.type === 'ping') {
        send({ type: 'pong', id: parsed.id });
        return;
      }
      // Other message types (tool-result, pong, hello) are bridge→client
      // confirmations or peer-only; ignore here.
    };

    socket.onclose = (event: CloseEvent) => {
      const reason = event.reason || `closed (code ${event.code})`;
      ws = null;
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
      const result = await dispatcher(sandbox, req.name, req.args ?? {});
      response = {
        type: 'tool-result',
        id: req.id,
        ok: true,
        result,
      };
    } catch (err) {
      response = {
        type: 'tool-result',
        id: req.id,
        ok: false,
        error: {
          code: err instanceof Error ? err.name : 'Error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
    send(response);
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
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        try {
          ws.close();
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

function resolveBridgeUrl(explicit?: string): string {
  if (explicit) return explicit;
  if (typeof window !== 'undefined') {
    const injected = (window as unknown as { __PYRIC_BRIDGE_URL__?: string })
      .__PYRIC_BRIDGE_URL__;
    if (injected) return injected;
    const host = window.location.hostname || 'localhost';
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${host}:${DEFAULT_BRIDGE_PORT}${DEFAULT_SANDBOX_PATH}`;
  }
  return `ws://localhost:${DEFAULT_BRIDGE_PORT}${DEFAULT_SANDBOX_PATH}`;
}

function randomId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for ancient environments.
  return `sb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

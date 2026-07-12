/**
 * Studio bridge peer — register the SERVED Studio page as the bridge's
 * sandbox peer, exactly like the served app page does.
 *
 * WHY: the bridge relays agent tool-calls and remote worker-ops (the MCP
 * endpoint, `connectRemoteSandbox`) through ONE registered browser peer into
 * the SharedWorker. That peer was wired only in the served APP page
 * (`connectBridgePeer` in @pyric/cli' `serve/entries/runtime.ts`) — so a user
 * with ONLY Studio open (exactly what `pyric dev --ui` auto-opens) got
 * "no browser tab is connected" even though Studio talks to the very same
 * SharedWorker. Studio must register too.
 *
 * WIRING (reused, not duplicated): `connectBridge` (the reconnecting WS client
 * from `@pyric/cli/bridge/client`) with the SAME `dispatcher`/`workerRelay`
 * closures the app page uses — `callTool` / `relayWorkerOp` / `relayWorkerSub`
 * from `@pyric/cli/serve/worker`, forwarding every frame over the worker
 * `MessagePort` the live plane already holds. Last-connection-wins peer
 * semantics make app page + Studio both being open safe: whichever page holds
 * the peer slot fronts the one shared SharedWorker sandbox identically.
 *
 * LIFECYCLE: discovery is the serve init payload (`/__pyric/init.json`) —
 * present only when Studio is SERVED (`pyric dev --ui` / the Vite plugin). In
 * dev-seed / review mode there is no serve, the fetch fails (or returns
 * non-JSON), and this module no-ops cleanly. Once connected, resilience is
 * `connectBridge`'s own reconnect loop (exponential backoff — the same
 * behavior the app page gets).
 */

import {
  connectBridge,
  toPageOriginWsUrl,
  type ConnectBridgeOptions,
  type ConnectedBridge,
  type ConnectedBridgeState,
} from '@pyric/cli/bridge/client';
import {
  callTool,
  relayWorkerOp,
  relayWorkerSub,
  type ClientDb,
} from '@pyric/cli/serve/worker';

/** The slice of the serve init payload this module reads. */
interface InitPayloadLite {
  /** Bridge WS URL when `--bridge` is on; null otherwise. */
  bridgeUrl?: string | null;
}

export interface StudioBridgePeerOptions {
  /** Base URL of the serve (`''` = same origin, the served default). */
  baseUrl?: string;
  /** Injectable fetch (tests). Defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Injectable location (tests / non-window hosts). Defaults to `window.location`. */
  locationLike?: { href: string; protocol: string; host: string };
  /** Reconnect tuning passed through to `connectBridge` (tests). */
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  /** Connection-state observer passed through to `connectBridge` — the shell's
   *  presence chip reads it. Also invoked with `disconnected` when discovery
   *  concludes there is no serve/bridge to register with. */
  onStateChange?: (state: ConnectedBridgeState) => void;
}

/**
 * Build the `ConnectBridgeOptions` wiring for a Studio peer over `db` — the
 * SAME shape the served app page passes on its worker path (see
 * `connectBridgePeer` in @pyric/cli' `entries/runtime.ts`): tool-calls
 * dispatch through the worker (`callTool`), and the generic worker relay
 * forwards ops/subscriptions over the worker port. Exported for tests.
 */
export function studioBridgePeerOptions(db: ClientDb, url: string): ConnectBridgeOptions {
  return {
    url,
    dispatcher: (_sandbox, name, args) => callTool(db, name, args),
    workerRelay: {
      op: (op) => relayWorkerOp(db, op),
      subscribe: (sub, onValue) => relayWorkerSub(db, sub, onValue),
    },
  };
}

/**
 * Register served Studio as the bridge's sandbox peer over the live plane's
 * worker port. Resolves with the connected bridge handle, or `null` when there
 * is no serve/bridge to register with (dev-seed / review mode, serve without
 * `--bridge`) — never throws.
 */
export async function connectStudioBridgePeer(
  db: ClientDb,
  options: StudioBridgePeerOptions = {},
): Promise<ConnectedBridge | null> {
  const baseUrl = options.baseUrl ?? '';
  const doFetch = options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : null);
  const settleOff = (reason: string) =>
    options.onStateChange?.({ kind: 'disconnected', reason });
  if (!doFetch) {
    settleOff('no fetch available');
    return null;
  }

  // Serve discovery: only a pyric serve answers /__pyric/init.json with JSON.
  // Anything else (no server, a dev-seed Vite host SPA-falling-back to HTML,
  // a non-200) means "not served" → no-op.
  let bridgeUrl: string | null;
  try {
    const res = await doFetch(`${baseUrl}/__pyric/init.json`);
    if (!res.ok) {
      settleOff('not served');
      return null;
    }
    bridgeUrl = ((await res.json()) as InitPayloadLite).bridgeUrl ?? null;
  } catch {
    settleOff('not served');
    return null;
  }
  if (!bridgeUrl) {
    settleOff('bridge off'); // served, but the bridge is off
    return null;
  }

  // Re-anchor the WS to THIS page's origin (Tailscale / LAN / https) — the
  // same re-anchoring the app page does before connecting.
  const loc =
    options.locationLike ?? (typeof window !== 'undefined' ? window.location : null);
  const url = loc ? toPageOriginWsUrl(bridgeUrl, loc) : bridgeUrl;

  const bridge = connectBridge(
    // The sandbox parameter is only ever handed to the dispatcher, and ours
    // routes through the worker instead — the in-page sandbox does not exist
    // on this path (same contract as the app page's worker-path wiring).
    null as never,
    {
      ...studioBridgePeerOptions(db, url),
      ...(options.onStateChange ? { onStateChange: options.onStateChange } : {}),
      ...(options.initialReconnectDelayMs !== undefined
        ? { initialReconnectDelayMs: options.initialReconnectDelayMs }
        : {}),
      ...(options.maxReconnectDelayMs !== undefined
        ? { maxReconnectDelayMs: options.maxReconnectDelayMs }
        : {}),
    },
  );
  console.info('[pyric studio] registered as the sandbox bridge peer at', url);
  return bridge;
}

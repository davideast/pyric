/**
 * Peer standby — the fix for the two-tab peer-slot fight.
 *
 * Live failure mode: an app tab and a Studio tab both run `connectBridge`.
 * Last-connection-wins registration closes the replaced peer's socket, whose
 * reconnect loop re-helloed ~500ms later and kicked the other tab — forever.
 * Beyond the duplicate-snapshot spam (deduped in the bridge core), every
 * replacement fails ALL in-flight worker ops (`failAllPending`), so any op
 * slower than the fight cycle (large storage putBytes, slow transactions)
 * failed intermittently with 'unavailable'.
 *
 * The fix: the transport closes a replaced peer with
 * PEER_REPLACED_CLOSE_CODE, and the client treats that close as "the slot is
 * legitimately held" — it enters STANDBY (jittered health polling) and only
 * reconnects when `sandboxConnected` is false. Network-drop closes keep the
 * immediate reconnect loop (tab-refresh takeover depends on it).
 *
 * Harness: the REAL `connectBridge` client over a linked fake socket pair —
 * the browser half satisfies the WebSocket global, the server half is fed to
 * the REAL `attachPeer`, so hello/hello-ack, replacement close codes, and
 * generation tagging all run production code in-process. Health polls hit a
 * stub fetch that reports the REAL bridge's `health()`.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { createBridge, type Bridge } from '../../src/bridge/server/bridge.js';
import { attachPeer } from '../../src/bridge/server/peer.js';
import { PEER_REPLACED_CLOSE_CODE } from '../../src/bridge/protocol.js';
import {
  connectBridge,
  type ConnectedBridge,
  type ConnectBridgeOptions,
} from '../../src/bridge/client/bridge.js';

// ── Linked fake socket pair (browser WebSocket ⇄ ws-lib socket) ────────────

type ServerHandler = (...args: unknown[]) => void;

class LinkedWebSocket {
  static OPEN = 1;
  static instances: LinkedWebSocket[] = [];
  /** Set by installLinkedWebSocket — every new socket attaches here. */
  static bridge: Bridge | null = null;

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  private serverHandlers = new Map<string, ServerHandler>();

  constructor(public url: string) {
    LinkedWebSocket.instances.push(this);
    // The server side accepts the connection and attaches the REAL peer
    // transport. Open async — connectBridge assigns onopen after construction.
    attachPeer(LinkedWebSocket.bridge!, this.serverSide());
    queueMicrotask(() => {
      if (this.readyState !== 0) return; // already closed
      this.readyState = 1;
      this.onopen?.();
    });
  }

  /** The `ws`-shaped socket `attachPeer` consumes. */
  private serverSide() {
    const self = this;
    return {
      on(event: string, cb: ServerHandler) {
        self.serverHandlers.set(event, cb);
        return this;
      },
      send(data: string) {
        self.onmessage?.({ data });
      },
      close(code?: number, reason?: string) {
        self.closeFromServer(code ?? 1000, reason ?? '');
      },
    } as unknown as Parameters<typeof attachPeer>[1];
  }

  // browser → server
  send(data: string): void {
    this.serverHandlers.get('message')?.(data);
  }

  // client-initiated close (disconnect())
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.serverHandlers.get('close')?.();
    this.onclose?.({ code: 1000, reason: 'closed by client' });
  }

  private closeFromServer(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.serverHandlers.get('close')?.();
    this.onclose?.({ code, reason });
  }

  /** Abrupt network drop: no server close frame semantics, code 1006. */
  dropFromNetwork(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.serverHandlers.get('close')?.();
    this.onclose?.({ code: 1006, reason: '' });
  }
}

function installLinkedWebSocket(bridge: Bridge): () => void {
  const prev = (globalThis as { WebSocket?: unknown }).WebSocket;
  LinkedWebSocket.instances = [];
  LinkedWebSocket.bridge = bridge;
  (globalThis as { WebSocket?: unknown }).WebSocket = LinkedWebSocket;
  return () => {
    (globalThis as { WebSocket?: unknown }).WebSocket = prev;
    LinkedWebSocket.bridge = null;
  };
}

/** Stub fetch serving the REAL bridge health at /__pyric/health. */
function healthFetch(bridge: Bridge): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const target = String(input);
    if (!target.endsWith('/__pyric/health') && !target.endsWith('/health')) {
      return new Response('not found', { status: 404 });
    }
    return new Response(JSON.stringify(bridge.health()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function tick(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Harness state ───────────────────────────────────────────────────────────

let restoreWs: (() => void) | null = null;
const connections: ConnectedBridge[] = [];

afterEach(() => {
  for (const c of connections) c.disconnect();
  connections.length = 0;
  restoreWs?.();
  restoreWs = null;
});

function makeStack() {
  const bridge = createBridge({ mode: 'sandbox', version: 'test' });
  restoreWs = installLinkedWebSocket(bridge);
  return bridge;
}

function connectClient(
  bridge: Bridge,
  overrides: Partial<ConnectBridgeOptions> & {
    onWorkerOp?: (method: string) => Promise<unknown>;
  } = {},
) {
  const { onWorkerOp, ...opts } = overrides;
  const states: string[] = [];
  let onSubscribe: (() => void) | null = null;
  const conn = connectBridge(initializeSandbox(), {
    url: 'ws://localhost:5000/__pyric/sandbox',
    initialReconnectDelayMs: 10,
    standbyPollMs: 20,
    fetchImpl: healthFetch(bridge),
    onStateChange: (s) => states.push(s.kind),
    workerRelay: {
      op: onWorkerOp
        ? (op) => onWorkerOp(op.method)
        : async () => ({ ok: true }),
      subscribe: () => {
        onSubscribe?.();
        return () => {};
      },
    },
    ...opts,
  });
  connections.push(conn);
  return {
    conn,
    states,
    socket: () => LinkedWebSocket.instances[LinkedWebSocket.instances.length - 1]!,
    subscribeCalls: (cb: () => void) => {
      onSubscribe = cb;
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('peer standby — replaced tabs stop fighting for the slot', () => {
  it('the transport closes a replaced peer with the REPLACED code', async () => {
    const bridge = makeStack();
    const a = connectClient(bridge);
    await tick(20);
    const socketA = a.socket();
    expect(bridge.isSandboxConnected()).toBe(true);

    let closeSeen: { code: number; reason: string } | null = null;
    const prevOnClose = socketA.onclose;
    socketA.onclose = (ev) => {
      closeSeen = ev;
      prevOnClose?.(ev);
    };

    connectClient(bridge); // tab B wins the slot
    await tick(20);
    expect(closeSeen!.code).toBe(PEER_REPLACED_CLOSE_CODE);
    expect(closeSeen!.reason).toContain('replaced');
  });

  it('a replaced client goes STANDBY and does not re-hello while a peer is healthy', async () => {
    const bridge = makeStack();
    const a = connectClient(bridge);
    await tick(20);
    connectClient(bridge); // tab B replaces tab A
    await tick(20);

    expect(a.conn.state().kind).toBe('standby');
    const genAfterReplacement = bridge.peerGeneration();
    const socketsAfterReplacement = LinkedWebSocket.instances.length;

    // Pre-fix, tab A re-helloed after initialReconnectDelayMs (10ms here) and
    // kicked tab B — generations churned continuously. Post-fix: many standby
    // poll cycles pass (20ms cadence over 300ms) with zero new connections.
    await tick(300);
    expect(bridge.peerGeneration()).toBe(genAfterReplacement);
    expect(LinkedWebSocket.instances.length).toBe(socketsAfterReplacement);
    expect(a.conn.state().kind).toBe('standby');
    expect(bridge.isSandboxConnected()).toBe(true); // tab B still holds the slot
  });

  it('a standby client claims the slot once the winner disconnects (tab refresh takeover)', async () => {
    const bridge = makeStack();
    const a = connectClient(bridge);
    await tick(20);
    const b = connectClient(bridge);
    await tick(20);
    expect(a.conn.state().kind).toBe('standby');

    // The bridge holds a consumer sub — on takeover the registry must replay
    // to the reclaiming tab (its relay `subscribe` is invoked; the re-issue
    // DEDUP semantics themselves are covered in worker-relay.test.ts).
    let subReplayedToA = false;
    a.subscribeCalls(() => {
      subReplayedToA = true;
    });
    bridge.subscribeWorker({ target: { __ref: 'doc', path: 'x/y' } } as never, () => {});

    // "Winner refreshes": its socket drops; the slot is vacant.
    b.conn.disconnect();
    expect(bridge.isSandboxConnected()).toBe(false);

    // Tab A's next health poll sees sandboxConnected:false and reconnects.
    await tick(120);
    expect(a.conn.state().kind).toBe('connected');
    expect(bridge.isSandboxConnected()).toBe(true);
    expect(subReplayedToA).toBe(true); // sub registry replayed on reclaim
  });

  it('a brand-new tab still wins the slot immediately (last-connection-wins unchanged)', async () => {
    const bridge = makeStack();
    connectClient(bridge);
    await tick(20);
    const genA = bridge.peerGeneration();

    const b = connectClient(bridge);
    await tick(20);
    expect(bridge.peerGeneration()).toBe(genA + 1);
    expect(b.conn.state().kind).toBe('connected');
    expect(bridge.isSandboxConnected()).toBe(true);
  });

  it('network-drop closes keep the immediate reconnect loop (no health gate)', async () => {
    const bridge = makeStack();
    const a = connectClient(bridge);
    await tick(20);
    expect(a.conn.state().kind).toBe('connected');
    const socketsBefore = LinkedWebSocket.instances.length;

    a.socket().dropFromNetwork(); // code 1006 — not a replacement
    await tick(60); // > initialReconnectDelayMs (10ms)

    expect(LinkedWebSocket.instances.length).toBe(socketsBefore + 1);
    expect(a.conn.state().kind).toBe('connected'); // re-helloed and re-acked
    expect(a.states).toContain('reconnecting'); // took the reconnect path, not standby
    expect(a.states).not.toContain('standby');
    expect(bridge.isSandboxConnected()).toBe(true);
  });

  it('an in-flight worker op SURVIVES two-tab standby steady-state (the churn regression)', async () => {
    const bridge = makeStack();
    // Tab A: slow relay — its ops take 150ms, longer than many pre-fix fight
    // cycles (10ms reconnect delay here). Pre-fix, tab B's re-hello landed
    // mid-op and failAllPending rejected it with 'unavailable'.
    connectClient(bridge, {
      onWorkerOp: async () => {
        await tick(150);
        return { slow: true };
      },
    });
    await tick(20);
    // Tab B arrives, wins the slot with the same slow relay, and tab A goes
    // standby instead of fighting back.
    connectClient(bridge, {
      onWorkerOp: async () => {
        await tick(150);
        return { slow: true };
      },
    });
    await tick(20);

    const result = await bridge.dispatchWorkerOp({ method: 'getVersion' } as never);
    expect(result).toEqual({ slow: true });
  });
});

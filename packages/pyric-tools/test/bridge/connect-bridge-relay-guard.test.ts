/**
 * connectBridge's worker relay — the anti-corruption guard AT ITS CALL SITE.
 *
 * relay-binary-guard.test.ts unit-tests `assertJsonSafeRelayValue`; this
 * file proves `connectBridge` actually invokes it on BOTH relay legs:
 * deleting the guard call in `handleWorkerOp` (or the snap path in
 * `handleWorkerSub`) fails these tests.
 *
 * No real WS: the WebSocket global is faked (the same pattern as
 * `packages/studio/src/clients/bridge-peer.test.ts`) and worker frames are
 * injected through `onmessage`, so the REAL `connectBridge` wiring runs
 * end-to-end in-process with a recording `workerRelay`.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { connectBridge, type ConnectedBridge } from '../../src/bridge/client/bridge.js';

// ── Fake browser WebSocket (studio's bridge-peer.test.ts pattern) ──────────

type WsEvent = { data?: string; code?: number; reason?: string };

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: WsEvent) => void) | null = null;
  onclose: ((ev: WsEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: 'closed by client' });
  }
  // test drivers
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

function installFakeWebSocket(): () => void {
  const prev = (globalThis as { WebSocket?: unknown }).WebSocket;
  FakeWebSocket.instances = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  return () => {
    (globalThis as { WebSocket?: unknown }).WebSocket = prev;
  };
}

function tick(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Harness ─────────────────────────────────────────────────────────────────

let restoreWs: (() => void) | null = null;
let connection: ConnectedBridge | null = null;

afterEach(() => {
  connection?.disconnect();
  connection = null;
  restoreWs?.();
  restoreWs = null;
});

/** Bring up the REAL connectBridge over the fake socket with a recording
 *  relay whose op results / snap deliveries the test controls. */
function connectWithRelay(opResult: (method: string) => unknown) {
  restoreWs = installFakeWebSocket();
  let deliverSnap: ((value: unknown) => void) | null = null;
  connection = connectBridge(initializeSandbox(), {
    url: 'ws://localhost:5174/sandbox',
    noReconnect: true,
    workerRelay: {
      op: async (op) => opResult(op.method),
      subscribe: (_sub, onValue) => {
        deliverSnap = onValue;
        return () => {
          deliverSnap = null;
        };
      },
    },
  });
  const ws = FakeWebSocket.instances[0]!;
  ws.open();
  ws.emit({ type: 'hello-ack', bridgeVersion: 'test' });
  return { ws, snap: (value: unknown) => deliverSnap!(value) };
}

// ── worker-op leg ───────────────────────────────────────────────────────────

describe('connectBridge handleWorkerOp — binary guard at the call site', () => {
  it('a Blob-bearing op result fails the op with the guard error (never a corrupted ok)', async () => {
    const { ws } = connectWithRelay((method) =>
      method === 'storage.getBlob' ? new Blob(['png-bytes']) : { fine: true },
    );
    expect((ws.sent[0] as { capabilities?: string[] }).capabilities).toEqual(['worker-relay']);

    ws.emit({ type: 'worker-op', id: 'op-1', op: { method: 'storage.getBlob', path: 'x' } });
    await tick();

    const res = ws.sent.find((m) => m.type === 'worker-res' && m.id === 'op-1') as {
      ok: boolean;
      error?: { code: string; message: string };
    };
    expect(res).toBeDefined();
    expect(res.ok).toBe(false);
    expect(res.error!.code).toBe('invalid-argument');
    expect(res.error!.message).toContain("op 'storage.getBlob'");
    expect(res.error!.message).toContain('Blob');
    expect(res.error!.message).toContain('storage.getBytes');
  });

  it('a JSON-safe op result still relays ok', async () => {
    const { ws } = connectWithRelay(() => ({ dataB64: 'aGVsbG8=', size: 5 }));
    ws.emit({ type: 'worker-op', id: 'op-2', op: { method: 'storage.getBytes', path: 'x' } });
    await tick();

    const res = ws.sent.find((m) => m.type === 'worker-res' && m.id === 'op-2') as {
      ok: boolean;
      value: unknown;
    };
    expect(res.ok).toBe(true);
    expect(res.value).toEqual({ dataB64: 'aGVsbG8=', size: 5 });
  });
});

// ── worker-snap leg ─────────────────────────────────────────────────────────

describe('connectBridge handleWorkerSub — binary guard on snap values', () => {
  it('a binary snap value fails the sub via the __error convention (never corrupted delivery)', async () => {
    const { ws, snap } = connectWithRelay(() => null);
    ws.emit({ type: 'worker-sub', subId: 'sub-1', sub: { target: { service: 'rtdb', path: 'x' } } });
    await tick();

    snap(new Uint8Array([137, 80, 78, 71]));
    await tick();

    const frame = ws.sent.find((m) => m.type === 'worker-snap' && m.subId === 'sub-1') as {
      value: { __error?: { code: string; message: string } };
    };
    expect(frame).toBeDefined();
    expect(frame.value.__error).toBeDefined();
    expect(frame.value.__error!.code).toBe('invalid-argument');
    expect(frame.value.__error!.message).toContain("subscription 'sub-1'");
    expect(frame.value.__error!.message).toContain('Uint8Array');
    expect(frame.value.__error!.message).toContain('storage.getBytes');
  });

  it('a JSON-safe snap value still relays normally', async () => {
    const { ws, snap } = connectWithRelay(() => null);
    ws.emit({ type: 'worker-sub', subId: 'sub-2', sub: { target: { service: 'rtdb', path: 'x' } } });
    await tick();

    snap({ key: 'x', exists: true, value: 42, size: 1 });
    await tick();

    const frame = ws.sent.find((m) => m.type === 'worker-snap' && m.subId === 'sub-2') as {
      value: Record<string, unknown>;
    };
    expect(frame.value).toEqual({ key: 'x', exists: true, value: 42, size: 1 });
  });
});

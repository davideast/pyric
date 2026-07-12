/**
 * Studio bridge peer (`bridge-peer.ts`) — the wiring that registers SERVED
 * Studio as the bridge's sandbox peer, so a Studio-only session (what
 * `pyric dev --ui` auto-opens) serves agent tool-calls and remote worker-ops
 * instead of failing with "no browser tab is connected".
 *
 * No browser, no real WS, no real worker: the WebSocket global is faked (the
 * transport `connectBridge` drives), the SharedWorker is the same recording
 * shim `worker-live.test.ts` uses, and worker replies are injected through the
 * port's `onmessage` — so the tests exercise the REAL `connectBridge` +
 * `callTool`/`relayWorkerOp`/`relayWorkerSub` wiring end-to-end in-process.
 *
 * Covers:
 *   - no-op when no serve answers /__pyric/init.json (dev-seed / review), when
 *     the response isn't JSON (a Vite SPA fallback), and when the bridge is off
 *   - connects as a relay-capable peer: hello advertises `worker-relay`, the
 *     WS URL is re-anchored to the page origin
 *   - serves a worker-op / worker-sub / tool-call through the worker port —
 *     the same frames the worker-relay suite drives from the Node side
 *   - reconnects after a WS drop (the app page's resilience, inherited)
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { connectStudioBridgePeer } from './bridge-peer.js';
import { createStudioEnvironment } from '../env.js';
import { getFirestore, type ClientDb } from '@pyric/cli/serve/worker';

// ── Fakes ──────────────────────────────────────────────────────────────────

type WsEvent = { data?: string; code?: number; reason?: string };

/** Minimal browser-WebSocket fake capturing every instance + sent frame. */
class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: WsEvent) => void) | null = null;
  onclose: ((ev: WsEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
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
  drop(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: 'dropped' });
  }
}

/** Recorded worker port: captures page→worker posts; tests reply by invoking
 *  `onmessage` (the handler `wirePort` installed) — same style as
 *  `worker-live.test.ts`, plus the reply channel. */
interface RecordedPort {
  posts: Array<Record<string, unknown>>;
  reply(msg: unknown): void;
}

function shimSharedWorker(): { restore: () => void; lastPort: () => RecordedPort } {
  const prevWorker = (globalThis as { SharedWorker?: unknown }).SharedWorker;
  let current: RecordedPort | null = null;
  (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
    port: {
      postMessage(m: unknown): void;
      start(): void;
      onmessage: ((ev: { data: unknown }) => void) | null;
    };
    constructor(_url: unknown, _opts: unknown) {
      const posts: Array<Record<string, unknown>> = [];
      const port = {
        posts,
        postMessage: (m: unknown) => posts.push(m as Record<string, unknown>),
        start() {},
        onmessage: null as ((ev: { data: unknown }) => void) | null,
      };
      this.port = port;
      current = {
        posts,
        reply: (msg) => port.onmessage?.({ data: msg }),
      };
    }
  };
  return {
    restore: () => {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = prevWorker;
    },
    lastPort: () => {
      if (!current) throw new Error('no SharedWorker constructed');
      return current;
    },
  };
}

function installFakeWebSocket(): () => void {
  const prev = (globalThis as { WebSocket?: unknown }).WebSocket;
  FakeWebSocket.instances = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
  return () => {
    (globalThis as { WebSocket?: unknown }).WebSocket = prev;
  };
}

const LOC = { href: 'http://localhost:3473/__pyric/ui/', protocol: 'http:', host: 'localhost:3473' };

function servedFetch(bridgeUrl: string | null): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ bridgeUrl }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

function tick(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('connectStudioBridgePeer', () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length) restores.pop()!();
  });

  function makeDb(): { db: ClientDb; port: () => RecordedPort } {
    const shim = shimSharedWorker();
    restores.push(shim.restore);
    const db = getFirestore('/__pyric/sdk/worker.js');
    return { db, port: shim.lastPort };
  }

  it('no-ops when no serve answers init.json (dev-seed / review mode)', async () => {
    restores.push(installFakeWebSocket());
    const { db } = makeDb();
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await connectStudioBridgePeer(db, { fetchImpl: failing, locationLike: LOC })).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('no-ops on a non-JSON answer (a plain Vite host SPA-falls-back to HTML)', async () => {
    restores.push(installFakeWebSocket());
    const { db } = makeDb();
    const html = (async () =>
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;
    expect(await connectStudioBridgePeer(db, { fetchImpl: html, locationLike: LOC })).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('no-ops when the serve runs without --bridge (bridgeUrl null)', async () => {
    restores.push(installFakeWebSocket());
    const { db } = makeDb();
    expect(
      await connectStudioBridgePeer(db, { fetchImpl: servedFetch(null), locationLike: LOC }),
    ).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('connects as a relay-capable peer on the page origin and serves worker frames', async () => {
    restores.push(installFakeWebSocket());
    const { db, port } = makeDb();

    const bridge = await connectStudioBridgePeer(db, {
      // A baked host that differs from the page origin: the peer must
      // re-anchor to the page's own host (Tailscale / LAN / https safety).
      fetchImpl: servedFetch('ws://127.0.0.1:3473/__pyric/sandbox'),
      locationLike: LOC,
    });
    expect(bridge).not.toBeNull();
    restores.push(() => bridge!.disconnect());
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toBe('ws://localhost:3473/__pyric/sandbox');

    // hello advertises the worker-relay capability + the sandbox tool names —
    // the same hello the served app page sends.
    ws.open();
    const hello = ws.sent[0] as { type: string; capabilities?: string[]; tools: string[] };
    expect(hello.type).toBe('hello');
    expect(hello.capabilities).toContain('worker-relay');
    expect(hello.tools.length).toBeGreaterThan(0);
    ws.emit({ type: 'hello-ack', protocol: 1, bridgeVersion: 'test' });
    expect(bridge!.state()).toEqual({ kind: 'connected', bridgeVersion: 'test' });

    // worker-op → forwarded over the worker port; the reply comes back as
    // worker-res correlated by the BRIDGE id.
    ws.emit({ type: 'worker-op', id: 'w1', op: { method: 'getVersion' } });
    await tick();
    const opPost = port().posts.find((p) => p.t === 'op' && p.method === 'getVersion')!;
    expect(opPost).toBeDefined();
    port().reply({ t: 'res', id: opPost.id, ok: true, value: { version: 'dev' } });
    await tick();
    expect(ws.sent).toContainEqual({ type: 'worker-res', id: 'w1', ok: true, value: { version: 'dev' } });

    // worker-sub → relayed subscription; snaps stream back tagged with the
    // bridge's subId; unsub tears the worker listener down.
    ws.emit({ type: 'worker-sub', subId: 's1', sub: { target: { __ref: 'doc', path: 'rooms/lobby' } } });
    const subPost = port().posts.find((p) => p.t === 'sub')!;
    expect(subPost).toBeDefined();
    port().reply({ t: 'snap', subId: subPost.subId, value: { open: true } });
    expect(ws.sent).toContainEqual({ type: 'worker-snap', subId: 's1', value: { open: true } });
    ws.emit({ type: 'worker-unsub', subId: 's1' });
    expect(port().posts.some((p) => p.t === 'unsub' && p.subId === subPost.subId)).toBe(true);

    // tool-call → dispatched through the worker (`callTool`), not in-page.
    ws.emit({ type: 'tool-call', id: 't1', name: 'sandbox_inspect', args: {} });
    await tick();
    const toolPost = port().posts.find((p) => p.t === 'tool')!;
    expect(toolPost.name).toBe('sandbox_inspect');
    port().reply({ t: 'res', id: toolPost.id, ok: true, value: { ok: true, summary: 'inspected' } });
    await tick();
    expect(ws.sent).toContainEqual({
      type: 'tool-result',
      id: 't1',
      ok: true,
      result: { ok: true, summary: 'inspected' },
    });
  });

  it('createStudioEnvironment(local) wires the peer when a serve answers (and stays sync)', async () => {
    restores.push(installFakeWebSocket());
    const shim = shimSharedWorker();
    restores.push(shim.restore);
    const prevFetch = globalThis.fetch;
    globalThis.fetch = servedFetch('ws://localhost:3473/__pyric/sandbox');
    restores.push(() => {
      globalThis.fetch = prevFetch;
    });

    const env = createStudioEnvironment('local');
    expect(env.live).toBeDefined(); // the factory itself stays synchronous
    await tick();
    // The fire-and-forget peer connect opened the bridge WS.
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]!.url).toBe('ws://localhost:3473/__pyric/sandbox');
  });

  it('reconnects after a WS drop (the app page resilience, inherited)', async () => {
    restores.push(installFakeWebSocket());
    const { db } = makeDb();
    const bridge = await connectStudioBridgePeer(db, {
      fetchImpl: servedFetch('ws://localhost:3473/__pyric/sandbox'),
      locationLike: LOC,
      initialReconnectDelayMs: 10,
      maxReconnectDelayMs: 20,
    });
    restores.push(() => bridge!.disconnect());
    const first = FakeWebSocket.instances[0]!;
    first.open();
    first.emit({ type: 'hello-ack', protocol: 1, bridgeVersion: 'test' });

    first.drop();
    expect(bridge!.state().kind).toBe('reconnecting');
    await tick(30);
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    const second = FakeWebSocket.instances[1]!;
    second.open();
    second.emit({ type: 'hello-ack', protocol: 1, bridgeVersion: 'test' });
    expect(bridge!.state()).toEqual({ kind: 'connected', bridgeVersion: 'test' });
  });
});

/**
 * End-to-end characterization of the generic worker relay (remote sandbox,
 * slice 1 / checkpoint 1) — fully in-process, no browser, no real WS.
 *
 * The whole chain is wired with the documented seams:
 *
 *   Node client core (`createRemoteSandboxCore`, injected transport)
 *     ⇄ consumer session (`createConsumerSession`)
 *     ⇄ bridge core (`createBridge` — pending ops, sub registry, generations)
 *     ⇄ fake browser peer (a `send` function playing `connectBridge`'s
 *        worker-relay role)
 *     ⇄ REAL worker host (`handleMessage` + fake `{ postMessage }` ports —
 *        the same harness style as test/serve/worker/host.test.ts)
 *
 * Coverage (per the checkpoint-1 spec):
 *   - op round-trip (RTDB conveniences + raw channel + auth admin CRUD)
 *   - subscription snap delivery (initial + updates), unsub stops delivery
 *   - fail-fast when no peer; timeout when the peer never responds
 *   - peer replacement mid-subscription: stale-generation snaps dropped,
 *     registry re-issued to the new peer
 *   - reconnect: in-flight ops fail on peer loss, subs resume on new peer
 *   - subscription establishment errors relay as rejections (`__error` snap)
 */

import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { createBridge, type Bridge } from '../../src/bridge/server/bridge.js';
import { createConsumerSession, attachPeer } from '../../src/bridge/server/peer.js';
import {
  WORKER_RELAY_CAPABILITY,
  type BridgeMessage,
} from '../../src/bridge/protocol.js';
import {
  createRemoteSandboxCore,
  buildRemoteRtdb,
  buildRemoteAuthAdmin,
  type RemoteSandboxCore,
  type RemoteRtdbSnapshot,
} from '../../src/remote/index.js';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
} from '../../src/serve/worker/protocol.js';
import { initializeSandbox, createMemoryBackend } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import type { AuthUserRecord } from 'pyric/auth';

// ─── Harness ──────────────────────────────────────────────────────────────

const PERMISSIVE_RULES = `
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      match /{document=**} {
        allow read, write: if true;
      }
    }
  }
`;

/** Build a REAL worker host ctx (in-memory sandbox) — one per "SharedWorker". */
async function makeWorkerCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(sandbox.withAuth(null)).setRules(PERMISSIVE_RULES);
  await sandbox.enablePersistence({
    key: `relay-test-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  return { db: getFirestore(sandbox), sandbox, instanceId: 'relay-test', subs: new Map() };
}

function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface FakeTab {
  /** Unregister, as the transport would on WS close. */
  disconnect: () => void;
  /** This tab's worker-side port (a distinct port per tab, one shared ctx). */
  port: PortLike;
  /** True once the bridge's onReplaced hook fired for this tab. */
  wasReplaced: () => boolean;
  /** SubIds currently relayed into the worker on this tab's behalf. */
  activeSubIds: () => ReadonlySet<string>;
}

/**
 * Register a fake browser tab as the bridge's sandbox peer. Plays exactly
 * the role `connectBridge`'s `workerRelay` plays: worker frames from the
 * bridge go into the REAL worker host; the fake port's posts come back as
 * `worker-res` / `worker-snap`, tagged with the generation captured at
 * registration (like `attachPeer` does), so a replaced tab's late frames
 * are verifiably stale.
 *
 * On replacement the bridge fires `onReplaced` (the transport closes the
 * old socket; the browser's close handler runs `teardownRelaySubs`) — the
 * harness models that teardown by unsubscribing this tab's relayed worker
 * subs. `keepAliveOnReplace` skips it, simulating the async window where
 * the close hasn't landed yet and stale frames are still in flight.
 */
function connectTab(
  bridge: Bridge,
  ctx: HostCtx,
  opts: { dropOps?: boolean; keepAliveOnReplace?: boolean } = {},
): FakeTab {
  let gen = 0;
  let replaced = false;
  const activeSubIds = new Set<string>();
  const port: PortLike = {
    postMessage(raw: unknown) {
      const m = raw as OutboundMessage;
      if (m.t === 'res') {
        bridge.handleSandboxMessage(
          m.ok
            ? { type: 'worker-res', id: m.id, ok: true, value: m.value }
            : { type: 'worker-res', id: m.id, ok: false, error: m.error },
          gen,
        );
      } else if (m.t === 'snap') {
        bridge.handleSandboxMessage(
          { type: 'worker-snap', subId: m.subId, value: m.value },
          gen,
        );
      }
    },
  };
  const send = (msg: BridgeMessage): void => {
    // First send happens inside registerSandboxPeer (sub replay) — the
    // generation is already bumped by then, so capture it lazily.
    if (gen === 0) gen = bridge.peerGeneration();
    if (msg.type === 'worker-op') {
      if (opts.dropOps) return; // simulate a hung tab (timeout tests)
      void handleMessage(ctx, port, { ...msg.op, t: 'op', id: msg.id } as InboundMessage);
    } else if (msg.type === 'worker-sub') {
      activeSubIds.add(msg.subId);
      void handleMessage(ctx, port, { ...msg.sub, t: 'sub', subId: msg.subId } as InboundMessage);
    } else if (msg.type === 'worker-unsub') {
      activeSubIds.delete(msg.subId);
      void handleMessage(ctx, port, { t: 'unsub', subId: msg.subId } as InboundMessage);
    }
  };
  const onReplaced = (): void => {
    replaced = true;
    if (opts.keepAliveOnReplace) return; // simulate in-flight staleness window
    // The browser's WS close handler (`teardownRelaySubs`) unsubscribes every
    // relayed worker listener for this connection.
    for (const subId of [...activeSubIds]) {
      activeSubIds.delete(subId);
      void handleMessage(ctx, port, { t: 'unsub', subId } as InboundMessage);
    }
  };
  const disconnect = bridge.registerSandboxPeer(
    send,
    [],
    'fake-tab',
    [WORKER_RELAY_CAPABILITY],
    onReplaced,
  );
  return {
    disconnect,
    port,
    wasReplaced: () => replaced,
    activeSubIds: () => activeSubIds,
  };
}

/** Wire a Node client core to the bridge through a real ConsumerSession. */
function connectNode(bridge: Bridge, opts: { opTimeoutMs?: number } = {}) {
  let core: RemoteSandboxCore;
  const session = createConsumerSession(bridge, (msg) => core.handleMessage(msg));
  core = createRemoteSandboxCore(
    { send: (msg) => session.handleMessage(msg) },
    { serveUrl: 'http://localhost:5000', opTimeoutMs: opts.opTimeoutMs },
  );
  core.start();
  return {
    core,
    session,
    channel: core.channel,
    rtdb: buildRemoteRtdb(core.channel),
    auth: buildRemoteAuthAdmin(core.channel),
  };
}

function makeRelayBridge(callTimeoutMs?: number): Bridge {
  return createBridge({ version: 'test', callTimeoutMs });
}

/** Minimal fake of the `ws` WebSocket surface `attachPeer` consumes. */
function fakeWs() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const sent: unknown[] = [];
  const self = {
    sent,
    closed: false,
    on(event: string, cb: (...args: unknown[]) => void) {
      handlers.set(event, cb);
      return self;
    },
    send(data: string) {
      sent.push(JSON.parse(data));
    },
    close() {
      if (self.closed) return;
      self.closed = true;
      handlers.get('close')?.();
    },
    emitMessage(msg: unknown) {
      handlers.get('message')?.(JSON.stringify(msg));
    },
    emitRaw(raw: string) {
      handlers.get('message')?.(raw);
    },
    asWebSocket: () => self as unknown as Parameters<typeof attachPeer>[1],
  };
  return self;
}

// ─── Op round-trips ───────────────────────────────────────────────────────

describe('worker relay — op round-trip', () => {
  it('relays a raw worker op end-to-end (getVersion)', async () => {
    const bridge = makeRelayBridge();
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);
    const node = connectNode(bridge);
    await node.core.ready;

    const version = (await node.channel.op({ method: 'getVersion' })) as {
      version: string;
      instanceId: string;
    };
    expect(version.version).toBe('dev');
    expect(version.instanceId).toBe('relay-test');
  });

  it('RTDB set/get/update/remove round-trip through the real worker host', async () => {
    const bridge = makeRelayBridge();
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);
    const node = connectNode(bridge);
    await node.core.ready;

    await node.rtdb.set('rooms/lobby', { name: 'Lobby', open: true });
    expect(await node.rtdb.get('rooms/lobby')).toEqual({ name: 'Lobby', open: true });

    await node.rtdb.update('rooms/lobby', { open: false });
    expect(await node.rtdb.get('rooms/lobby')).toEqual({ name: 'Lobby', open: false });

    await node.rtdb.remove('rooms/lobby');
    expect(await node.rtdb.get('rooms/lobby')).toBeNull();
  });

  it('push mints the key client-side and writes the value there', async () => {
    const bridge = makeRelayBridge();
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);
    const node = connectNode(bridge);
    await node.core.ready;

    const { key, path } = await node.rtdb.push('messages', { text: 'hi' });
    expect(key).toHaveLength(20);
    expect(path).toBe(`/messages/${key}`);
    expect(await node.rtdb.get(`messages/${key}`)).toEqual({ text: 'hi' });
  });

  it('worker errors relay with their code', async () => {
    const bridge = makeRelayBridge();
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);
    const node = connectNode(bridge);
    await node.core.ready;

    // A one-segment doc path is invalid — the worker host's typed error
    // (code + message) must survive both relay legs.
    try {
      await node.channel.op({ method: 'getDoc', path: 'only-one-segment' });
      throw new Error('expected rejection');
    } catch (err) {
      expect((err as { code?: string }).code).toBeTruthy();
      expect((err as Error).message).toContain('only-one-segment');
    }
  });
});

// ─── Auth admin CRUD passthrough ──────────────────────────────────────────

describe('worker relay — auth admin user CRUD', () => {
  it('createUser / listUsers / updateUser / deleteUser / clearUsers', async () => {
    const bridge = makeRelayBridge();
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);
    const node = connectNode(bridge);
    await node.core.ready;

    const created = await node.auth.createUser({
      email: 'ada@example.com',
      password: 'correct-horse',
      displayName: 'Ada',
    });
    expect(created.uid).toBeTruthy();
    expect(created.email).toBe('ada@example.com');

    let users: AuthUserRecord[] = await node.auth.listUsers();
    expect(users.map((u) => u.email)).toEqual(['ada@example.com']);

    const updated = await node.auth.updateUser(created.uid, {
      displayName: 'Ada Lovelace',
      customClaims: { admin: true },
    });
    expect(updated.displayName).toBe('Ada Lovelace');
    expect(updated.customClaims).toEqual({ admin: true });

    await node.auth.deleteUser(created.uid);
    users = await node.auth.listUsers();
    expect(users).toHaveLength(0);

    await node.auth.createUser({ email: 'b@example.com', password: 'pw-123456' });
    await node.auth.clearUsers();
    expect(await node.auth.listUsers()).toHaveLength(0);
  });
});

// ─── Subscriptions ────────────────────────────────────────────────────────

describe('worker relay — RTDB value subscription', () => {
  it('delivers the initial snapshot and every update; unsub stops delivery', async () => {
    const bridge = makeRelayBridge();
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);
    const node = connectNode(bridge);
    await node.core.ready;

    await node.rtdb.set('counter', { n: 1 });

    const snaps: RemoteRtdbSnapshot[] = [];
    const unsubscribe = node.rtdb.onValue('counter', (snap) => snaps.push(snap));
    await tick();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.value).toEqual({ n: 1 });

    await node.rtdb.set('counter', { n: 2 });
    await tick();
    expect(snaps).toHaveLength(2);
    expect(snaps[1]!.value).toEqual({ n: 2 });

    unsubscribe();
    await tick();
    await node.rtdb.set('counter', { n: 3 });
    await tick();
    expect(snaps).toHaveLength(2); // no delivery after unsub
  });

  it('relays a failed subscription establishment as an error (__error snap)', async () => {
    const bridge = makeRelayBridge();
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);
    const node = connectNode(bridge);
    await node.core.ready;

    const errors: Array<Error & { code: string }> = [];
    const snaps: unknown[] = [];
    // A one-segment doc path is invalid — resolveTarget throws synchronously
    // in the worker host, which posts the `{ __error }` snap the relay
    // forwards; the Node side routes it to onError, never onSnap.
    node.channel.subscribe(
      { target: { __ref: 'doc', path: 'only-one-segment' } },
      (s) => snaps.push(s),
      (e) => errors.push(e),
    );
    await tick();
    expect(snaps).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message.length).toBeGreaterThan(0);
  });
});

// ─── Failure modes ────────────────────────────────────────────────────────

describe('worker relay — no peer / timeout', () => {
  it('fails fast with "open <url>" guidance when no browser tab is connected', async () => {
    const bridge = makeRelayBridge();
    const node = connectNode(bridge);
    // attach-ack reports peerConnected: false → ready rejects with guidance.
    await expect(node.core.ready).rejects.toThrow(/open http:\/\/localhost:5000/);

    // Per-op failures carry the same enriched guidance (fast — no 30s wait).
    const started = Date.now();
    try {
      await node.rtdb.get('anything');
      throw new Error('expected rejection');
    } catch (err) {
      expect((err as Error).message).toContain('open http://localhost:5000');
      expect((err as { code?: string }).code).toBe('unavailable');
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('times out when the peer never responds (bridge callTimeoutMs)', async () => {
    const bridge = makeRelayBridge(50); // 50ms bridge-side op budget
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx, { dropOps: true }); // hung tab: ops vanish
    const node = connectNode(bridge);
    await node.core.ready;

    const started = Date.now();
    try {
      await node.rtdb.get('anything');
      throw new Error('expected rejection');
    } catch (err) {
      expect((err as Error).message).toContain('timed out after 50ms');
      expect((err as { code?: string }).code).toBe('deadline-exceeded');
    }
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('rejects worker ops against a peer that lacks the worker-relay capability', async () => {
    const bridge = makeRelayBridge();
    // An OLD peer: registered without capabilities (pre-relay hello).
    bridge.registerSandboxPeer(() => {}, [], 'old-tab');
    const node = connectNode(bridge);
    try {
      await node.channel.op({ method: 'getVersion' });
      throw new Error('expected rejection');
    } catch (err) {
      expect((err as Error).message).toContain('does not support the worker relay');
    }
  });
});

// ─── Peer replacement + reconnect ─────────────────────────────────────────

describe('worker relay — peer replacement and reconnect', () => {
  it('replacement mid-subscription: stale-generation snaps dropped, sub re-issued to the new peer', async () => {
    const bridge = makeRelayBridge();
    const ctx = await makeWorkerCtx(); // ONE SharedWorker shared by both tabs
    // keepAliveOnReplace: simulate the async window where the replaced tab's
    // socket close hasn't landed yet, so its worker port KEEPS firing — those
    // frames are tagged with the OLD generation and MUST be dropped.
    connectTab(bridge, ctx, { keepAliveOnReplace: true });
    const node = connectNode(bridge);
    await node.core.ready;

    await node.rtdb.set('game/state', { round: 1 });

    const snaps: RemoteRtdbSnapshot[] = [];
    node.rtdb.onValue('game/state', (snap) => snaps.push(snap));
    await tick();
    expect(snaps).toHaveLength(1); // initial via tab A

    // Tab "refresh": a NEW tab registers (last-connection-wins). The bridge
    // re-issues the sub registry to tab B; tab B's fresh initial snapshot is
    // byte-identical to what the consumer already holds (nothing changed) so
    // it is suppressed, and tab A's still-live deliveries are
    // stale-generation and must not reach the consumer.
    connectTab(bridge, ctx);
    await tick();
    expect(snaps).toHaveLength(1); // NO delivery: listeners fire on change, not on peer churn

    await node.rtdb.set('game/state', { round: 2 });
    await tick();
    // Both tabs' worker ports fire; only tab B's (current generation) lands.
    expect(snaps).toHaveLength(2);
    expect(snaps[1]!.value).toEqual({ round: 2 });
  });

  it('replacement tears the old peer down: onReplaced fires and its relayed worker subs unsubscribe', async () => {
    const bridge = makeRelayBridge();
    const ctx = await makeWorkerCtx();
    const tabA = connectTab(bridge, ctx);
    const node = connectNode(bridge);
    await node.core.ready;

    const snaps: RemoteRtdbSnapshot[] = [];
    node.rtdb.onValue('game/state', (snap) => snaps.push(snap));
    await tick();
    expect(snaps).toHaveLength(1);
    expect(tabA.activeSubIds().size).toBe(1);
    expect(ctx.subs.get(tabA.port)?.size).toBe(1); // live listener in the worker

    // A new tab replaces tab A: the bridge MUST notify the old peer so the
    // transport closes its socket and the browser tears its relay subs down
    // — otherwise tab A's SharedWorker listeners would stream snaps the
    // bridge drops as stale until the tab closed.
    const tabB = connectTab(bridge, ctx);
    await tick();
    expect(tabA.wasReplaced()).toBe(true);
    expect(tabB.wasReplaced()).toBe(false);
    expect(tabA.activeSubIds().size).toBe(0);
    expect(ctx.subs.get(tabA.port)?.size ?? 0).toBe(0); // worker listener gone

    // Delivery continues via tab B only.
    await node.rtdb.set('game/state', { round: 2 });
    await tick();
    expect(snaps[snaps.length - 1]!.value).toEqual({ round: 2 });
    expect(ctx.subs.get(tabB.port)?.size).toBe(1);
  });

  it('reconnect: in-flight ops fail on peer loss; subs resume on the next peer', async () => {
    const bridge = makeRelayBridge();
    const ctx = await makeWorkerCtx();
    const tabA = connectTab(bridge, ctx, { dropOps: true }); // ops hang → in-flight on disconnect
    const node = connectNode(bridge);
    await node.core.ready;

    const snaps: RemoteRtdbSnapshot[] = [];
    node.rtdb.onValue('doc', (snap) => snaps.push(snap));
    await tick();
    expect(snaps).toHaveLength(1); // initial (null) via tab A — subs are not dropped

    const inFlight = node.rtdb.get('doc');
    tabA.disconnect(); // WS close → in-flight ops fail with the no-tab error
    try {
      await inFlight;
      throw new Error('expected rejection');
    } catch (err) {
      expect((err as Error).message).toContain('open http://localhost:5000');
    }

    // Ops while no peer is connected fail fast with the same guidance.
    await expect(node.rtdb.get('doc')).rejects.toThrow(/open http:\/\/localhost:5000/);

    // A new tab connects: the bridge re-issues the sub (ops work again), but
    // the re-established listener's initial snapshot matches what the
    // consumer already holds — suppressed, not re-delivered.
    connectTab(bridge, ctx);
    await tick();
    expect(snaps).toHaveLength(1); // unchanged across the gap ⇒ no re-fire

    await node.rtdb.set('doc', { alive: true });
    await tick();
    expect(snaps).toHaveLength(2);
    expect(snaps[snaps.length - 1]!.value).toEqual({ alive: true });
    expect(await node.rtdb.get('doc')).toEqual({ alive: true });
  });

  it('repeated peer churn re-fires NOTHING while state is unchanged (doc + query listener)', async () => {
    // The live "snapshot spam" bug: two tabs (app + Studio) cycling through
    // last-wins registration re-issued every sub once per registration, and
    // each re-issued listener's initial snapshot reached the consumer — a
    // remote onSnapshot fired ~1/sec with byte-identical data, forever. A
    // consumer whose callback writes anything becomes an infinite write loop.
    const bridge = makeRelayBridge();
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);
    const node = connectNode(bridge);
    await node.core.ready;

    await node.channel.op({
      method: 'setDoc', path: 'live/check', data: { n: 1, at: 'fixed' }, actAs: { mode: 'admin' },
    });

    const docSnaps: unknown[] = [];
    const querySnaps: unknown[] = [];
    node.channel.subscribe(
      { target: { __ref: 'doc', path: 'live/check' }, actAs: { mode: 'admin' } },
      (v) => docSnaps.push(v),
    );
    node.channel.subscribe(
      { target: { __ref: 'collection', path: 'live' }, actAs: { mode: 'admin' } },
      (v) => querySnaps.push(v),
    );
    await tick();
    expect(docSnaps).toHaveLength(1); // initial snapshots only
    expect(querySnaps).toHaveLength(1);

    // Five churn cycles — pre-fix each one delivered a duplicate per sub.
    for (let i = 0; i < 5; i++) {
      connectTab(bridge, ctx);
      await tick();
    }
    expect(docSnaps).toHaveLength(1); // zero extra emissions
    expect(querySnaps).toHaveLength(1);

    // Legitimate changes still deliver 1:1 — including rapid consecutive
    // writes (two real changes = two emissions, never collapsed).
    await node.channel.op({
      method: 'setDoc', path: 'live/check', data: { n: 2, at: 'fixed' }, actAs: { mode: 'admin' },
    });
    await node.channel.op({
      method: 'setDoc', path: 'live/check', data: { n: 3, at: 'fixed' }, actAs: { mode: 'admin' },
    });
    await tick();
    expect(docSnaps).toHaveLength(3);
    expect(querySnaps).toHaveLength(3);
  });

  it('re-issue DELIVERS when state changed while no peer was attached', async () => {
    const bridge = makeRelayBridge();
    const ctx = await makeWorkerCtx();
    const tabA = connectTab(bridge, ctx);
    const node = connectNode(bridge);
    await node.core.ready;

    await node.channel.op({
      method: 'setDoc', path: 'gap/doc', data: { v: 1 }, actAs: { mode: 'admin' },
    });
    const snaps: Array<{ data?: { json?: string } }> = [];
    node.channel.subscribe(
      { target: { __ref: 'doc', path: 'gap/doc' }, actAs: { mode: 'admin' } },
      (v) => snaps.push(v as { data?: { json?: string } }),
    );
    await tick();
    expect(snaps).toHaveLength(1);

    // Peer drops; the doc changes while nobody is attached (another client of
    // the same worker — modelled as a direct port write to the shared ctx).
    tabA.disconnect();
    await handleMessage(ctx, { postMessage() {} }, {
      t: 'op', id: 'gap-1', method: 'setDoc', path: 'gap/doc',
      data: { v: 2 }, actAs: { mode: 'admin' },
    } as InboundMessage);

    // New peer: the re-issued listener's initial snapshot DIFFERS from the
    // dedup baseline — it must deliver (suppression is duplicate-only).
    connectTab(bridge, ctx);
    await tick();
    expect(snaps).toHaveLength(2);
    expect(JSON.parse(snaps[1]!.data!.json!)).toEqual({ v: 2 });
  });

  it('attachPeer closes the replaced peer\'s socket (onReplaced → ws.close)', async () => {
    const bridge = makeRelayBridge();
    const wsA = fakeWs();
    const wsB = fakeWs();
    attachPeer(bridge, wsA.asWebSocket());
    attachPeer(bridge, wsB.asWebSocket());

    wsA.emitMessage({ type: 'hello', protocol: 1, tools: [], sandboxId: 'a' });
    expect(bridge.isSandboxConnected()).toBe(true);
    expect(wsA.closed).toBe(false);

    // Tab B's hello replaces tab A → the bridge's onReplaced hook must close
    // tab A's socket (whose browser-side close handler tears its subs down).
    wsB.emitMessage({ type: 'hello', protocol: 1, tools: [], sandboxId: 'b' });
    expect(wsA.closed).toBe(true);
    expect(wsB.closed).toBe(false);
    expect(bridge.isSandboxConnected()).toBe(true); // tab B is the peer
  });

  it('consumer disposal tears its subscriptions out of the bridge registry', async () => {
    const bridge = makeRelayBridge();
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);
    const node = connectNode(bridge);
    await node.core.ready;

    const snaps: unknown[] = [];
    node.rtdb.onValue('x', (s) => snaps.push(s));
    await tick();
    expect(snaps).toHaveLength(1);

    // Node WS closed: attachPeer would dispose the session — all bridge-side
    // subs for this consumer unsubscribe (and relay the unsub to the worker).
    node.session.dispose();
    await tick();
    await node.rtdb.set('x', 1).catch(() => {}); // channel still up in-process
    await tick();
    expect(snaps).toHaveLength(1); // no delivery after disposal
  });
});

// ─── attachPeer hardening ─────────────────────────────────────────────────

describe('attachPeer — malformed hello', () => {
  it('non-array tools/capabilities cannot crash the serve process', async () => {
    const bridge = makeRelayBridge();
    const ws = fakeWs();
    attachPeer(bridge, ws.asWebSocket());

    // `tools`/`capabilities` come off the wire — a non-array used to reach
    // `new Set(...)` in the bridge core and throw inside the ws message
    // listener (uncaught → process crash). Must register cleanly instead.
    ws.emitMessage({
      type: 'hello',
      protocol: 1,
      tools: 42,
      sandboxId: 'x',
      capabilities: 42,
    });

    expect(bridge.isSandboxConnected()).toBe(true);
    expect(bridge.opKeys()).toEqual([]); // coerced to empty
    expect((ws.sent[0] as { type: string }).type).toBe('hello-ack');

    // Worker ops fail legibly (no relay capability), not with a crash.
    await expect(bridge.dispatchWorkerOp({ method: 'getVersion' })).rejects.toThrow(
      /does not support the worker relay/,
    );
  });

  it('unparseable and non-bridge messages are ignored', () => {
    const bridge = makeRelayBridge();
    const ws = fakeWs();
    attachPeer(bridge, ws.asWebSocket());
    ws.emitRaw('this is not json {{');
    ws.emitMessage({ type: 'not-a-bridge-frame' });
    expect(bridge.isSandboxConnected()).toBe(false);
    expect(ws.sent).toHaveLength(0);
  });
});

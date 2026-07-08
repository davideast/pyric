/**
 * Remote client — event-loop hold + version-skew guidance (integration-smoke
 * fixes for the remote sandbox client).
 *
 * 1. Exit-hang fix: an IDLE remote connection must not pin the Node event
 *    loop. The core calls the transport's optional `ref()`/`unref()` hooks
 *    on busy/idle TRANSITIONS (first outstanding op or subscription → ref;
 *    last one settles → unref), and the WS adapter unrefs the socket once
 *    connected — so a finished script exits, while in-flight ops/subs still
 *    hold the process.
 *
 * 2. Version skew: a live tab whose SharedWorker predates a new op returns
 *    a raw "Unknown method: …" — the client appends restart/reload guidance.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { createBridge, type Bridge } from '../../src/bridge/server/bridge.js';
import { createConsumerSession } from '../../src/bridge/server/peer.js';
import {
  WORKER_RELAY_CAPABILITY,
  type BridgeMessage,
} from '../../src/bridge/protocol.js';
import {
  createRemoteSandboxCore,
  type RemoteSandboxCore,
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

// ─── Harness (worker-relay.test.ts's, + ref/unref recording) ───────────────

function makeWorkerCtx(): HostCtx {
  const sandbox = initializeSandbox();
  return { db: getFirestore(sandbox), sandbox, instanceId: 'loop-hold-test', subs: new Map() };
}

function connectTab(bridge: Bridge, ctx: HostCtx, opts: { dropOps?: boolean } = {}): void {
  let gen = 0;
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
        bridge.handleSandboxMessage({ type: 'worker-snap', subId: m.subId, value: m.value }, gen);
      }
    },
  };
  const send = (msg: BridgeMessage): void => {
    if (gen === 0) gen = bridge.peerGeneration();
    if (msg.type === 'worker-op') {
      if (opts.dropOps) return;
      void handleMessage(ctx, port, { ...msg.op, t: 'op', id: msg.id } as InboundMessage);
    } else if (msg.type === 'worker-sub') {
      void handleMessage(ctx, port, { ...msg.sub, t: 'sub', subId: msg.subId } as InboundMessage);
    } else if (msg.type === 'worker-unsub') {
      void handleMessage(ctx, port, { t: 'unsub', subId: msg.subId } as InboundMessage);
    }
  };
  bridge.registerSandboxPeer(send, [], 'fake-tab', [WORKER_RELAY_CAPABILITY]);
}

/** Node core over a recording transport: every ref()/unref() lands in
 *  `holds` — the fake-ws assertion seam for the exit-hang fix.
 *  `mutateToClient` intercepts bridge→client frames (the version-skew
 *  tests rewrite/strip the attach-ack's `serveVersion` stamp). */
function connectNode(
  bridge: Bridge,
  opts: {
    opTimeoutMs?: number;
    mutateToClient?: (msg: BridgeMessage) => BridgeMessage;
  } = {},
) {
  const holds: Array<'ref' | 'unref'> = [];
  let core: RemoteSandboxCore;
  const session = createConsumerSession(bridge, (msg) =>
    core.handleMessage(opts.mutateToClient ? opts.mutateToClient(msg) : msg),
  );
  core = createRemoteSandboxCore(
    {
      send: (msg) => session.handleMessage(msg),
      ref: () => holds.push('ref'),
      unref: () => holds.push('unref'),
    },
    { serveUrl: 'http://localhost:5000', opTimeoutMs: opts.opTimeoutMs },
  );
  core.start();
  return { core, session, channel: core.channel, holds };
}

function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Capture stderr writes for the duration of `fn` (skew-warning seam). */
async function captureStderr(fn: () => Promise<void>): Promise<string[]> {
  const logged: string[] = [];
  const prev = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    logged.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = prev;
  }
  return logged;
}

// ─── Event-loop hold ────────────────────────────────────────────────────────

describe('remote core — event-loop hold (ref/unref transitions)', () => {
  it('attach + idle never refs; an op refs once and unrefs when it settles', async () => {
    const bridge = createBridge({ mode: 'sandbox', version: 'test' });
    connectTab(bridge, makeWorkerCtx());
    const node = connectNode(bridge);
    await node.core.ready;
    expect(node.holds).toEqual([]); // attach handshake is not "work"

    await node.channel.op({ method: 'getVersion' });
    expect(node.holds).toEqual(['ref', 'unref']);
  });

  it('overlapping ops hold ONE ref until the last settles (transition-edged)', async () => {
    const bridge = createBridge({ mode: 'sandbox', version: 'test' });
    connectTab(bridge, makeWorkerCtx());
    const node = connectNode(bridge);
    await node.core.ready;

    await Promise.all([
      node.channel.op({ method: 'getVersion' }),
      node.channel.op({ method: 'getVersion' }),
      node.channel.op({ method: 'getVersion' }),
    ]);
    expect(node.holds).toEqual(['ref', 'unref']);
  });

  it('a live subscription holds the ref; unsubscribe releases it', async () => {
    const bridge = createBridge({ mode: 'sandbox', version: 'test' });
    connectTab(bridge, makeWorkerCtx());
    const node = connectNode(bridge);
    await node.core.ready;

    const unsubscribe = node.channel.subscribe(
      { target: { service: 'rtdb', path: 'held' } },
      () => {},
    );
    await tick();
    expect(node.holds).toEqual(['ref']); // still held while the sub lives

    // An op during the sub does NOT double-ref (already busy) …
    await node.channel.op({ method: 'getVersion' });
    expect(node.holds).toEqual(['ref']);

    unsubscribe();
    expect(node.holds).toEqual(['ref', 'unref']);
  });

  it('an op that times out releases the hold; dispose releases everything', async () => {
    const bridge = createBridge({ mode: 'sandbox', version: 'test', callTimeoutMs: 5000 });
    connectTab(bridge, makeWorkerCtx(), { dropOps: true }); // hung tab
    const node = connectNode(bridge, { opTimeoutMs: 30 });
    await node.core.ready;

    await expect(node.channel.op({ method: 'getVersion' })).rejects.toThrow(/timed out/);
    expect(node.holds).toEqual(['ref', 'unref']);

    node.channel.subscribe({ target: { service: 'rtdb', path: 'x' } }, () => {});
    expect(node.holds).toEqual(['ref', 'unref', 'ref']);
    node.core.dispose('closed');
    expect(node.holds).toEqual(['ref', 'unref', 'ref', 'unref']);
  });
});

// ─── Terminal listener errors ───────────────────────────────────────────────

describe('remote core — a listener error is terminal (auto-unsubscribe)', () => {
  it('an __error snap releases the hold, tears down worker-side, and later snaps are dropped', async () => {
    const bridge = createBridge({ mode: 'sandbox', version: 'test' });
    const ctx = makeWorkerCtx();
    connectTab(bridge, ctx);
    const node = connectNode(bridge);
    await node.core.ready;

    // A registration that FAILS worker-side: an empty composite filter is
    // rejected by the modular and() factory and comes back as an __error
    // snap (the same wire shape a mid-stream listener denial uses).
    const errors: Array<Error & { code: string }> = [];
    const snaps: unknown[] = [];
    const unsubscribe = node.channel.subscribe(
      {
        target: {
          __ref: 'query',
          source: { __ref: 'collection', path: 'x' },
          constraints: [{ kind: 'and', filters: [] }],
        },
      },
      (v) => snaps.push(v),
      (e) => errors.push(e),
    );
    await tick();
    expect(errors).toHaveLength(1);
    expect(snaps).toHaveLength(0);

    // TERMINAL: the sub record is gone, so the event-loop hold released
    // WITHOUT the consumer calling unsubscribe — an errored listener must
    // never pin the process (Firestore's onError-is-terminal contract).
    expect(node.holds).toEqual(['ref', 'unref']);

    // The consumer's own unsubscribe is now an idempotent no-op.
    unsubscribe();
    expect(node.holds).toEqual(['ref', 'unref']);

    // And the worker holds no listener for this sub: no port sub records
    // remain in the host ctx (client-side removal sent worker-unsub; a
    // failed registration never stored one).
    let workerSubCount = 0;
    for (const portSubs of ctx.subs.values()) workerSubCount += portSubs.size;
    expect(workerSubCount).toBe(0);
  });
});

// ─── Version-skew stamp (attach-ack serveVersion) ───────────────────────────

describe('remote core — version-skew stamp on attach', () => {
  it('matched versions stay silent (the default in-process stack)', async () => {
    const bridge = createBridge({ mode: 'sandbox', version: 'test' });
    connectTab(bridge, makeWorkerCtx());
    const logged = await captureStderr(async () => {
      const node = connectNode(bridge); // real serveVersion == own version
      await node.core.ready;
      await node.channel.op({ method: 'getVersion' });
    });
    expect(logged.filter((l) => l.includes('restart pyric dev'))).toEqual([]);
  });

  it('an ABSENT stamp (old server) stays silent', async () => {
    const bridge = createBridge({ mode: 'sandbox', version: 'test' });
    connectTab(bridge, makeWorkerCtx());
    const logged = await captureStderr(async () => {
      const node = connectNode(bridge, {
        mutateToClient: (msg) => {
          if (msg.type === 'attach-ack') {
            const { serveVersion: _omit, ...rest } = msg as { serveVersion?: string } & typeof msg;
            return rest as BridgeMessage;
          }
          return msg;
        },
      });
      await node.core.ready;
    });
    expect(logged.filter((l) => l.includes('restart pyric dev'))).toEqual([]);
  });

  it('a mismatched stamp warns ONCE and enriches timeout errors', async () => {
    const bridge = createBridge({ mode: 'sandbox', version: 'test', callTimeoutMs: 5000 });
    connectTab(bridge, makeWorkerCtx(), { dropOps: true }); // hung/skewed tab
    const logged = await captureStderr(async () => {
      const node = connectNode(bridge, {
        opTimeoutMs: 30,
        mutateToClient: (msg) =>
          msg.type === 'attach-ack' ? { ...msg, serveVersion: '9.9.9-skew' } : msg,
      });
      await node.core.ready;

      // Re-attach re-acks: still exactly ONE warning.
      node.session.handleMessage({ type: 'attach', protocol: 1 });
      await tick();

      // A timed-out op names the skew as the likely culprit.
      try {
        await node.channel.op({ method: 'getVersion' });
        throw new Error('expected timeout');
      } catch (err) {
        const message = (err as Error).message;
        expect(message).toContain('timed out');
        expect(message).toContain('9.9.9-skew');
        expect(message).toContain('restart pyric dev and reload the browser tab');
      }
    });
    const warnings = logged.filter((l) => l.includes('restart pyric dev'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('pyric dev is running version 9.9.9-skew');
  });
});

// ─── Version-skew guidance ──────────────────────────────────────────────────

describe('remote core — version-skew guidance on Unknown method', () => {
  it('appends restart/reload guidance when the worker predates an op', async () => {
    const bridge = createBridge({ mode: 'sandbox', version: 'test' });
    connectTab(bridge, makeWorkerCtx());
    const node = connectNode(bridge);
    await node.core.ready;

    // The REAL worker host replies "Unknown method: …" for ops it does not
    // know — exactly what an old tab does when the Node side is newer.
    try {
      await node.channel.op({ method: 'storage.notShippedYet' });
      throw new Error('expected rejection');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('Unknown method: storage.notShippedYet');
      expect(message).toContain('the running sandbox may predate this feature');
      expect(message).toContain('restart pyric dev');
      expect(message).toContain('reload the browser tab');
    }
  });

  it('leaves other worker errors untouched', async () => {
    const bridge = createBridge({ mode: 'sandbox', version: 'test' });
    connectTab(bridge, makeWorkerCtx());
    const node = connectNode(bridge);
    await node.core.ready;

    try {
      await node.channel.op({ method: 'storage.getBytes', path: 'missing/x' });
      throw new Error('expected rejection');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('storage/object-not-found');
      expect((err as Error).message).not.toContain('predate');
    }
  });
});

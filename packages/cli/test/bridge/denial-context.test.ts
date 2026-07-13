/**
 * `denialContext` fidelity over the worker relay (remote sandbox slice 2;
 * spike gap 6).
 *
 * `serializeError` used to flatten thrown errors to `{ code, message }`,
 * dropping the structured `denialContext` a `SandboxError` carries on
 * `permission-denied` (rule reasons, auth state, the eval-time request
 * shape). It now rides the wire — plain JSON, additive on the error object —
 * and the Node side re-attaches it, so a remote denial matches a local one.
 *
 * Harness: the worker-relay chain (REAL worker host ⇄ bridge core ⇄
 * consumer session ⇄ REAL remote core), with EVERY frame on both legs
 * JSON-round-tripped like remote-storage.test.ts — the two WS legs a real
 * deployment crosses. Covers the op error path (a denied write rejects with
 * `.denialContext`) and the subscription `__error` path (a denied listener's
 * onError carries it too).
 */

import { describe, it, expect } from 'bun:test';
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
import type { DenialContext } from 'pyric/sandbox';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';

const DENY_ALL_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}`;

// ─── Harness (worker-relay.test.ts's, + JSON round-trips on both legs) ─────

async function makeWorkerCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(sandbox.withAuth(null)).setRules(DENY_ALL_RULES);
  return { db: getFirestore(sandbox), sandbox, instanceId: 'denial-ctx-test', subs: new Map() };
}

/** Model a WS leg: the frame must survive JSON serialization VERBATIM. */
function overWire<T>(frame: T): T {
  return JSON.parse(JSON.stringify(frame)) as T;
}

function connectTab(bridge: Bridge, ctx: HostCtx): void {
  let gen = 0;
  const port: PortLike = {
    postMessage(raw: unknown) {
      const m = raw as OutboundMessage;
      if (m.t === 'res') {
        bridge.handleSandboxMessage(
          overWire(
            m.ok
              ? { type: 'worker-res', id: m.id, ok: true, value: m.value }
              : { type: 'worker-res', id: m.id, ok: false, error: m.error },
          ) as BridgeMessage,
          gen,
        );
      } else if (m.t === 'snap') {
        bridge.handleSandboxMessage(
          overWire({ type: 'worker-snap', subId: m.subId, value: m.value }) as BridgeMessage,
          gen,
        );
      }
    },
  };
  const send = (msg: BridgeMessage): void => {
    if (gen === 0) gen = bridge.peerGeneration();
    const wire = overWire(msg);
    if (wire.type === 'worker-op') {
      void handleMessage(ctx, port, { ...wire.op, t: 'op', id: wire.id } as InboundMessage);
    } else if (wire.type === 'worker-sub') {
      void handleMessage(ctx, port, { ...wire.sub, t: 'sub', subId: wire.subId } as InboundMessage);
    } else if (wire.type === 'worker-unsub') {
      void handleMessage(ctx, port, { t: 'unsub', subId: wire.subId } as InboundMessage);
    }
  };
  bridge.registerSandboxPeer(send, [], 'fake-tab', [WORKER_RELAY_CAPABILITY]);
}

function connectNode(bridge: Bridge) {
  let core: RemoteSandboxCore;
  const session = createConsumerSession(bridge, (msg) => core.handleMessage(overWire(msg)));
  core = createRemoteSandboxCore(
    { send: (msg) => session.handleMessage(overWire(msg)) },
    { serveUrl: 'http://localhost:5000' },
  );
  core.start();
  return core;
}

function tick(ms = 10): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

type WireError = Error & { code: string; denialContext?: DenialContext };

// ════════════════════════════════════════════════════════════════════════════

describe('denialContext over the relay (spike gap 6)', () => {
  it('a denied write rejects with the structured denialContext, JSON legs and all', async () => {
    const bridge = createBridge({ version: 'test' });
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);
    const core = connectNode(bridge);

    let caught: WireError | null = null;
    try {
      await core.channel.op({
        method: 'setDoc',
        path: 'notes/n1',
        data: { a: 1 },
        actAs: { mode: 'anon' },
      });
    } catch (e) {
      caught = e as WireError;
    }

    expect(caught).not.toBeNull();
    expect(caught!.code).toBe('permission-denied');
    const dc = caught!.denialContext;
    expect(dc).toBeDefined();
    // The same frame a LOCAL SandboxError carries: simulator reasons + the
    // eval-time request shape (who / what / where).
    expect(Array.isArray(dc!.reasons)).toBe(true);
    expect(dc!.reasons!.length).toBeGreaterThan(0);
    expect(dc!.request?.method).toBe('create');
    expect(dc!.request?.path).toBe('notes/n1');
    expect(dc!.request?.resourceData).toEqual({ a: 1 });
  });

  it('a denied subscription matches LOCAL listener-error fidelity through onError', async () => {
    // NOTE: the sandbox does not populate denialContext on snapshot-LISTENER
    // errors (a local onSnapshot onError lacks it too — only thrown
    // SandboxErrors from ops carry it today). The __error relay path
    // transports the serialized error verbatim, so fidelity here means the
    // remote error equals the local one: same code, same (absent) context.
    // If the sandbox ever stamps listener denials, the wire already carries it.
    const bridge = createBridge({ version: 'test' });
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);
    const core = connectNode(bridge);

    let subErr: WireError | null = null;
    const unsub = core.channel.subscribe(
      { target: { __ref: 'doc', path: 'notes/n1' }, actAs: { mode: 'anon' } },
      () => {},
      (err) => { subErr = err as WireError; },
    );
    await tick(30);
    unsub();

    expect(subErr).not.toBeNull();
    expect(subErr!.code).toBe('permission-denied');
    expect(subErr!.denialContext).toBeUndefined(); // parity with local onError
  });

  it('non-denial errors stay lean — no denialContext field', async () => {
    const bridge = createBridge({ version: 'test' });
    const ctx = await makeWorkerCtx();
    connectTab(bridge, ctx);
    const core = connectNode(bridge);

    let caught: WireError | null = null;
    try {
      await core.channel.op({ method: 'definitely-not-a-method' });
    } catch (e) {
      caught = e as WireError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.denialContext).toBeUndefined();
  });
});

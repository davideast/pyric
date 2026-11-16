/**
 * Lifecycle parity tests for `Query.once()` across `deleteApp(app)` on both
 * in-process and remote worker arms.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { initializeSandbox, type Sandbox } from 'pyric/sandbox';
import { getDatabase as getModularDatabase, sandbox as databaseSandbox } from 'pyric/database';
import { getFirestore } from 'pyric/firestore';
import { createBridge } from '../../../cli/src/bridge/server/bridge.js';
import { createConsumerSession } from '../../../cli/src/bridge/server/peer.js';
import { WORKER_RELAY_CAPABILITY, type BridgeMessage } from '../../../cli/src/bridge/protocol.js';
import {
  createLazyRemoteSandbox,
  createRemoteSandboxCore,
  createRemoteSandboxHandle,
} from '../../../cli/src/remote/index.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../cli/src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../cli/src/serve/worker/protocol.js';
import { deleteApp, getApps, initializeApp, type PyricAdminApp } from '../../src/app/index.js';
import { getDatabase } from '../../src/database/index.js';

const tick = (ms = 25): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const overWire = <T>(frame: T): T => JSON.parse(JSON.stringify(frame)) as T;

let seq = 0;

function makeArm(kind: 'local' | 'remote'): {
  app: PyricAdminApp;
  writerApp: PyricAdminApp;
  countSubs: () => number;
  close: () => void;
} {
  if (kind === 'local') {
    const sandbox = initializeSandbox();
    const app = initializeApp({ sandbox, projectId: 'demo-once' }, `once-local-${++seq}`);
    const writerApp = initializeApp({ sandbox, projectId: 'demo-once' }, `once-local-writer-${++seq}`);
    return { app, writerApp, countSubs: () => 0, close: () => {} };
  }

  const sandbox: Sandbox = initializeSandbox();
  databaseSandbox.setDefaultPolicy(getModularDatabase(sandbox), 'allow');
  const ctx: HostCtx = {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: `once-remote-host-${++seq}`,
    subs: new Map(),
    flushPersistence: async () => {},
  };
  const bridge = createBridge({ mode: 'sandbox', version: 'test' });
  let generation = 0;
  const tab: PortLike = {
    postMessage(raw: unknown) {
      const msg = raw as OutboundMessage;
      if (msg.t === 'res') {
        const reply = msg.ok
          ? { type: 'worker-res', id: msg.id, ok: true, value: msg.value }
          : { type: 'worker-res', id: msg.id, ok: false, error: msg.error };
        bridge.handleSandboxMessage(overWire(reply) as BridgeMessage, generation);
      } else if (msg.t === 'snap') {
        bridge.handleSandboxMessage(
          overWire({ type: 'worker-snap', subId: msg.subId, value: msg.value }) as BridgeMessage,
          generation,
        );
      }
    },
  };
  bridge.registerSandboxPeer((message: BridgeMessage) => {
    if (generation === 0) generation = bridge.peerGeneration();
    const wire = overWire(message);
    if (wire.type === 'worker-op') {
      void handleMessage(ctx, tab, { ...wire.op, t: 'op', id: wire.id } as InboundMessage);
    } else if (wire.type === 'worker-sub') {
      void handleMessage(ctx, tab, { ...wire.sub, t: 'sub', subId: wire.subId } as InboundMessage);
    } else if (wire.type === 'worker-unsub') {
      void handleMessage(ctx, tab, { t: 'unsub', subId: wire.subId } as InboundMessage);
    }
  }, [], 'fake-tab', [WORKER_RELAY_CAPABILITY]);

  const disposers: Array<() => void> = [];
  const openClient = (label: string): PyricAdminApp => {
    let deliver: (message: BridgeMessage) => void = () => {};
    const session = createConsumerSession(bridge, (message) => deliver(overWire(message)));
    const core = createRemoteSandboxCore(
      { send: (message) => session.handleMessage(overWire(message)) },
      { serveUrl: 'http://localhost:5000' },
    );
    deliver = core.handleMessage;
    core.start();
    disposers.push(() => core.dispose('closed'));
    const remote = createRemoteSandboxHandle({
      channel: core.channel,
      serveUrl: 'http://localhost:5000',
      close: () => core.dispose('closed'),
    });
    return initializeApp({ sandbox: remote, projectId: 'demo-once' }, `${label}-${++seq}`);
  };

  const countSubs = (): number => {
    let total = 0;
    for (const perPort of ctx.subs.values()) total += perPort.size;
    return total;
  };

  return {
    app: openClient('once-remote'),
    writerApp: openClient('once-remote-writer'),
    countSubs,
    close: () => {
      for (const dispose of disposers) dispose();
    },
  };
}

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe.each(['local', 'remote'] as const)('pyric-admin/database once() lifecycle tracking (%s)', (kind) => {
  test('deleteApp(app) detaches pending once() listeners for every child event type and prevents post-delete delivery', async () => {
    const { app, writerApp, countSubs, close } = makeArm(kind);
    try {
      const db = getDatabase(app);
      const writerDb = getDatabase(writerApp);
      await writerDb.ref('items').set({ a: { rank: 1 }, b: { rank: 2 } });

      const fired: string[] = [];
      const outcomes: string[] = [];
      const watchPending = (label: string, promise: Promise<unknown>): void => {
        void promise.then(
          () => outcomes.push(`resolved:${label}`),
          (err) => outcomes.push(`rejected:${label}:${String((err as { code?: unknown })?.code ?? err)}`),
        );
      };

      watchPending('child_added', db.ref('emptyItems').once('child_added', () => fired.push('child_added')));
      watchPending('child_changed', db.ref('items').once('child_changed', () => fired.push('child_changed')));
      watchPending('child_removed', db.ref('items').once('child_removed', () => fired.push('child_removed')));
      watchPending(
        'child_moved',
        db.ref('items').orderByChild('rank').once('child_moved', () => fired.push('child_moved')),
      );
      await tick();

      if (kind === 'remote') {
        // Queue a connection barrier so an in-flight value once() is still pending at deleteApp(app).
        db.goOffline();
        db.goOnline();
        watchPending('value_in_flight', db.ref('items').once('value', () => fired.push('value_in_flight')));
      }

      await deleteApp(app);
      await tick();
      expect(countSubs()).toBe(0);

      await writerDb.ref('emptyItems/x').set(1);
      await writerDb.ref('items/a/rank').set(10);
      await writerDb.ref('items/b').remove();
      await tick(60);

      expect(fired).toEqual([]);
      expect(outcomes).toEqual([]);
    } finally {
      close();
    }
  });

  test('normal once() settlement cleans up its subscription before deleteApp(app) without leaks', async () => {
    const { app, writerApp, countSubs, close } = makeArm(kind);
    try {
      const db = getDatabase(app);
      const writerDb = getDatabase(writerApp);
      await writerDb.ref('items').set({ k1: 1 });

      const pendingChange = db.ref('items').once('child_changed');
      await tick();
      await writerDb.ref('items/k1').set(2);
      const snap = await pendingChange;
      expect(snap.key).toBe('k1');
      expect(snap.val()).toBe(2);

      const valSnap = await db.ref('items/k1').once('value');
      expect(valSnap.val()).toBe(2);

      await tick();
      expect(countSubs()).toBe(0);

      const retainedRef = db.ref('items');
      await deleteApp(app);
      await expect(retainedRef.once('value')).rejects.toMatchObject({ code: 'app/app-deleted' });
    } finally {
      close();
    }
  });
});

test('deleteApp(app) cancels pending once() on a lazy remote sandbox leaving zero host subs', async () => {
  const sandbox = initializeSandbox();
  databaseSandbox.setDefaultPolicy(getModularDatabase(sandbox), 'allow');
  const ctx: HostCtx = {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: `once-lazy-host-${++seq}`,
    subs: new Map(),
    flushPersistence: async () => {},
  };
  const bridge = createBridge({ mode: 'sandbox', version: 'test' });
  let generation = 0;
  const tab: PortLike = {
    postMessage(raw: unknown) {
      const msg = raw as OutboundMessage;
      if (msg.t === 'res') {
        const reply = msg.ok
          ? { type: 'worker-res', id: msg.id, ok: true, value: msg.value }
          : { type: 'worker-res', id: msg.id, ok: false, error: msg.error };
        bridge.handleSandboxMessage(overWire(reply) as BridgeMessage, generation);
      } else if (msg.t === 'snap') {
        bridge.handleSandboxMessage(
          overWire({ type: 'worker-snap', subId: msg.subId, value: msg.value }) as BridgeMessage,
          generation,
        );
      }
    },
  };
  bridge.registerSandboxPeer((message: BridgeMessage) => {
    if (generation === 0) generation = bridge.peerGeneration();
    const wire = overWire(message);
    if (wire.type === 'worker-op') {
      void handleMessage(ctx, tab, { ...wire.op, t: 'op', id: wire.id } as InboundMessage);
    } else if (wire.type === 'worker-sub') {
      void handleMessage(ctx, tab, { ...wire.sub, t: 'sub', subId: wire.subId } as InboundMessage);
    } else if (wire.type === 'worker-unsub') {
      void handleMessage(ctx, tab, { t: 'unsub', subId: wire.subId } as InboundMessage);
    }
  }, [], 'fake-tab', [WORKER_RELAY_CAPABILITY]);

  let disposeCore: (() => void) | undefined;
  const lazy = createLazyRemoteSandbox(async () => {
    let deliver: (message: BridgeMessage) => void = () => {};
    const session = createConsumerSession(bridge, (message) => deliver(overWire(message)));
    const core = createRemoteSandboxCore(
      { send: (message) => session.handleMessage(overWire(message)) },
      { serveUrl: 'http://localhost:5000' },
    );
    deliver = core.handleMessage;
    core.start();
    disposeCore = () => core.dispose('closed');
    return createRemoteSandboxHandle({
      channel: core.channel,
      serveUrl: 'http://localhost:5000',
      close: () => core.dispose('closed'),
    });
  });

  try {
    const app = initializeApp({ sandbox: lazy, projectId: 'demo-lazy-once' }, `once-lazy-${++seq}`);
    const db = getDatabase(app);
    await db.ref('items').set({ a: 1 });

    let fired = false;
    void db.ref('items').once('child_changed', () => {
      fired = true;
    });
    await tick();

    await deleteApp(app);
    await tick();

    let hostSubs = 0;
    for (const perPort of ctx.subs.values()) hostSubs += perPort.size;
    expect(hostSubs).toBe(0);

    const writerApp = initializeApp({ sandbox, projectId: 'demo-lazy-once' }, `once-lazy-writer-${++seq}`);
    await getDatabase(writerApp).ref('items/a').set(2);
    await tick(60);
    expect(fired).toBe(false);
  } finally {
    disposeCore?.();
  }
});

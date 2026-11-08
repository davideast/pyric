import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { deleteApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import * as ip from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import { handleMessage, type PortLike } from '../../../src/serve/worker/host.js';
import { setDatabaseRules } from '../../../src/serve/worker/host/rules.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair, sleep } from './integration-support.js';

describe('Cross-plane RTDB child onlyOnce, off(query), and /.info listener parity', () => {
  let restoreSW: () => void;

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSW = () => {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = previous;
    };
  });

  afterEach(() => restoreSW());

  async function setupPlanes(allowAll = true) {
    const ctx = await makeHostCtx();
    setDatabaseRules(ctx, undefined, {
      rules: { '.read': allowAll, '.write': allowAll },
    });
    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port: FakePort;
      addEventListener() {}
      constructor(_url: unknown, _opts: unknown) {
        const { a: clientPort, b: hostPort } = portPair();
        const hostPortLike: PortLike = {
          postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
        };
        hostPort.onmessage = (event) => {
          void handleMessage(ctx, hostPortLike, event.data as InboundMessage);
        };
        this.port = clientPort;
      }
    };
    const served = await import('../../../src/serve/entries/database.js');
    const servedApp = createAppForSandbox(
      ctx.sandbox,
      { projectId: 'rtdb-listener-parity' },
      `rtdb-listener-served-${Math.random()}`,
    );
    const servedDb = served.getDatabase(servedApp);

    const ipSandbox = initializeSandbox();
    const ipDb = ip.getDatabase(ipSandbox.withAuth({ uid: 'user-1' }));
    ip.sandbox.setRules(ipDb, {
      rules: { '.read': allowAll, '.write': allowAll },
    });

    return {
      served,
      servedDb,
      ipDb,
      cleanup: async () => {
        await deleteApp(servedApp);
      },
    };
  }

  it('fires onChildAdded(..., { onlyOnce: true }) on an empty path only once on a subsequent multi-child write', async () => {
    const { served, servedDb, ipDb, cleanup } = await setupPlanes();
    try {
      const ipEmpty = ip.ref(ipDb, 'items/empty');
      const servedEmpty = served.ref(servedDb, 'items/empty');

      const ipAdded: string[] = [];
      const servedAdded: string[] = [];

      ip.onChildAdded(ipEmpty, (snap) => ipAdded.push(`${snap.key}:${snap.val()}`), { onlyOnce: true });
      served.onChildAdded(servedEmpty, (snap) => servedAdded.push(`${snap.key}:${snap.val()}`), { onlyOnce: true });
      await sleep();

      await ip.set(ipEmpty, { alpha: 1, beta: 2, gamma: 3 });
      await served.set(servedEmpty, { alpha: 1, beta: 2, gamma: 3 });
      await sleep();

      expect(ipAdded).toEqual(['alpha:1']);
      expect(servedAdded).toEqual(['alpha:1']);

      // Existing children at subscribe time still deliver the initial batch in reverse key order.
      const ipExisting: string[] = [];
      const servedExisting: string[] = [];
      ip.onChildAdded(ipEmpty, (snap) => ipExisting.push(`${snap.key}:${snap.val()}`), { onlyOnce: true });
      served.onChildAdded(servedEmpty, (snap) => servedExisting.push(`${snap.key}:${snap.val()}`), { onlyOnce: true });
      await sleep();

      expect(ipExisting).toEqual(['gamma:3', 'beta:2', 'alpha:1']);
      expect(servedExisting).toEqual(['gamma:3', 'beta:2', 'alpha:1']);
    } finally {
      await cleanup();
    }
  });

  it('detaches constrained query listeners correctly via off(query(ref, ...)) and off(query(ref)) across planes', async () => {
    const { served, servedDb, ipDb, cleanup } = await setupPlanes();
    try {
      const ipItems = ip.ref(ipDb, 'items');
      const servedItems = served.ref(servedDb, 'items');
      await ip.set(ipItems, { a: 1, b: 2 });
      await served.set(servedItems, { a: 1, b: 2 });

      const ipLimited = ip.query(ipItems, ip.orderByKey(), ip.limitToFirst(1));
      const servedLimited = served.query(servedItems, served.orderByKey(), served.limitToFirst(1));

      const ipLimitedCalls: unknown[] = [];
      const ipDefaultCalls: unknown[] = [];
      const servedLimitedCalls: unknown[] = [];
      const servedDefaultCalls: unknown[] = [];

      ip.onValue(ipLimited, (snap) => ipLimitedCalls.push(snap.val()));
      ip.onValue(ipItems, (snap) => ipDefaultCalls.push(snap.val()));
      served.onValue(servedLimited, (snap) => servedLimitedCalls.push(snap.val()));
      served.onValue(servedItems, (snap) => servedDefaultCalls.push(snap.val()));
      await sleep();

      ipLimitedCalls.length = 0;
      ipDefaultCalls.length = 0;
      servedLimitedCalls.length = 0;
      servedDefaultCalls.length = 0;

      // Detaching a fresh constrained query detaches only that constrained view.
      ip.off(ip.query(ipItems, ip.orderByKey(), ip.limitToFirst(1)));
      served.off(served.query(servedItems, served.orderByKey(), served.limitToFirst(1)));

      await ip.set(ipItems, { a: 10, b: 20 });
      await served.set(servedItems, { a: 10, b: 20 });
      await sleep();

      expect(ipLimitedCalls).toEqual([]);
      expect(servedLimitedCalls).toEqual([]);
      expect(ipDefaultCalls).toEqual([{ a: 10, b: 20 }]);
      expect(servedDefaultCalls).toEqual([{ a: 10, b: 20 }]);

      // Re-attach constrained view, then call off(query(ref)) (unconstrained query) to detach all views on ref.
      ip.onValue(ipLimited, (snap) => ipLimitedCalls.push(snap.val()));
      served.onValue(servedLimited, (snap) => servedLimitedCalls.push(snap.val()));
      await sleep();
      ipLimitedCalls.length = 0;
      ipDefaultCalls.length = 0;
      servedLimitedCalls.length = 0;
      servedDefaultCalls.length = 0;

      ip.off(ip.query(ipItems));
      served.off(served.query(servedItems));

      await ip.set(ipItems, { a: 100, b: 200 });
      await served.set(servedItems, { a: 100, b: 200 });
      await sleep();

      expect(ipLimitedCalls).toEqual([]);
      expect(ipDefaultCalls).toEqual([]);
      expect(servedLimitedCalls).toEqual([]);
      expect(servedDefaultCalls).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  it('aligns /.info child listeners and constrained queries across in-process and served planes', async () => {
    const { served, servedDb, ipDb, cleanup } = await setupPlanes(false);
    try {
      const ipAdded: Array<[string | null, unknown]> = [];
      const ipChanged: Array<[string | null, unknown]> = [];
      const servedAdded: Array<[string | null, unknown]> = [];
      const servedChanged: Array<[string | null, unknown]> = [];

      const unsubIpAdded = ip.onChildAdded(ip.ref(ipDb, '.info'), (s) => ipAdded.push([s.key, s.val()]));
      const unsubIpChanged = ip.onChildChanged(ip.ref(ipDb, '.info'), (s) => ipChanged.push([s.key, s.val()]));
      const unsubServedAdded = served.onChildAdded(served.ref(servedDb, '.info'), (s) =>
        servedAdded.push([s.key, s.val()]),
      );
      const unsubServedChanged = served.onChildChanged(served.ref(servedDb, '.info'), (s) =>
        servedChanged.push([s.key, s.val()]),
      );
      await sleep();

      expect(ipAdded).toEqual([
        ['connected', true],
        ['serverTimeOffset', 0],
      ]);
      expect(servedAdded).toEqual([
        ['connected', true],
        ['serverTimeOffset', 0],
      ]);

      ip.goOffline(ipDb);
      served.goOffline(servedDb);
      await sleep();

      expect(ipChanged).toEqual([['connected', false]]);
      expect(servedChanged).toEqual([['connected', false]]);

      ip.goOnline(ipDb);
      served.goOnline(servedDb);
      await sleep();

      expect(ipChanged).toEqual([
        ['connected', false],
        ['connected', true],
      ]);
      expect(servedChanged).toEqual([
        ['connected', false],
        ['connected', true],
      ]);

      // Constrained query on scalar /.info/connected yields an empty snapshot (null) on both planes.
      const ipConstrainedScalar: unknown[] = [];
      const servedConstrainedScalar: unknown[] = [];
      const unsubIpScalar = ip.onValue(
        ip.query(ip.ref(ipDb, '.info/connected'), ip.limitToFirst(1)),
        (s) => ipConstrainedScalar.push(s.val()),
      );
      const unsubServedScalar = served.onValue(
        served.query(served.ref(servedDb, '.info/connected'), served.limitToFirst(1)),
        (s) => servedConstrainedScalar.push(s.val()),
      );
      await sleep();

      expect(ipConstrainedScalar).toEqual([null]);
      expect(servedConstrainedScalar).toEqual([null]);

      unsubIpAdded();
      unsubIpChanged();
      unsubServedAdded();
      unsubServedChanged();
      unsubIpScalar();
      unsubServedScalar();
    } finally {
      await cleanup();
    }
  });
});

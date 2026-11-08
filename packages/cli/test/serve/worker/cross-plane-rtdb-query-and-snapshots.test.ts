import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { deleteApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import * as ip from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import { handleMessage, type PortLike } from '../../../src/serve/worker/host.js';
import { setDatabaseRules } from '../../../src/serve/worker/host/rules.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair } from './integration-support.js';

describe('Cross-plane RTDB query surface, snapshots, and setData fan-out', () => {
  let restoreSW: () => void;

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSW = () => {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = previous;
    };
  });

  afterEach(() => restoreSW());

  async function setupPlanes() {
    const ctx = await makeHostCtx();
    setDatabaseRules(ctx, undefined, { rules: { '.read': true, '.write': true } });
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
      { projectId: 'rtdb-query-parity' },
      `rtdb-query-served-${Math.random()}`,
    );
    const servedDb = served.getDatabase(servedApp);

    const ipSandbox = initializeSandbox();
    const ipDb = ip.getDatabase(ipSandbox.withAuth({ uid: 'user-1' }));
    ip.sandbox.setDefaultPolicy(ipDb, 'allow');

    return {
      served,
      servedDb,
      ipDb,
      cleanup: async () => {
        await deleteApp(servedApp);
      },
    };
  }

  it('exposes ref.ref on served DatabaseReference and matches unconstrained query.isEqual(ref) symmetrically', async () => {
    const { served, servedDb, ipDb, cleanup } = await setupPlanes();
    try {
      const ipRef = ip.ref(ipDb, 'items/item-1');
      const servedRef = served.ref(servedDb, 'items/item-1');

      expect(ipRef.ref).toBe(ipRef);
      expect(servedRef.ref).toBe(servedRef);

      const ipUnconstrained = ip.query(ipRef);
      const servedUnconstrained = served.query(servedRef);
      expect(ipUnconstrained.isEqual(ipRef)).toBe(true);
      expect(servedUnconstrained.isEqual(servedRef)).toBe(true);
      expect(ipRef.isEqual(ipUnconstrained)).toBe(true);
      expect(servedRef.isEqual(servedUnconstrained)).toBe(true);

      const ipLimited = ip.query(ipRef, ip.limitToFirst(2));
      const servedLimited = served.query(servedRef, served.limitToFirst(2));
      expect(ipLimited.isEqual(ipRef)).toBe(false);
      expect(servedLimited.isEqual(servedRef)).toBe(false);
      expect(ipRef.isEqual(ipLimited)).toBe(false);
      expect(servedRef.isEqual(servedLimited)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('returns the scalar snapshot from get(query(scalarRef)) across both planes', async () => {
    const { served, servedDb, ipDb, cleanup } = await setupPlanes();
    try {
      const ipScalar = ip.ref(ipDb, 'items/count');
      const servedScalar = served.ref(servedDb, 'items/count');
      await ip.set(ipScalar, 42);
      await served.set(servedScalar, 42);

      const ipSnap = await ip.get(ip.query(ipScalar));
      const servedSnap = await served.get(served.query(servedScalar));

      expect(ipSnap.exists()).toBe(true);
      expect(ipSnap.val()).toBe(42);
      expect(servedSnap.exists()).toBe(true);
      expect(servedSnap.val()).toBe(42);
    } finally {
      await cleanup();
    }
  });

  it('guards snap.hasChild and snap.child against Object.prototype and Array.prototype keys', async () => {
    const { served, servedDb, ipDb, cleanup } = await setupPlanes();
    try {
      const ipObjRef = ip.ref(ipDb, 'items/obj');
      const servedObjRef = served.ref(servedDb, 'items/obj');
      const ipArrRef = ip.ref(ipDb, 'items/arr');
      const servedArrRef = served.ref(servedDb, 'items/arr');

      await ip.set(ipObjRef, { alpha: 1 });
      await served.set(servedObjRef, { alpha: 1 });
      await ip.set(ipArrRef, ['x', 'y']);
      await served.set(servedArrRef, ['x', 'y']);

      const ipObjSnap = await ip.get(ipObjRef);
      const servedObjSnap = await served.get(servedObjRef);
      const ipQueryObjSnap = await ip.get(ip.query(ipObjRef, ip.orderByKey(), ip.limitToFirst(1)));
      const ipArrSnap = await ip.get(ipArrRef);
      const servedArrSnap = await served.get(servedArrRef);

      for (const protoKey of ['toString', 'valueOf', 'isPrototypeOf', 'hasOwnProperty']) {
        expect(ipObjSnap.hasChild(protoKey)).toBe(false);
        expect(servedObjSnap.hasChild(protoKey)).toBe(false);
        expect(ipQueryObjSnap.hasChild(protoKey)).toBe(false);
        expect(ipObjSnap.child(protoKey).exists()).toBe(false);
        expect(servedObjSnap.child(protoKey).exists()).toBe(false);
      }

      for (const arrKey of ['length', 'slice', 'toString']) {
        expect(ipArrSnap.hasChild(arrKey)).toBe(false);
        expect(servedArrSnap.hasChild(arrKey)).toBe(false);
        expect(ipArrSnap.child(arrKey).exists()).toBe(false);
        expect(servedArrSnap.child(arrKey).exists()).toBe(false);
      }

      expect(ipObjSnap.hasChild('alpha')).toBe(true);
      expect(servedObjSnap.hasChild('alpha')).toBe(true);
      expect(ipArrSnap.hasChild('0')).toBe(true);
      expect(servedArrSnap.hasChild('0')).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('strips .priority metadata of excluded children in query snapshots across planes', async () => {
    const { served, servedDb, ipDb, cleanup } = await setupPlanes();
    try {
      const ipItems = ip.ref(ipDb, 'items');
      const servedItems = served.ref(servedDb, 'items');

      await ip.setWithPriority(ip.child(ipItems, 'first'), { label: 'one' }, 10);
      await ip.setWithPriority(ip.child(ipItems, 'second'), { label: 'two' }, 20);
      await served.setWithPriority(served.child(servedItems, 'first'), { label: 'one' }, 10);
      await served.setWithPriority(served.child(servedItems, 'second'), { label: 'two' }, 20);

      const ipQuerySnap = await ip.get(ip.query(ipItems, ip.orderByPriority(), ip.limitToFirst(1)));
      const servedQuerySnap = await served.get(served.query(servedItems, served.orderByPriority(), served.limitToFirst(1)));

      expect(ipQuerySnap.child('first').exists()).toBe(true);
      expect(ipQuerySnap.child('first').priority).toBe(10);
      expect(ipQuerySnap.child('second').exists()).toBe(false);
      expect(ipQuerySnap.child('second').priority).toBeNull();
      expect(ipQuerySnap.child('second').exportVal()).toBeNull();

      expect(servedQuerySnap.child('first').exists()).toBe(true);
      expect(servedQuerySnap.child('first').priority).toBe(10);
      expect(servedQuerySnap.child('second').exists()).toBe(false);
      expect(servedQuerySnap.child('second').priority).toBeNull();
      expect(servedQuerySnap.child('second').exportVal()).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('fans out WritePlane.setData mutations to active RTDB value and child listeners', async () => {
    const { ipDb, cleanup } = await setupPlanes();
    try {
      const itemsRef = ip.ref(ipDb, 'items');
      await ip.set(itemsRef, { a: 1 });

      const values: unknown[] = [];
      const added: string[] = [];
      const removed: string[] = [];

      const unsubValue = ip.onValue(itemsRef, (snap) => values.push(snap.val()));
      const unsubAdded = ip.onChildAdded(itemsRef, (snap) => added.push(`${snap.key}:${snap.val()}`));
      const unsubRemoved = ip.onChildRemoved(itemsRef, (snap) => removed.push(`${snap.key}:${snap.val()}`));

      expect(values).toEqual([{ a: 1 }]);
      expect(added).toEqual(['a:1']);
      expect(removed).toEqual([]);

      ip.sandbox.setData(ipDb, { items: { b: 2, c: 3 } });

      expect(values).toEqual([{ a: 1 }, { b: 2, c: 3 }]);
      expect(added).toEqual(['a:1', 'b:2', 'c:3']);
      expect(removed).toEqual(['a:1']);

      unsubValue();
      unsubAdded();
      unsubRemoved();
    } finally {
      await cleanup();
    }
  });
});

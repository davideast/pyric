import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  FieldPath as ModularFieldPath,
  getFirestore as getModularFirestore,
} from 'pyric/firestore';
import { getDatabase as getModularDatabase, sandbox as databaseSandbox } from 'pyric/database';
import {
  getAdminFirestore as getBaseAdminFirestore,
  getFirestore as getLocalBaseFirestore,
} from 'pyric/sandbox/admin-firestore';

import { createBridge, type Bridge } from '../../../cli/src/bridge/server/bridge.js';
import { createConsumerSession } from '../../../cli/src/bridge/server/peer.js';
import {
  WORKER_RELAY_CAPABILITY,
  type BridgeMessage,
} from '../../../cli/src/bridge/protocol.js';
import {
  createRemoteSandboxCore,
  createRemoteSandboxHandle,
  type RemoteSandbox,
} from '../../../cli/src/remote/index.js';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../../cli/src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
} from '../../../cli/src/serve/worker/protocol.js';

import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import {
  FieldPath,
  getAdminFirestore,
} from '../../src/firestore/index.js';

const SERVE_URL = 'http://localhost:5000';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

function overWire<T>(frame: T): T {
  structuredClone(frame);
  return JSON.parse(JSON.stringify(frame)) as T;
}

function makeStack() {
  const bridge: Bridge = createBridge({ mode: 'sandbox', version: 'test' });
  const sandbox = initializeSandbox();
  getLocalBaseFirestore(sandbox.withAuth(null)).setRules(OPEN_RULES);
  databaseSandbox.setDefaultPolicy(getModularDatabase(sandbox), 'allow');
  const ctx: HostCtx = {
    db: getModularFirestore(sandbox),
    sandbox,
    instanceId: 'admin-remote-firestore-parity-test',
    subs: new Map(),
    flushPersistence: async () => {},
  };

  let gen = 0;
  const port: PortLike = {
    postMessage(raw: unknown) {
      const m = raw as OutboundMessage;
      if (m.t === 'res') {
        const reply = m.ok
          ? { type: 'worker-res', id: m.id, ok: true, value: m.value }
          : { type: 'worker-res', id: m.id, ok: false, error: m.error };
        bridge.handleSandboxMessage(overWire(reply) as BridgeMessage, gen);
      } else if (m.t === 'snap') {
        bridge.handleSandboxMessage(
          overWire({ type: 'worker-snap', subId: m.subId, value: m.value }) as BridgeMessage,
          gen,
        );
      }
    },
  };
  bridge.registerSandboxPeer(
    (msg: BridgeMessage) => {
      if (gen === 0) gen = bridge.peerGeneration();
      const wire = overWire(msg);
      if (wire.type === 'worker-op') {
        void handleMessage(ctx, port, { ...wire.op, t: 'op', id: wire.id } as InboundMessage);
      } else if (wire.type === 'worker-sub') {
        void handleMessage(ctx, port, { ...wire.sub, t: 'sub', subId: wire.subId } as InboundMessage);
      } else if (wire.type === 'worker-unsub') {
        void handleMessage(ctx, port, { t: 'unsub', subId: wire.subId } as InboundMessage);
      }
    },
    [],
    'fake-tab',
    [WORKER_RELAY_CAPABILITY],
  );

  let handleMsg: (msg: BridgeMessage) => void = () => {};
  const session = createConsumerSession(bridge, (msg) => handleMsg(overWire(msg)));
  const core = createRemoteSandboxCore(
    { send: (msg) => session.handleMessage(overWire(msg)) },
    { serveUrl: SERVE_URL },
  );
  handleMsg = core.handleMessage;
  core.start();
  const remote: RemoteSandbox = createRemoteSandboxHandle({
    channel: core.channel,
    serveUrl: SERVE_URL,
    close: () => core.dispose('closed'),
  });
  const app = initializeApp({ sandbox: remote });
  return { sandbox, remote, app, db: getAdminFirestore(remote), localDb: getBaseAdminFirestore(sandbox) };
}

describe('pyric-admin remote Firestore: mergeFields FieldPath and QuerySnapshot.docChanges parity', () => {
  it('serializes FieldPath entries (including single-segment literal dots and modular FieldPath) in docRef.set, batch.set, and tx.set mergeFields', async () => {
    const { db } = makeStack();

    await db.doc('items/one').set({
      nested: { a: 1, b: 2, keep: 3 },
      literal: { dot: 'nested-keep' },
      'literal.dot': 'old-literal',
      untouched: 'stay',
    });

    await db.doc('items/one').set(
      {
        nested: { a: 10, b: 20, ignored: 99 },
        'literal.dot': 'new-literal',
        literal: { dot: 'should-not-overwrite' },
        untouched: 'ignored',
      },
      { mergeFields: [new FieldPath('nested', 'a'), new FieldPath('literal.dot'), 'nested.b'] },
    );

    expect((await db.doc('items/one').get()).data()).toEqual({
      nested: { a: 10, b: 20, keep: 3 },
      literal: { dot: 'nested-keep' },
      'literal.dot': 'new-literal',
      untouched: 'stay',
    });

    await db
      .batch()
      .set(
        db.doc('items/one'),
        {
          nested: { a: 100, extra: 999 },
          'batch.dot': 'from-batch',
          batch: { dot: 'ignored' },
        },
        { mergeFields: [new ModularFieldPath('nested', 'a') as unknown as FieldPath, new FieldPath('batch.dot')] },
      )
      .commit();

    expect((await db.doc('items/one').get()).data()).toEqual({
      nested: { a: 100, b: 20, keep: 3 },
      literal: { dot: 'nested-keep' },
      'literal.dot': 'new-literal',
      'batch.dot': 'from-batch',
      untouched: 'stay',
    });

    await db.runTransaction(async (tx) => {
      await tx.get(db.doc('items/one'));
      tx.set(
        db.doc('items/one'),
        { 'tx.dot': 'from-tx', tx: { dot: 'ignored' }, untouched: 'ignored' },
        { mergeFields: [new FieldPath('tx.dot')] },
      );
    });

    expect((await db.doc('items/one').get()).data()).toEqual({
      nested: { a: 100, b: 20, keep: 3 },
      literal: { dot: 'nested-keep' },
      'literal.dot': 'new-literal',
      'batch.dot': 'from-batch',
      'tx.dot': 'from-tx',
      untouched: 'stay',
    });
  });

  it('exposes docChanges() on remote query.get() snapshots and tx.get(query) snapshots', async () => {
    const { db } = makeStack();

    const emptySnap = await db.collection('items').get();
    expect(emptySnap.docChanges()).toEqual([]);

    await db.doc('items/a').set({ rank: 2 });
    await db.doc('items/b').set({ rank: 1 });

    const snap = await db.collection('items').orderBy('rank').get();
    const changes = snap.docChanges();
    expect(changes).toHaveLength(2);
    expect(changes.map((c) => ({
      type: c.type,
      id: c.doc.id,
      oldIndex: c.oldIndex,
      newIndex: c.newIndex,
      data: c.doc.data(),
    }))).toEqual([
      { type: 'added', id: 'b', oldIndex: -1, newIndex: 0, data: { rank: 1 } },
      { type: 'added', id: 'a', oldIndex: -1, newIndex: 1, data: { rank: 2 } },
    ]);

    await db.runTransaction(async (tx) => {
      const txSnap = await tx.get(db.collection('items').orderBy('rank'));
      expect(txSnap.docChanges().map((c) => c.doc.id)).toEqual(['b', 'a']);
    });
  });
});

describe('pyric-admin remote Firestore: cursors, validation, and aggregate FieldPath parity', () => {
  it('resolves nested dotted fields and guards Object.prototype keys in remote snapshot cursors', async () => {
    const { db } = makeStack();

    await db.doc('items/a').set({ meta: { score: 10 } });
    await db.doc('items/b').set({ meta: { score: 20 } });
    await db.doc('items/c').set({ meta: { score: 30 } });

    const snapB = await db.doc('items/b').get();

    const afterB = await db
      .collection('items')
      .orderBy('meta.score')
      .startCursorFromSnapshot(snapB, false)
      .get();
    expect(afterB.docs.map((d) => d.id)).toEqual(['c']);

    const upToB = await db
      .collection('items')
      .orderBy('meta.score')
      .endCursorFromSnapshot(snapB, true)
      .get();
    expect(upToB.docs.map((d) => d.id)).toEqual(['a', 'b']);

    // Object.prototype key ('toString') on a document without own 'toString' must not
    // read Object.prototype.toString and must reject synchronously as missing field.
    let protoErr: unknown;
    try {
      db.collection('items').orderBy('toString').startCursorFromSnapshot(snapB, true);
    } catch (err) {
      protoErr = err;
    }
    expect((protoErr as { code?: string } | undefined)?.code).toBe('invalid-argument');
    expect((protoErr as Error | undefined)?.message).toMatch(/toString/);

    // Own 'toString' data property is accepted and paginates normally.
    await db.doc('ownProto/p1').set({ toString: 'v1' });
    await db.doc('ownProto/p2').set({ toString: 'v2' });
    const snapP1 = await db.doc('ownProto/p1').get();
    const afterP1 = await db
      .collection('ownProto')
      .orderBy('toString')
      .startCursorFromSnapshot(snapP1, false)
      .get();
    expect(afterP1.docs.map((d) => d.id)).toEqual(['p2']);
  });

  it('rejects missing ordered fields synchronously while accepting null field values across local and remote arms', async () => {
    const { db, localDb } = makeStack();

    await db.doc('nullable/missing').set({ label: 'no-score' });
    await db.doc('nullable/nullDoc').set({ score: null });
    await db.doc('nullable/numDoc').set({ score: 10 });

    for (const arm of [
      { name: 'local', client: localDb },
      { name: 'remote', client: db },
    ]) {
      const missingSnap = await arm.client.doc('nullable/missing').get();
      const nullSnap = await arm.client.doc('nullable/nullDoc').get();

      let startErr: unknown;
      try {
        arm.client
          .collection('nullable')
          .orderBy('score')
          .startCursorFromSnapshot(missingSnap, true);
      } catch (err) {
        startErr = err;
      }
      expect((startErr as { code?: string } | undefined)?.code).toBe('invalid-argument');

      let lateOrderErr: unknown;
      try {
        arm.client
          .collection('nullable')
          .orderBy('label')
          .startCursorFromSnapshot(missingSnap, true)
          .orderBy('score');
      } catch (err) {
        lateOrderErr = err;
      }
      expect((lateOrderErr as { code?: string } | undefined)?.code).toBe('invalid-argument');

      const fromNull = await arm.client
        .collection('nullable')
        .orderBy('score')
        .startCursorFromSnapshot(nullSnap, true)
        .get();
      expect(fromNull.docs.map((d) => d.id)).toEqual(['nullDoc', 'numDoc']);
    }
  });

  it('includes inequality .where() and .applyFilter() fields in snapshot cursor normalization across local and remote arms', async () => {
    const { db, localDb } = makeStack();

    await db.doc('ineq/a').set({ tier: 1, score: 10 });
    await db.doc('ineq/b').set({ tier: 1, score: 20 });
    await db.doc('ineq/c').set({ tier: 1, score: 30 });

    for (const arm of [
      { name: 'local', client: localDb },
      { name: 'remote', client: db },
    ]) {
      const snapB = await arm.client.doc('ineq/b').get();

      const lateWhere = await arm.client
        .collection('ineq')
        .orderBy('tier')
        .startCursorFromSnapshot(snapB, false)
        .where('score', '>', 5)
        .get();
      expect(lateWhere.docs.map((d) => d.id)).toEqual(['c']);

      const implicitOrder = await arm.client
        .collection('ineq')
        .where('score', '>', 5)
        .startCursorFromSnapshot(snapB, false)
        .get();
      expect(implicitOrder.docs.map((d) => d.id)).toEqual(['c']);

      const implicitEnd = await arm.client
        .collection('ineq')
        .where('score', '>', 5)
        .endCursorFromSnapshot(snapB, true)
        .get();
      expect(implicitEnd.docs.map((d) => d.id)).toEqual(['a', 'b']);

      const lateApplyFilter = await arm.client
        .collection('ineq')
        .orderBy('tier')
        .startCursorFromSnapshot(snapB, false)
        .applyFilter({
          kind: 'and',
          filters: [{ kind: 'where', field: 'score', op: '>', value: 5 }],
        })
        .get();
      expect(lateApplyFilter.docs.map((d) => d.id)).toEqual(['c']);

      const preApplyFilter = await arm.client
        .collection('ineq')
        .applyFilter({
          kind: 'and',
          filters: [{ kind: 'where', field: 'score', op: '>', value: 5 }],
        })
        .startCursorFromSnapshot(snapB, false)
        .get();
      expect(preApplyFilter.docs.map((d) => d.id)).toEqual(['c']);
    }
  });

  it('recomputes remote snapshot cursors when late .orderBy() and .where() clauses are chained afterward', async () => {
    const { db } = makeStack();

    await db.doc('items/a').set({ group: 'alpha', tier: 1, score: 10 });
    await db.doc('items/b').set({ group: 'alpha', tier: 1, score: 20 });
    await db.doc('items/c').set({ group: 'alpha', tier: 1, score: 30 });
    await db.doc('items/d').set({ group: 'beta', tier: 1, score: 25 });

    const snapB = await db.doc('items/b').get();

    const afterB = await db
      .collection('items')
      .orderBy('tier')
      .startCursorFromSnapshot(snapB, false)
      .orderBy('score')
      .where('group', '==', 'alpha')
      .get();
    expect(afterB.docs.map((d) => d.id)).toEqual(['c']);

    const upToB = await db
      .collection('items')
      .orderBy('tier')
      .endCursorFromSnapshot(snapB, true)
      .orderBy('score')
      .where('group', '==', 'alpha')
      .get();
    expect(upToB.docs.map((d) => d.id)).toEqual(['a', 'b']);

    expect(() =>
      db
        .collection('items')
        .orderBy('tier')
        .startCursorFromSnapshot(snapB, false)
        .orderBy('__name__'),
    ).toThrow(/__name__/);
  });

  it('validates orderBy, limit, limitToLast, and col.doc(sub) arguments synchronously', () => {
    const { db } = makeStack();

    expect(() => db.collection('items').orderBy('rank', 'up' as never)).toThrow(/asc|desc/i);
    expect(() => db.collection('items').orderBy('')).toThrow(/field path/i);
    expect(() => db.collection('items').orderBy('a..b')).toThrow(/field path/i);

    expect(() => db.collection('items').limit(0)).toThrow(/limit/i);
    expect(() => db.collection('items').limit(-1)).toThrow(/limit/i);
    expect(() => db.collection('items').limit(1.5)).toThrow(/limit/i);
    expect(() => db.collection('items').limit(Number.NaN)).toThrow(/limit/i);
    expect(() => db.collection('items').limit(Number.POSITIVE_INFINITY)).toThrow(/limit/i);
    expect(() => db.collection('items').limitToLast(0)).toThrow(/limit/i);
    expect(() => db.collection('items').limitToLast(-2)).toThrow(/limit/i);
    expect(() => db.collection('items').limitToLast(Number.NaN)).toThrow(/limit/i);

    expect(() => db.collection('items').doc('')).toThrow(/even|document|non-empty/i);
    expect(() => db.collection('items').doc('///')).toThrow(/even|document|non-empty/i);
    expect(() => db.collection('items').doc('a/b')).toThrow(/even/i);
    expect(() => db.collection('items').doc('a//b/c')).toThrow(/even|document|non-empty/i);

    const nestedDoc = db.collection('items').doc('a/b/c');
    expect(nestedDoc.path).toBe('items/a/b/c');
    expect(nestedDoc.id).toBe('c');
  });

  it('normalizes FieldPath entries (including single-segment literal dots) in remote query.aggregate(spec)', async () => {
    const { db } = makeStack();

    await db.doc('items/one').set({
      metrics: { points: 10, literal: 999 },
      'metrics.literal': 4,
    });
    await db.doc('items/two').set({
      metrics: { points: 30, literal: 888 },
      'metrics.literal': 6,
    });

    const agg = await db.collection('items').aggregate({
      n: { kind: 'count' },
      nestedSum: { kind: 'sum', field: new FieldPath('metrics', 'points') },
      literalSum: { kind: 'sum', field: new FieldPath('metrics.literal') },
      modularAvg: {
        kind: 'average',
        field: new ModularFieldPath('metrics', 'points') as unknown as FieldPath,
      },
    });

    expect(agg.data()).toEqual({
      n: 2,
      nestedSum: 40,
      literalSum: 10,
      modularAvg: 20,
    });
  });
});

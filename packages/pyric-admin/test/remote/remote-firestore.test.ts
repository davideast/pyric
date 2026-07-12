/**
 * `pyric-admin` remote-dispatch arm — Firestore (remote sandbox, slice 2 /
 * checkpoint 2: the channel-backed admin arm).
 *
 * Same headless harness as remote-storage.test.ts: the REAL worker host
 * (`handleMessage` + fake ports) behind the REAL bridge core + consumer
 * session, fronted by the EXACT production handle from
 * `createRemoteSandboxHandle` — and EVERY frame on BOTH relay legs is
 * round-tripped through `JSON.parse(JSON.stringify(frame))`, modelling the
 * two WS legs. That JSON leg is load-bearing here: it is what flattens
 * Timestamps to marker maps (the write-fidelity seam) and what would
 * corrupt a transaction read-set if the arm re-serialized rehydrated data
 * (the phantom-abort seam).
 *
 * Coverage (per the checkpoint-2 spec + the spike's test plan):
 *   - dispatch selection: remote-branded ctx → channel arm; plain sandbox →
 *     local arm; the pyric-admin wrapper's no-arg `getFirestore()`
 *     default-app resolution on the remote arm (the deleted guard)
 *   - CRUD round-trips with Timestamp / FieldValue fidelity — stored as
 *     REAL typed values, proven via an independent direct worker port
 *   - composite (or/and) filters, orderBy + cursors (incl. Timestamp
 *     cursor values and snapshot cursors), limit/limitToLast,
 *     collectionGroup
 *   - aggregates (count / sum / average, empty-input average → null)
 *   - WriteBatch atomicity
 *   - transactions: success, contention retry, retry exhaustion, and the
 *     phantom-abort guard (a read-set doc carrying a Timestamp must NOT
 *     abort spuriously)
 *   - onSnapshot: doc + query, initial + update + unsub, cross-visibility
 *     with browser-side writes, denial → onError with the same shape as
 *     the local arm
 *   - identity matrix: admin bypasses deny rules; anon vs as-uid (incl.
 *     custom-claims token fidelity) distinguished by rules; a signed-in
 *     PORT session must NOT leak into a `withAuth(null)` handle
 *   - error fidelity: denied ops throw `SandboxError` with `denialContext`
 *   - remediating throws on the sync-only sandbox extras
 *     (`setRules` / `seed` / `snapshot`)
 *   - conformance: the same consumer assertions pass on BOTH arms
 */

import { afterEach, describe, it, expect } from 'bun:test';
import { initializeSandbox, SandboxError } from 'pyric/sandbox';
import { getFirestore as getModularFirestore } from 'pyric/firestore';
import {
  getFirestore as getLocalBaseFirestore,
  getAdminFirestore as getBaseAdminFirestore,
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

import { initializeApp, deleteApp, getApps } from '../../src/app/index.js';
import {
  getFirestore,
  getAdminFirestore,
  onSnapshot,
  FieldValue,
  Timestamp,
  type SandboxFirestore,
} from '../../src/firestore/index.js';

// ─── Harness (remote-storage.test.ts's — JSON round-trips on both legs) ────

const SERVE_URL = 'http://localhost:5000';

/** Wide-open rules — the baseline every stack deploys so rules-applied
 *  lenses (as-uid / anon) have something to evaluate. */
const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

/** The identity matrix: per-collection gates that tell admin, anon,
 *  a specific uid, and a claims-carrying token apart. */
const MATRIX_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /open/{id} { allow read, write: if true; }
    match /authed/{id} { allow read, write: if request.auth != null; }
    match /alice/{id} { allow read, write: if request.auth != null && request.auth.uid == 'alice'; }
    match /admins/{id} { allow read, write: if request.auth != null && request.auth.token.admin == true; }
    match /locked/{id} { allow read, write: if false; }
  }
}`;

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

/** Model a WS leg: the frame must survive JSON serialization VERBATIM. */
function overWire<T>(frame: T): T {
  return JSON.parse(JSON.stringify(frame)) as T;
}

function makeWorkerCtx(opts: { rules?: string } = {}): HostCtx {
  const sandbox = initializeSandbox();
  // Deploy the worker's active ruleset the way a served page would —
  // synchronously through the LOCAL arm on the worker's own sandbox.
  getLocalBaseFirestore(sandbox.withAuth(null)).setRules(opts.rules ?? OPEN_RULES);
  return {
    db: getModularFirestore(sandbox),
    sandbox,
    instanceId: 'admin-remote-firestore-test',
    subs: new Map(),
  };
}

function tick(ms = 10): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Fake browser tab backed by the REAL worker host; frames cross this leg
 *  through a JSON round-trip in BOTH directions (the bridge⇄tab WS). */
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

/** The EXACT production remote handle, with the Node⇄bridge leg JSON
 *  round-tripped in both directions. */
function connectRemote(bridge: Bridge): RemoteSandbox {
  let handleMsg: (msg: BridgeMessage) => void = () => {};
  const session = createConsumerSession(bridge, (msg) => handleMsg(overWire(msg)));
  const core = createRemoteSandboxCore(
    { send: (msg) => session.handleMessage(overWire(msg)) },
    { serveUrl: SERVE_URL },
  );
  handleMsg = core.handleMessage;
  core.start();
  return createRemoteSandboxHandle({
    channel: core.channel,
    serveUrl: SERVE_URL,
    close: () => core.dispose('remote sandbox connection closed by the client'),
  });
}

/** Independent direct worker port — the oracle proving remote-arm ops
 *  really landed in the worker's sandbox (and letting "the browser app"
 *  write from its side, e.g. to force a transaction conflict). */
let directOpSeq = 0;
function workerOp(ctx: HostCtx, op: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const port: PortLike = {
      postMessage(raw: unknown) {
        const m = raw as OutboundMessage;
        if (m.t !== 'res') return;
        if (m.ok) resolve(m.value);
        else reject(Object.assign(new Error(m.error.message), { code: m.error.code }));
      },
    };
    void handleMessage(ctx, port, {
      ...op,
      t: 'op',
      id: `direct-${++directOpSeq}`,
    } as InboundMessage);
  });
}

/** Read a doc's RAW serialized form straight off the worker (admin lens).
 *  The `json` string is the storage-fidelity oracle: a REAL stored
 *  Timestamp serializes to the rules marker (`"__type":"timestamp"`); a
 *  plain map smuggled in by an unrehydrated write would re-emit whatever
 *  marker family the client sent. */
async function workerGetDocRaw(
  ctx: HostCtx,
  path: string,
): Promise<{ exists: boolean; json?: string }> {
  const wire = (await workerOp(ctx, {
    method: 'getDoc',
    path,
    actAs: { mode: 'admin' },
  })) as { exists: boolean; data?: { json: string } };
  return { exists: wire.exists, json: wire.data?.json };
}

function makeStack(opts: { rules?: string } = {}) {
  const bridge = createBridge({ mode: 'sandbox', version: 'test' });
  const ctx = makeWorkerCtx(opts);
  connectTab(bridge, ctx);
  const remote = connectRemote(bridge);
  const app = initializeApp({ sandbox: remote });
  return { bridge, ctx, remote, app };
}

type WireError = Error & { code?: string; denialContext?: unknown };

// ─── Dispatch selection ─────────────────────────────────────────────────────

describe('pyric-admin remote Firestore — arm selection', () => {
  it('routes a remote-branded context to the channel arm (writes land in the worker)', async () => {
    const { ctx, remote } = makeStack();
    const db = getAdminFirestore(remote);
    await db.doc('dispatch/probe').set({ via: 'remote-arm' });
    const raw = await workerGetDocRaw(ctx, 'dispatch/probe');
    expect(raw.exists).toBe(true);
    expect(JSON.parse(raw.json!)).toEqual({ via: 'remote-arm' });
  });

  it('still routes a plain in-process sandbox to the local arm', async () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox.withAuth(null));
    // Local-arm signature: the sync sandbox extras WORK there.
    db.setRules(OPEN_RULES);
    db.seed({ documents: { 'local/probe': { via: 'local-arm' } } });
    expect((await db.doc('local/probe').get()).data()).toEqual({ via: 'local-arm' });
    expect(db.snapshot()['local/probe']).toEqual({ via: 'local-arm' });
  });

  it("the wrapper's no-arg getFirestore() resolves the default app onto the remote arm", async () => {
    const { ctx } = makeStack();
    // No guard anymore: app-based resolution flows into the remote-aware
    // base getFirestore. The default-app ctx is withAuth(null) → the anon
    // lens; OPEN_RULES allow it, and the write must land in the worker.
    const db = getFirestore();
    await db.doc('ambient/probe').set({ via: 'wrapper-default-app' });
    const raw = await workerGetDocRaw(ctx, 'ambient/probe');
    expect(JSON.parse(raw.json!)).toEqual({ via: 'wrapper-default-app' });
  });

  it('handles are idempotent per context / per handle kind', () => {
    const { remote } = makeStack();
    const ctx = remote.withAuth({ uid: 'alice' });
    expect(getFirestore(ctx)).toBe(getFirestore(ctx));
    // ctx-form admin handles share the per-context cache. (The bare-
    // sandbox form normalizes to a FRESH withAuth(null) context per call
    // — same non-caching behavior as the local arm, so not asserted.)
    expect(getAdminFirestore(ctx)).toBe(getAdminFirestore(ctx));
    expect(getFirestore(ctx)).not.toBe(getAdminFirestore(ctx));
  });
});

// ─── CRUD + value fidelity ─────────────────────────────────────────────────

describe('pyric-admin remote Firestore — CRUD + typed-value fidelity', () => {
  it('set / get / update / delete round-trip through the worker', async () => {
    const { ctx, remote } = makeStack();
    const db = getAdminFirestore(remote);

    await db.doc('rooms/lobby').set({ name: 'Lobby', open: true });
    const snap = await db.doc('rooms/lobby').get();
    expect(snap.exists).toBe(true);
    expect(snap.id).toBe('lobby');
    expect(snap.data()).toEqual({ name: 'Lobby', open: true });

    await db.doc('rooms/lobby').update({ open: false, topic: 'welcome' });
    expect(JSON.parse((await workerGetDocRaw(ctx, 'rooms/lobby')).json!)).toEqual({
      name: 'Lobby',
      open: false,
      topic: 'welcome',
    });

    await db.doc('rooms/lobby').delete();
    const gone = await db.doc('rooms/lobby').get();
    expect(gone.exists).toBe(false);
    expect(gone.data()).toBeUndefined();
  });

  it('set with merge / mergeFields preserves untouched fields', async () => {
    const { remote } = makeStack();
    const db = getAdminFirestore(remote);
    await db.doc('m/x').set({ a: 1, b: 2 });
    await db.doc('m/x').set({ b: 3 }, { merge: true });
    expect((await db.doc('m/x').get()).data()).toEqual({ a: 1, b: 3 });
    await db.doc('m/x').set({ a: 9, c: 4 }, { mergeFields: ['c'] });
    expect((await db.doc('m/x').get()).data()).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('collection().add() mints the id in the worker and returns a live ref', async () => {
    const { ctx, remote } = makeStack();
    const db = getAdminFirestore(remote);
    const ref = await db.collection('messages').add({ text: 'hi' });
    expect(ref.id.length).toBeGreaterThan(0);
    expect(ref.path).toBe(`messages/${ref.id}`);
    expect(JSON.parse((await workerGetDocRaw(ctx, ref.path)).json!)).toEqual({ text: 'hi' });
    // doc() with no id mints CLIENT-side (parity with the local arm).
    const minted = db.collection('messages').doc();
    expect(minted.id).toHaveLength(20);
  });

  it('Timestamps and Dates are STORED as real typed values, not marker maps', async () => {
    const { ctx, remote } = makeStack();
    const db = getAdminFirestore(remote);
    const ts = new Timestamp(1_700_000_000, 250_000_000);

    await db.doc('typed/t1').set({ ts, when: new Date(1_600_000_000_000), tag: 'x' });

    // Oracle: the worker sandbox's IN-PROCESS admin read of the STORED
    // value. A real stored Timestamp is a class instance with value
    // methods; if the relayed write had stored the wire marker as a plain
    // map, `toMillis` would be missing and the marker keys would show.
    const stored = ctx.sandbox.admin.getDocument('typed/t1') as Record<string, unknown>;
    const storedTs = stored.ts as { toMillis?: () => number; type?: unknown; __type?: unknown };
    expect(typeof storedTs.toMillis).toBe('function');
    expect(storedTs.toMillis!()).toBe(ts.toMillis());
    expect(storedTs.type).toBeUndefined();
    expect(storedTs.__type).toBeUndefined();

    // Read-path fidelity: real admin-compat Timestamp instances.
    const back = (await db.doc('typed/t1').get()).data()!;
    expect(back.ts).toBeInstanceOf(Timestamp);
    expect((back.ts as Timestamp).seconds).toBe(1_700_000_000);
    expect((back.ts as Timestamp).nanoseconds).toBe(250_000_000);
    expect(back.when).toBeInstanceOf(Timestamp);
    expect((back.when as Timestamp).toMillis()).toBe(1_600_000_000_000);
  });

  it('FieldValue sentinels resolve in the WORKER (serverTimestamp / increment / arrays / delete)', async () => {
    const { ctx, remote } = makeStack();
    const db = getAdminFirestore(remote);

    await db.doc('sentinels/s1').set({
      created: FieldValue.serverTimestamp(),
      count: 1,
      tags: ['a'],
    });
    await db.doc('sentinels/s1').update({
      count: FieldValue.increment(4),
      tags: FieldValue.arrayUnion('b', 'c'),
    });
    await db.doc('sentinels/s1').update({ tags: FieldValue.arrayRemove('a') });

    const back = (await db.doc('sentinels/s1').get()).data()!;
    expect(back.created).toBeInstanceOf(Timestamp); // resolved against the worker's clock
    expect(back.count).toBe(5);
    expect(back.tags).toEqual(['b', 'c']);

    // The stored form is a REAL timestamp (no `__sentinel` residue) —
    // in-process admin read of the worker sandbox's stored value.
    const stored = ctx.sandbox.admin.getDocument('sentinels/s1') as Record<string, unknown>;
    const storedCreated = stored.created as { toMillis?: () => number; __sentinel?: unknown };
    expect(typeof storedCreated.toMillis).toBe('function');
    expect(storedCreated.__sentinel).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain('__sentinel');

    await db.doc('sentinels/s1').update({ count: FieldValue.delete() });
    expect((await db.doc('sentinels/s1').get()).data()!.count).toBeUndefined();
  });
});

// ─── Queries ────────────────────────────────────────────────────────────────

async function seedScores(db: SandboxFirestore): Promise<void> {
  await db.doc('scores/a').set({ player: 'ada', points: 10, team: 'red' });
  await db.doc('scores/b').set({ player: 'bob', points: 30, team: 'blue' });
  await db.doc('scores/c').set({ player: 'cyd', points: 20, team: 'red' });
  await db.doc('scores/d').set({ player: 'dee', points: 40, team: 'blue' });
}

describe('pyric-admin remote Firestore — queries', () => {
  it('where + orderBy + limit / limitToLast', async () => {
    const { remote } = makeStack();
    const db = getAdminFirestore(remote);
    await seedScores(db);

    const red = await db.collection('scores').where('team', '==', 'red').orderBy('points').get();
    expect(red.docs.map((d) => d.id)).toEqual(['a', 'c']);

    const top2 = await db.collection('scores').orderBy('points', 'desc').limit(2).get();
    expect(top2.docs.map((d) => d.data().player)).toEqual(['dee', 'bob']);

    const last2 = await db.collection('scores').orderBy('points').limitToLast(2).get();
    expect(last2.docs.map((d) => d.data().points)).toEqual([30, 40]);

    // limitToLast without orderBy fails at the call site, like the local arm.
    expect(db.collection('scores').limitToLast(2).get()).rejects.toThrow(/orderBy/);
  });

  it('composite or() / and() filters cross the wire', async () => {
    const { remote } = makeStack();
    const db = getAdminFirestore(remote);
    await seedScores(db);

    const orQuery = await db
      .collection('scores')
      .applyFilter({
        kind: 'or',
        filters: [
          { kind: 'where', field: 'player', op: '==', value: 'ada' },
          {
            kind: 'and',
            filters: [
              { kind: 'where', field: 'team', op: '==', value: 'blue' },
              { kind: 'where', field: 'points', op: '>', value: 30 },
            ],
          },
        ],
      })
      .orderBy('points')
      .get();
    expect(orQuery.docs.map((d) => d.id)).toEqual(['a', 'd']);
  });

  it('value cursors and snapshot cursors (incl. Timestamp cursor values)', async () => {
    const { remote } = makeStack();
    const db = getAdminFirestore(remote);
    await seedScores(db);

    const after20 = await db.collection('scores').orderBy('points').startCursor([20], false).get();
    expect(after20.docs.map((d) => d.data().points)).toEqual([30, 40]);

    const upTo30 = await db.collection('scores').orderBy('points').endCursor([30], true).get();
    expect(upTo30.docs.map((d) => d.data().points)).toEqual([10, 20, 30]);

    // Snapshot cursor: page 2 starts after the last doc of page 1.
    const page1 = await db.collection('scores').orderBy('points').limit(2).get();
    const page2 = await db
      .collection('scores')
      .orderBy('points')
      .startCursorFromSnapshot(page1.docs[page1.docs.length - 1]!, false)
      .get();
    expect(page2.docs.map((d) => d.data().points)).toEqual([30, 40]);

    // Timestamp-valued orderBy + cursor: stored-as-real-types is what
    // makes this ordering correct (and the host rehydrates cursor values).
    await db.doc('events/e1').set({ at: new Timestamp(100, 0) });
    await db.doc('events/e2').set({ at: new Timestamp(200, 0) });
    await db.doc('events/e3').set({ at: new Timestamp(300, 0) });
    const lateEvents = await db
      .collection('events')
      .orderBy('at')
      .startCursor([new Timestamp(150, 0)], true)
      .get();
    expect(lateEvents.docs.map((d) => d.id)).toEqual(['e2', 'e3']);
    const beforeTs = await db.collection('events').where('at', '<', new Timestamp(250, 0)).get();
    expect(beforeTs.docs.map((d) => d.id).sort()).toEqual(['e1', 'e2']);
  });

  it("snapshot cursors: orderBy('__name__') and zero-orderBy throw honestly; value-tie boundary is deterministic", async () => {
    const { remote } = makeStack();
    const db = getAdminFirestore(remote);
    // Tie group on v: b and c share v=2.
    await db.doc('ties/a').set({ v: 1 });
    await db.doc('ties/b').set({ v: 2 });
    await db.doc('ties/c').set({ v: 2 });
    await db.doc('ties/d').set({ v: 3 });
    const snapB = await db.doc('ties/b').get();

    // The wire has no document-key cursor: both unsupported shapes THROW
    // at the call site instead of silently returning wrong pages.
    expect(() =>
      db.collection('ties').orderBy('__name__').startCursorFromSnapshot(snapB, false),
    ).toThrow(/__name__/);
    expect(() => db.collection('ties').startCursorFromSnapshot(snapB, false)).toThrow(
      /orderBy/,
    );

    // DOCUMENTED TIE-BREAK DIVERGENCE (remote.ts cursorValuesFromSnapshot):
    // without the implicit __name__ tie-break the boundary is the VALUE, so
    // startAfter(snapOfB) deterministically skips the WHOLE v=2 tie group
    // (the local arm would keep 'c'). Break ties with a second orderBy field.
    const afterB = await db
      .collection('ties')
      .orderBy('v')
      .startCursorFromSnapshot(snapB, false)
      .get();
    expect(afterB.docs.map((d) => d.id)).toEqual(['d']);
    // …and repeatably so.
    const again = await db
      .collection('ties')
      .orderBy('v')
      .startCursorFromSnapshot(snapB, false)
      .get();
    expect(again.docs.map((d) => d.id)).toEqual(['d']);
  });

  it('collectionGroup queries scan across parents', async () => {
    const { remote } = makeStack();
    const db = getAdminFirestore(remote);
    await db.doc('teams/red/members/m1').set({ name: 'ada' });
    await db.doc('teams/blue/members/m2').set({ name: 'bob' });
    const members = await db.collectionGroup('members').orderBy('name').get();
    expect(members.docs.map((d) => d.data().name)).toEqual(['ada', 'bob']);
    expect(members.docs.map((d) => d.ref.path).sort()).toEqual([
      'teams/blue/members/m2',
      'teams/red/members/m1',
    ]);
  });

  it('aggregates: count / sum / average (empty-input average → null)', async () => {
    const { remote } = makeStack();
    const db = getAdminFirestore(remote);
    await seedScores(db);

    const agg = await db
      .collection('scores')
      .aggregate({ n: { kind: 'count' }, total: { kind: 'sum', field: 'points' }, avg: { kind: 'average', field: 'points' } });
    expect(agg.data()).toEqual({ n: 4, total: 100, avg: 25 });

    const filtered = await db
      .collection('scores')
      .where('team', '==', 'red')
      .aggregate({ n: { kind: 'count' }, avg: { kind: 'average', field: 'points' } });
    expect(filtered.data()).toEqual({ n: 2, avg: 15 });

    const empty = await db
      .collection('scores')
      .where('team', '==', 'green')
      .aggregate({ n: { kind: 'count' }, avg: { kind: 'average', field: 'points' } });
    expect(empty.data()).toEqual({ n: 0, avg: null });
  });
});

// ─── Batch + transactions ──────────────────────────────────────────────────

describe('pyric-admin remote Firestore — batch + transactions', () => {
  it('batch commit applies all writes as one unit', async () => {
    const { remote } = makeStack();
    const db = getAdminFirestore(remote);
    await db.doc('b/keep').set({ v: 1 });
    await db.doc('b/gone').set({ v: 1 });

    await db
      .batch()
      .set(db.doc('b/new'), { v: 2, at: new Timestamp(50, 0) })
      .update(db.doc('b/keep'), { v: FieldValue.increment(1) })
      .delete(db.doc('b/gone'))
      .commit();

    expect((await db.doc('b/new').get()).data()!.v).toBe(2);
    expect((await db.doc('b/new').get()).data()!.at).toBeInstanceOf(Timestamp);
    expect((await db.doc('b/keep').get()).data()!.v).toBe(2);
    expect((await db.doc('b/gone').get()).exists).toBe(false);
  });

  it('a failing batch write applies NOTHING (atomicity)', async () => {
    const { remote } = makeStack();
    const db = getAdminFirestore(remote);
    // update() on a missing doc fails the whole batch.
    const batch = db
      .batch()
      .set(db.doc('atomic/one'), { v: 1 })
      .update(db.doc('atomic/missing'), { v: 2 });
    let caught: WireError | undefined;
    try {
      await batch.commit();
    } catch (e) {
      caught = e as WireError;
    }
    expect(caught).toBeDefined();
    expect((await db.doc('atomic/one').get()).exists).toBe(false);
  });

  it('transaction success: read → conditional write commits once', async () => {
    const { remote } = makeStack();
    const db = getAdminFirestore(remote);
    await db.doc('txn/counter').set({ n: 1 });

    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(db.doc('txn/counter'));
      const n = (snap.data()!.n as number) + 1;
      tx.set(db.doc('txn/counter'), { n });
      return n;
    });
    expect(result).toBe(2);
    expect((await db.doc('txn/counter').get()).data()).toEqual({ n: 2 });
  });

  it('contention: a concurrent browser-side write aborts attempt 1, retry succeeds', async () => {
    const { ctx, remote } = makeStack();
    const db = getAdminFirestore(remote);
    await db.doc('txn/hot').set({ n: 10 });

    let attempts = 0;
    const result = await db.runTransaction(async (tx) => {
      attempts++;
      const snap = await tx.get(db.doc('txn/hot'));
      if (attempts === 1) {
        // "Another tab" writes between our read and our commit.
        await workerOp(ctx, {
          method: 'setDoc',
          path: 'txn/hot',
          data: { n: 100 },
          actAs: { mode: 'admin' },
        });
      }
      const n = (snap.data()!.n as number) + 1;
      tx.set(db.doc('txn/hot'), { n });
      return n;
    });

    expect(attempts).toBe(2);
    expect(result).toBe(101); // computed from the FRESH read, not the stale one
    expect((await db.doc('txn/hot').get()).data()).toEqual({ n: 101 });
  });

  it('retry exhaustion: persistent conflicts surface code `aborted` after 5 attempts', async () => {
    const { ctx, remote } = makeStack();
    const db = getAdminFirestore(remote);
    await db.doc('txn/livelock').set({ n: 0 });

    let attempts = 0;
    let caught: WireError | undefined;
    try {
      await db.runTransaction(async (tx) => {
        attempts++;
        await tx.get(db.doc('txn/livelock'));
        // Interfere EVERY attempt.
        await workerOp(ctx, {
          method: 'setDoc',
          path: 'txn/livelock',
          data: { n: attempts * 1000 },
          actAs: { mode: 'admin' },
        });
        tx.update(db.doc('txn/livelock'), { n: -1 });
      });
    } catch (e) {
      caught = e as WireError;
    }
    expect(attempts).toBe(5);
    expect(caught).toBeInstanceOf(SandboxError);
    expect(caught!.code).toBe('aborted');
  });

  it('PHANTOM-ABORT GUARD: a read-set doc carrying a Timestamp commits on attempt 1', async () => {
    const { remote } = makeStack();
    const db = getAdminFirestore(remote);
    // Typed values + nested containers: exactly the data whose
    // re-serialization on the Node side would drift from the worker's
    // original JSON (marker family, key order) and phantom-abort. The arm
    // must echo the worker's ORIGINAL json strings back verbatim.
    await db.doc('txn/typed').set({
      at: new Timestamp(1_700_000_000, 123_456_000),
      nested: { z: 1, a: [new Timestamp(5, 0), 'x'] },
      created: FieldValue.serverTimestamp(),
    });

    let attempts = 0;
    await db.runTransaction(async (tx) => {
      attempts++;
      const snap = await tx.get(db.doc('txn/typed'));
      expect(snap.data()!.at).toBeInstanceOf(Timestamp);
      tx.set(db.doc('txn/other'), { seen: true }); // no write to the read doc
    });
    expect(attempts).toBe(1);
    expect((await db.doc('txn/other').get()).data()).toEqual({ seen: true });
  });

  it('tx.get(query) registers every returned doc in the read-set', async () => {
    const { ctx, remote } = makeStack();
    const db = getAdminFirestore(remote);
    await seedScores(db);

    let attempts = 0;
    await db.runTransaction(async (tx) => {
      attempts++;
      const reds = await tx.get(db.collection('scores').where('team', '==', 'red'));
      if (attempts === 1) {
        // Concurrent write to a doc the QUERY read → must abort + retry.
        await workerOp(ctx, {
          method: 'setDoc',
          path: 'scores/a',
          data: { player: 'ada', points: 11, team: 'red' },
          actAs: { mode: 'admin' },
        });
      }
      tx.set(db.doc('scores/summary-red'), { count: reds.size });
    });
    expect(attempts).toBe(2);
  });

  it('canonicalization is exact-shape: a marker-lookalike map with an extra key still detects concurrent writes', async () => {
    const { ctx, remote } = makeStack();
    const db = getAdminFirestore(remote);
    // Plain user data that RESEMBLES a prototype-stripped Timestamp clone
    // but carries an extra key. A loose canonicalizer would drop `extra`
    // and treat the concurrent write below as a no-op (false equality —
    // a silently lost conflict). Exact key-set matching must abort.
    await db.doc('canon/x').set({
      fake: { typeName: 'timestamp', seconds: 1, nanos: 2, extra: 3 },
    });

    let attempts = 0;
    await db.runTransaction(async (tx) => {
      attempts++;
      await tx.get(db.doc('canon/x'));
      if (attempts === 1) {
        // Concurrent write differing ONLY by removing the extra key.
        await workerOp(ctx, {
          method: 'setDoc',
          path: 'canon/x',
          data: { fake: { typeName: 'timestamp', seconds: 1, nanos: 2 } },
          actAs: { mode: 'admin' },
        });
      }
      tx.update(db.doc('canon/x'), { touched: true });
    });
    expect(attempts).toBe(2); // the removal MUST abort attempt 1
    const final = (await db.doc('canon/x').get()).data()!;
    expect(final.touched).toBe(true);
  });
});

// ─── onSnapshot ────────────────────────────────────────────────────────────

describe('pyric-admin remote Firestore — onSnapshot', () => {
  it('doc listener: initial + updates (incl. browser-side writes) + unsubscribe', async () => {
    const { ctx, remote } = makeStack();
    const db = getAdminFirestore(remote);
    await db.doc('live/doc').set({ v: 1 });

    const fires: Array<{ exists: boolean; v?: unknown }> = [];
    const unsub = onSnapshot(db.doc('live/doc'), (snap) => {
      fires.push({ exists: snap.exists(), v: snap.data()?.v });
    });
    await tick();
    expect(fires).toEqual([{ exists: true, v: 1 }]);

    await db.doc('live/doc').set({ v: 2 });
    await tick();
    expect(fires[fires.length - 1]).toEqual({ exists: true, v: 2 });

    // BROWSER-side write (direct worker port) is visible: one shared store.
    await workerOp(ctx, {
      method: 'setDoc',
      path: 'live/doc',
      data: { v: 3 },
      actAs: { mode: 'admin' },
    });
    await tick();
    expect(fires[fires.length - 1]).toEqual({ exists: true, v: 3 });

    const count = fires.length;
    unsub();
    await db.doc('live/doc').set({ v: 4 });
    await tick();
    expect(fires).toHaveLength(count); // no delivery after unsubscribe
  });

  it('query listener: filtered membership + typed values + chainable form', async () => {
    const { remote } = makeStack();
    const db = getAdminFirestore(remote);
    await seedScores(db);

    const memberships: string[][] = [];
    // Chainable `.onSnapshot(...)` — parity with the local arm's shim.
    // Untyped by design on BOTH arms (see admin-firestore/index.ts's
    // post-cutover note); exercised via a structural cast.
    const query = db.collection('scores').where('team', '==', 'red').orderBy('points');
    const unsub = (
      query as unknown as {
        onSnapshot(cb: (snap: { docs: Array<{ id: string }> }) => void): () => void;
      }
    ).onSnapshot((snap) => {
      memberships.push(snap.docs.map((d) => d.id));
    });
    await tick();
    expect(memberships).toEqual([['a', 'c']]);

    await db.doc('scores/e').set({ player: 'eve', points: 15, team: 'red' });
    await tick();
    expect(memberships[memberships.length - 1]).toEqual(['a', 'e', 'c']);
    unsub();
  });

  it('spurious-emission matrix: unrelated activity and peer churn re-fire NOTHING', async () => {
    // Live bug: with a browser tab + a Studio tab open, the two pages cycled
    // through the bridge's last-wins peer registration (each reconnecting
    // after ~500ms), and every registration re-issued the sub registry — the
    // re-established worker listener's initial snapshot reached the consumer,
    // so a remote doc listener fired ~1/sec with byte-identical data and no
    // document change. Real Firestore listeners fire on change only; a
    // callback that writes anything becomes an infinite write loop.
    const { bridge, ctx, remote } = makeStack();
    const db = getAdminFirestore(remote);
    await db.doc('live/check').set({ n: 1, at: 'fixed' });

    const docFires: string[] = [];
    const queryFires: string[] = [];
    onSnapshot(db.doc('live/check'), (snap) => {
      docFires.push(JSON.stringify(snap.data()));
    });
    (
      db.collection('live') as unknown as {
        onSnapshot(cb: (snap: { docs: Array<{ id: string }> }) => void): () => void;
      }
    ).onSnapshot((snap) => {
      queryFires.push(JSON.stringify(snap.docs.map((d) => d.id)));
    });
    await tick();
    expect(docFires).toHaveLength(1); // initial snapshots only
    expect(queryFires).toHaveLength(1);

    // Unrelated activity on the shared worker sandbox — none of it touches
    // live/*, so neither listener may fire.
    await workerOp(ctx, {
      method: 'setDoc', path: 'other/doc', data: { x: 1 }, actAs: { mode: 'admin' },
    });
    await workerOp(ctx, { method: 'rtdb.set', path: 'presence/x', value: { on: true } });
    await workerOp(ctx, {
      method: 'auth.createUser', email: 'ambient@example.com', password: 'pw-123456',
    });
    await workerOp(ctx, { method: 'exportState' }); // the persistence-flush read path
    await workerOp(ctx, { method: 'admin.readState' });
    await workerOp(ctx, { method: 'getDoc', path: 'live/check', actAs: { mode: 'admin' } }); // Studio-like reads
    await workerOp(ctx, {
      method: 'getDocs', source: { __ref: 'collection', path: 'other' }, actAs: { mode: 'admin' },
    });
    // Peer churn — the trigger the live cadence came from.
    for (let i = 0; i < 3; i++) {
      connectTab(bridge, ctx);
      await tick();
    }
    await tick(50);
    expect(docFires).toHaveLength(1); // zero spurious emissions
    expect(queryFires).toHaveLength(1);

    // Legitimate changes still deliver — rapid consecutive writes are two
    // distinct emissions, and a change made right after churn delivers too.
    await db.doc('live/check').set({ n: 2, at: 'fixed' });
    await db.doc('live/check').set({ n: 3, at: 'fixed' });
    await tick();
    expect(docFires).toHaveLength(3);
    expect(docFires[2]).toBe(JSON.stringify({ n: 3, at: 'fixed' }));
    expect(queryFires).toHaveLength(3);
  });

  it('a denied listener routes to onError with the local arm error shape', async () => {
    const { remote } = makeStack({ rules: MATRIX_RULES });
    const db = getFirestore(remote.withAuth({ uid: 'bob' }));

    const errors: WireError[] = [];
    const fires: unknown[] = [];
    onSnapshot(
      db.doc('locked/x'),
      (snap) => fires.push(snap),
      (err) => errors.push(err as WireError),
    );
    await tick();
    expect(fires).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(SandboxError);
    expect(errors[0]!.code).toBe('permission-denied');
    // Parity with the LOCAL arm: the sandbox does not populate
    // denialContext on snapshot-listener denials (only on op denials).
    expect(errors[0]!.denialContext).toBeUndefined();
  });
});

// ─── Identity matrix ───────────────────────────────────────────────────────

describe('pyric-admin remote Firestore — identity matrix', () => {
  it('admin bypasses deny rules; anon and as-uid evaluate rules', async () => {
    const { remote } = makeStack({ rules: MATRIX_RULES });

    // Admin lens: deny-all collection is writable + readable.
    const admin = getAdminFirestore(remote);
    await admin.doc('locked/x').set({ secret: 1 });
    expect((await admin.doc('locked/x').get()).data()).toEqual({ secret: 1 });

    // Anonymous (withAuth(null) → the `anon` lens): /authed denies.
    const anon = getFirestore(remote.withAuth(null));
    let anonErr: WireError | undefined;
    try {
      await anon.doc('authed/x').set({ v: 1 });
    } catch (e) {
      anonErr = e as WireError;
    }
    expect(anonErr).toBeInstanceOf(SandboxError);
    expect(anonErr!.code).toBe('permission-denied');
    // /open allows anyone, including anon.
    await anon.doc('open/x').set({ v: 1 });

    // as-uid: alice passes the uid gate, bob does not.
    const alice = getFirestore(remote.withAuth({ uid: 'alice' }));
    await alice.doc('alice/mine').set({ v: 1 });
    await alice.doc('authed/y').set({ v: 1 });
    const bob = getFirestore(remote.withAuth({ uid: 'bob' }));
    expect(bob.doc('alice/mine').get()).rejects.toThrow(/denied/i);
  });

  it('custom-claims tokens ride the `as` lens with full fidelity', async () => {
    const { remote } = makeStack({ rules: MATRIX_RULES });
    const withClaim = getFirestore(remote.withAuth({ uid: 'root', token: { admin: true } }));
    await withClaim.doc('admins/a').set({ v: 1 });

    const withoutClaim = getFirestore(remote.withAuth({ uid: 'root' }));
    expect(withoutClaim.doc('admins/b').set({ v: 1 })).rejects.toThrow(/denied/i);
  });

  it('a signed-in PORT session must NOT leak into a withAuth(null) handle', async () => {
    const { remote } = makeStack({ rules: MATRIX_RULES });

    // Sign the RELAY PORT's session in (the browser tab's user). An op
    // relayed WITHOUT a lens would now run as this user and pass /authed.
    await remote.channel.op({
      method: 'auth.createUser',
      email: 'tab-user@example.com',
      password: 'correct-horse',
    });

    // The remote arm pins `{ mode: 'anon' }` for withAuth(null) — the
    // tab's session must not bleed through.
    const anon = getFirestore(remote.withAuth(null));
    let caught: WireError | undefined;
    try {
      await anon.doc('authed/leak').set({ v: 1 });
    } catch (e) {
      caught = e as WireError;
    }
    expect(caught).toBeInstanceOf(SandboxError);
    expect(caught!.code).toBe('permission-denied');
  });
});

// ─── Error fidelity + sandbox extras ───────────────────────────────────────

describe('pyric-admin remote Firestore — errors + sandbox extras', () => {
  it('a denied write throws SandboxError with structured denialContext', async () => {
    const { remote } = makeStack({ rules: MATRIX_RULES });
    const db = getFirestore(remote.withAuth({ uid: 'bob' }));

    let caught: (SandboxError & { denialContext?: { reasons?: string[]; request?: { method?: string; path?: string } } }) | undefined;
    try {
      await db.doc('locked/x').set({ v: 1 });
    } catch (e) {
      caught = e as typeof caught;
    }
    expect(caught).toBeInstanceOf(SandboxError);
    expect(caught!.code).toBe('permission-denied');
    expect(caught!.denialContext).toBeDefined();
    expect(Array.isArray(caught!.denialContext!.reasons)).toBe(true);
    expect(caught!.denialContext!.request?.path).toContain('locked/x');
  });

  it('non-denial errors keep their typed code (invalid path shape at the call site)', async () => {
    const { remote } = makeStack();
    const db = getAdminFirestore(remote);
    let caught: WireError | undefined;
    try {
      db.doc('nope/odd/segments');
    } catch (e) {
      caught = e as WireError;
    }
    expect(caught).toBeInstanceOf(SandboxError);
    expect(caught!.code).toBe('invalid-argument');
    expect(() => db.collection('two/segments')).toThrow(/odd number of segments/);
  });

  it('setRules / seed / snapshot throw remediating errors naming the async alternative', () => {
    const { remote } = makeStack();
    const db = getAdminFirestore(remote);
    expect(() => db.setRules(OPEN_RULES)).toThrow(/setFirestoreRules/);
    expect(() => db.seed({ documents: {} })).toThrow(/admin\.setDocument/);
    expect(() => db.snapshot()).toThrow(/admin\.readState/);
    for (const call of [() => db.setRules(''), () => db.seed(), () => db.snapshot()]) {
      try {
        call();
        throw new Error('expected throw');
      } catch (e) {
        expect((e as WireError).code).toBe('unimplemented');
      }
    }
  });

  it('no-peer failure fails fast with the "open <serve url>" guidance', async () => {
    const bridge = createBridge({ mode: 'sandbox', version: 'test' });
    const remote = connectRemote(bridge); // NO tab registered
    const db = getAdminFirestore(remote);
    const started = Date.now();
    expect(db.doc('x/y').get()).rejects.toThrow(/open http:\/\/localhost:5000/);
    try {
      await db.doc('x/y').set({ v: 1 });
      throw new Error('expected rejection');
    } catch (err) {
      expect((err as WireError).code).toBe('unavailable');
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

// ─── Conformance: same assertions, both arms ───────────────────────────────

/**
 * The compat-model pattern in miniature: ONE set of consumer assertions
 * exercised against BOTH backends. The local handle is the oracle; the
 * remote handle must be observationally identical across the shared
 * surface (CRUD, merge, sentinels, queries, aggregates, batch, txn).
 */
function conformanceSuite(name: string, makeDb: () => Promise<SandboxFirestore> | SandboxFirestore) {
  describe(`conformance — ${name}`, () => {
    it('CRUD + merge + sentinel + query + aggregate + batch + txn behave identically', async () => {
      const db = await makeDb();

      // CRUD + typed values.
      await db.doc('c/one').set({ v: 1, at: new Timestamp(42, 0) });
      const one = (await db.doc('c/one').get()).data()!;
      expect(one.v).toBe(1);
      expect(one.at).toBeInstanceOf(Timestamp);
      expect((one.at as Timestamp).seconds).toBe(42);

      // Merge + sentinels.
      await db.doc('c/one').set({ extra: true }, { merge: true });
      await db.doc('c/one').update({ v: FieldValue.increment(9) });
      expect((await db.doc('c/one').get()).data()).toMatchObject({ v: 10, extra: true });

      // update() on a missing doc → not-found on both arms.
      let updErr: WireError | undefined;
      try {
        await db.doc('c/missing').update({ v: 1 });
      } catch (e) {
        updErr = e as WireError;
      }
      expect(updErr?.code).toBe('not-found');

      // Query + composite filter + aggregate.
      await db.doc('c/q1').set({ k: 1, group: 'x' });
      await db.doc('c/q2').set({ k: 2, group: 'y' });
      await db.doc('c/q3').set({ k: 3, group: 'x' });
      const xs = await db
        .collection('c')
        .applyFilter({
          kind: 'or',
          filters: [
            { kind: 'where', field: 'group', op: '==', value: 'x' },
            { kind: 'where', field: 'k', op: '==', value: 2 },
          ],
        })
        .orderBy('k')
        .get();
      expect(xs.docs.map((d) => d.data().k)).toEqual([1, 2, 3]);
      const agg = await db
        .collection('c')
        .where('group', '==', 'x')
        .aggregate({ n: { kind: 'count' }, sum: { kind: 'sum', field: 'k' } });
      expect(agg.data()).toEqual({ n: 2, sum: 4 });

      // Batch.
      await db.batch().set(db.doc('c/b1'), { v: 1 }).set(db.doc('c/b2'), { v: 2 }).commit();
      expect((await db.doc('c/b2').get()).data()).toEqual({ v: 2 });

      // Transaction.
      const out = await db.runTransaction(async (tx) => {
        const snap = await tx.get(db.doc('c/b1'));
        const v = (snap.data()!.v as number) + 100;
        tx.update(db.doc('c/b1'), { v });
        return v;
      });
      expect(out).toBe(101);
      expect((await db.doc('c/b1').get()).data()).toEqual({ v: 101 });
    });

    it('reads-before-writes: tx.get after a buffered write throws failed-precondition, message-identical', async () => {
      const db = await makeDb();
      await db.doc('rw/x').set({ v: 1 });
      let caught: (Error & { code?: string }) | undefined;
      try {
        await db.runTransaction(async (tx) => {
          tx.set(db.doc('rw/x'), { v: 2 });
          await tx.get(db.doc('rw/x')); // read AFTER a write — must throw
        });
      } catch (e) {
        caught = e as Error & { code?: string };
      }
      expect(caught).toBeDefined();
      expect(caught!.code).toBe('failed-precondition');
      // EXACT message parity across arms (the Admin SDK's locked wording).
      expect(caught!.message).toBe(
        'Firestore transactions require all reads to be executed before all writes.',
      );
      // The write buffered before the violation must NOT have committed.
      expect((await db.doc('rw/x').get()).data()).toEqual({ v: 1 });
    });
  });
}

conformanceSuite('local arm (oracle)', () => {
  const sandbox = initializeSandbox();
  const db = getBaseAdminFirestore(sandbox);
  getLocalBaseFirestore(sandbox.withAuth(null)).setRules(OPEN_RULES);
  return db;
});

conformanceSuite('remote arm', () => {
  const { remote } = makeStack();
  return getAdminFirestore(remote);
});

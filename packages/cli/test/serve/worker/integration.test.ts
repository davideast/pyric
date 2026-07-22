/**
 * FULL client↔host round-trip (the gate reproduction).
 *
 * host.test.ts drives `handleMessage` directly with hand-built descriptors.
 * This wires the REAL `client.ts` to the REAL `host.ts` over a fake async
 * MessagePort pair (mimicking a real worker port) and a shimmed `SharedWorker`,
 * so the exact browser sequence runs in bun: getFirestore → getAuth →
 * createUser → onSnapshot(query) → addDoc. This is where the gate bug lives
 * (the host alone works; the integration does not).
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  cleanupPortWithDisconnect,
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import {
  initializeSandbox,
  createMemoryBackend,
} from 'pyric/sandbox';
import { deleteApp, initializeApp } from 'pyric/app';
import { getFirestore as ipGetFirestore } from 'pyric/firestore';
import { getAuth as ipGetAuth } from 'pyric/auth';
import { monitorFirebaseActivity, type ActivityIncident } from 'pyric/firestore/internal';
import * as client from '../../../src/serve/worker/client.js';
import { disconnectClient } from '../../../src/serve/worker/client/disconnect.js';

const GATE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{id} {
      allow read: if request.auth != null && request.auth.uid == resource.data.uid;
      allow create: if request.auth != null && request.auth.uid == request.resource.data.uid;
      allow update, delete: if request.auth != null && request.auth.uid == resource.data.uid;
    }
  }
}`;

/** A bidirectional fake MessagePort pair. postMessage on one delivers
 *  `{ data }` to the other's onmessage on a macrotask (mimics real ports). */
interface FakePort {
  postMessage(msg: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  start(): void;
  close(): void;
  addEventListener(type: string, fn: () => void): void;
}
function portPair(): { a: FakePort; b: FakePort } {
  const a: FakePort = { onmessage: null, postMessage() {}, start() {}, close() {}, addEventListener() {} };
  const b: FakePort = { onmessage: null, postMessage() {}, start() {}, close() {}, addEventListener() {} };
  a.postMessage = (msg) => setTimeout(() => b.onmessage?.({ data: msg }), 0);
  b.postMessage = (msg) => setTimeout(() => a.onmessage?.({ data: msg }), 0);
  return { a, b };
}

async function makeHostCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  const { getFirestore: adm } = await import('pyric/sandbox/admin-firestore');
  adm(sandbox.withAuth(null)).setRules(GATE_RULES);
  await sandbox.enablePersistence({ key: `int-${Math.random()}`, injectedBackend: createMemoryBackend() });
  ipGetAuth(sandbox);
  return { db: ipGetFirestore(sandbox), sandbox, subs: new Map(), sessionMode: 'LOCAL', sessionBackend: createMemoryBackend() };
}

const sleep = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('client↔host round-trip (gate repro)', () => {
  let restoreSW: () => void;

  beforeEach(() => {
    const prev = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSW = () => { (globalThis as { SharedWorker?: unknown }).SharedWorker = prev; };
  });
  afterEach(() => restoreSW());

  it('createUser → onSnapshot(where uid + orderBy createdAt) → addDoc delivers to the client', async () => {
    const ctx = await makeHostCtx();
    const { a: clientPort, b: hostPort } = portPair();

    // Host: wire its port to handleMessage. post() in the host calls
    // port.postMessage → delivers to the client port's onmessage.
    const hostPortLike: PortLike = { postMessage: (m: OutboundMessage) => hostPort.postMessage(m) };
    hostPort.onmessage = (ev) => { void handleMessage(ctx, hostPortLike, ev.data as InboundMessage); };

    // Shim SharedWorker so client.getFirestore returns a worker whose .port is
    // our client-side fake port (which client.wirePort will attach onmessage to).
    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port = clientPort;
      constructor(_url: unknown, _opts: unknown) {}
    };

    // ── REAL client surface, exactly as the gate app uses it ──────────────
    const db = client.getFirestore('worker://test');
    const auth = client.getAuth(db);
    const cred = await client.createUserWithEmailAndPassword(auth, 'alice@example.com', 'pw123456');
    const uid = cred.user.uid;

    const fires: number[] = [];
    const q = client.query(
      client.collection(db, 'notes'),
      client.where('uid', '==', uid),
      client.orderBy('createdAt', 'asc'),
    );
    const errors: string[] = [];
    client.onSnapshot(
      q,
      (snap) => fires.push((snap as { docs: unknown[] }).docs.length),
      (err) => errors.push((err as { code?: string; message?: string }).code ?? String((err as Error).message)),
    );
    await sleep(); // let the initial fire land

    await client.addDoc(client.collection(db, 'notes'), {
      uid, text: 'hello', createdAt: client.serverTimestamp(),
    });
    await sleep();

    // The crux: the listener must fire (initial empty, then with the doc).
    expect(errors).toEqual([]);
    expect(fires.length).toBeGreaterThanOrEqual(1);
    expect(fires.at(-1)).toBe(1);
  });

  it('excludes split transaction reads from activity warnings', async () => {
    const ctx = await makeHostCtx();
    const { a: clientPort, b: hostPort } = portPair();
    const hostPortLike: PortLike = {
      postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
    };
    hostPort.onmessage = (event) => {
      void handleMessage(ctx, hostPortLike, event.data as InboundMessage);
    };
    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port = clientPort;
      constructor(_url: unknown, _opts: unknown) {}
    };

    const db = client.getFirestore('worker://activity-transaction-test');
    const auth = client.getAuth(db);
    const credential = await client.createUserWithEmailAndPassword(
      auth,
      'transaction@example.com',
      'pw123456',
    );
    const ref = client.doc(db, 'notes/transaction');
    await client.setDoc(ref, { uid: credential.user.uid });

    const warnings: ActivityIncident[] = [];
    const monitor = monitorFirebaseActivity(
      {
        history: () => ctx.sandbox.history(),
        subscribe: (listener) => ctx.sandbox.onEvent(listener),
      },
      (incident) => warnings.push(incident),
    );

    await client.runTransaction(db, async (transaction) => {
      for (let index = 0; index < 5; index += 1) await transaction.get(ref);
    });

    expect(ctx.sandbox.history().filter(
      (event) => event.kind === 'request' && event.activity?.groupKind === 'transaction',
    )).toHaveLength(5);
    expect(warnings).toEqual([]);

    for (let index = 0; index < 5; index += 1) await client.getDoc(ref);
    expect(warnings.map((incident) => incident.pattern)).toEqual(['repeated-read']);
    monitor.dispose();
  });

  it('excludes remote relay reads and listeners while retaining page warnings', async () => {
    const ctx = await makeHostCtx();
    const { a: clientPort, b: hostPort } = portPair();
    const hostPortLike: PortLike = {
      postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
    };
    hostPort.onmessage = (event) => {
      void handleMessage(ctx, hostPortLike, event.data as InboundMessage);
    };
    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port = clientPort;
      constructor(_url: unknown, _opts: unknown) {}
    };

    const db = client.getFirestore('worker://activity-remote-relay-test');
    const auth = client.getAuth(db);
    const credential = await client.createUserWithEmailAndPassword(
      auth,
      'remote-relay@example.com',
      'pw123456',
    );
    const uid = credential.user.uid;
    const path = 'notes/remote-relay';
    const ref = client.doc(db, path);
    await client.setDoc(ref, { uid });
    const warnings: ActivityIncident[] = [];
    const monitor = monitorFirebaseActivity(
      {
        history: () => ctx.sandbox.history(),
        subscribe: (listener) => ctx.sandbox.onEvent(listener),
      },
      (incident) => warnings.push(incident),
    );

    const remoteRequestsBefore = ctx.sandbox.history().filter((event) =>
      event.kind === 'request'
      && event.path === path
      && event.operationContext?.source.kind === 'unattributed'
    ).length;
    for (let index = 0; index < 5; index += 1) {
      await client.relayWorkerOp(db, {
        method: 'getDoc', path, actAs: { mode: 'as', uid },
      });
    }
    expect(warnings).toEqual([]);
    const remoteRequestsAfter = ctx.sandbox.history().filter((event) =>
      event.kind === 'request'
      && event.path === path
      && event.operationContext?.source.kind === 'unattributed'
    ).length;
    expect(remoteRequestsAfter - remoteRequestsBefore).toBe(5);

    const remoteUnsubscribes = Array.from({ length: 3 }, () => client.relayWorkerSub(
      db,
      { target: { __ref: 'doc', path }, actAs: { mode: 'as', uid } },
      () => {},
    ));
    await sleep();

    expect(warnings).toEqual([]);

    for (let index = 0; index < 5; index += 1) await client.getDoc(ref);
    const pageUnsubscribes = Array.from({ length: 3 }, () => client.onSnapshot(ref, () => {}));
    await sleep();
    expect(warnings.map((incident) => incident.pattern)).toEqual([
      'repeated-read',
      'duplicate-listener',
    ]);

    for (const unsubscribe of [...remoteUnsubscribes, ...pageUnsubscribes]) unsubscribe();
    monitor.dispose();
  });
});

describe('client↔host event stream (Studio data plane)', () => {
  let restoreSW: () => void;

  beforeEach(() => {
    const prev = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSW = () => { (globalThis as { SharedWorker?: unknown }).SharedWorker = prev; };
  });
  afterEach(() => restoreSW());

  /** Wire a real client `ClientDb` to a real host over a fake async port pair. */
  async function connectClient(): Promise<{ ctx: HostCtx; db: ReturnType<typeof client.getFirestore> }> {
    const ctx = await makeHostCtx();
    const { a: clientPort, b: hostPort } = portPair();
    const hostPortLike: PortLike = { postMessage: (m: OutboundMessage) => hostPort.postMessage(m) };
    hostPort.onmessage = (ev) => { void handleMessage(ctx, hostPortLike, ev.data as InboundMessage); };
    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port = clientPort;
      constructor(_url: unknown, _opts: unknown) {}
    };
    return { ctx, db: client.getFirestore('worker://test') };
  }

  it('subscribeEvents delivers history first, then streams live events', async () => {
    const { ctx, db } = await connectClient();

    // Seed a write directly on the host sandbox BEFORE subscribing — it lands in
    // history(). The modular admin handle bypasses GATE_RULES so the seed lands.
    const { getAdminFirestore, doc: admDoc, setDoc: admSet } =
      await import('pyric/firestore');
    const admDb = getAdminFirestore(ctx.sandbox);
    await admSet(admDoc(admDb, 'seed/a'), { n: 1 });
    const historyLen = ctx.sandbox.history().length;
    expect(historyLen).toBeGreaterThan(0);

    const batches: number[] = [];
    let firstBatchLen = -1;
    const unsub = client.subscribeEvents(db, (events) => {
      if (firstBatchLen === -1) firstBatchLen = events.length;
      batches.push(events.length);
    });
    await sleep();

    // First delivered batch is the history snapshot.
    expect(firstBatchLen).toBe(historyLen);

    // A live write now streams further event batches to the subscriber.
    const before = batches.length;
    await admSet(admDoc(admDb, 'seed/b'), { n: 2 });
    await sleep();
    expect(batches.length).toBeGreaterThan(before);

    unsub();
  });

  it('RTDB push mints a synchronous key and writes through the shared worker', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const root = client.rtdbRef(rtdb, 'scores');

    const pushed = client.rtdbPush(root, { value: 7 });

    expect(pushed.key).toMatch(/^[-0-9A-Z_a-z]{20}$/);
    expect(pushed.path).toBe(`/scores/${pushed.key}`);
    await pushed;

    const snap = await client.rtdbGet(pushed);
    expect(snap.exists()).toBe(true);
    expect(snap.val()).toEqual({ value: 7 });
  });

  it('RTDB child listeners work through the shared-worker client', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const scores = client.rtdbRef(rtdb, 'scores');
    await client.rtdbSet(scores, { ada: { value: 7 } });

    const added: Array<{ key: string | null; value: unknown }> = [];
    const changed: Array<{ key: string | null; value: unknown }> = [];
    const unsubscribeAdded = client.rtdbOnChildAdded(scores, (snap) => {
      added.push({ key: snap.key, value: snap.val() });
    });
    const unsubscribeChanged = client.rtdbOnChildChanged(scores, (snap) => {
      changed.push({ key: snap.key, value: snap.val() });
    });
    await sleep();

    expect(added).toEqual([{ key: 'ada', value: { value: 7 } }]);
    expect(changed).toEqual([]);

    await client.rtdbSet(client.rtdbChild(scores, 'grace'), { value: 9 });
    await sleep();
    expect(added.at(-1)).toEqual({ key: 'grace', value: { value: 9 } });
    expect(changed).toEqual([]);

    await client.rtdbSet(client.rtdbChild(scores, 'ada'), { value: 8 });
    await sleep();
    expect(changed).toEqual([{ key: 'ada', value: { value: 8 } }]);

    await client.rtdbRemove(client.rtdbChild(scores, 'grace'));
    await sleep();
    expect(changed).toEqual([{ key: 'ada', value: { value: 8 } }]);

    unsubscribeAdded();
    unsubscribeChanged();
    await client.rtdbSet(client.rtdbChild(scores, 'lin'), { value: 10 });
    await client.rtdbSet(client.rtdbChild(scores, 'ada'), { value: 11 });
    await sleep();
    expect(added).toHaveLength(2);
    expect(changed).toHaveLength(1);
  });

  it('RTDB child listeners preserve numeric children and ignore object field order', async () => {
    const { db } = await connectClient();
    const rtdb = client.rtdbGetDatabase(db);
    const rows = client.rtdbRef(rtdb, 'rows');
    await client.rtdbSet(rows, ['zero', 'one', 'two']);

    const added: string[] = [];
    const changed: unknown[] = [];
    const unsubscribeAdded = client.rtdbOnChildAdded(rows, (snap) => added.push(snap.key ?? ''));
    const unsubscribeChanged = client.rtdbOnChildChanged(rows, (snap) => changed.push(snap.val()));
    await sleep();
    expect(added).toEqual(['0', '1', '2']);

    await client.rtdbSet(client.rtdbChild(rows, '1'), { a: 1, b: 2 });
    await sleep();
    expect(changed).toEqual([{ a: 1, b: 2 }]);
    await client.rtdbSet(client.rtdbChild(rows, '1'), { b: 2, a: 1 });
    await sleep();
    expect(changed).toHaveLength(1);

    unsubscribeAdded();
    unsubscribeChanged();
  });

  it('goOffline drains a writer port onDisconnect queue once while an independent port observes', async () => {
    const ctx = await makeHostCtx();
    const connectPort = (url: string) => {
      const { a: clientPort, b: hostPort } = portPair();
      const hostPortLike: PortLike = { postMessage: (message: OutboundMessage) => hostPort.postMessage(message) };
      hostPort.onmessage = (event) => { void handleMessage(ctx, hostPortLike, event.data as InboundMessage); };
      (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
        port = clientPort;
        constructor(_url: unknown, _opts: unknown) {}
      };
      return { db: client.getFirestore(url), hostPort: hostPortLike };
    };

    const { db: writerClient, hostPort: writerHostPort } = connectPort('worker://disconnect-writer');
    const { db: observerClient } = connectPort('worker://disconnect-observer');
    const writerDb = client.rtdbGetDatabase(writerClient);
    const observerDb = client.rtdbGetDatabase(observerClient);
    const writerRef = client.rtdbRef(writerDb, 'disconnect');
    const observerRef = client.rtdbRef(observerDb, 'disconnect');
    await client.rtdbSet(writerRef, {
      presence: { state: 'online', child: 'original-child' },
      update: { keep: true, value: 1 },
      nestedUpdate: { a: { b: 'old', c: 'keep' }, stable: true },
      remove: { before: true },
      cancelled: { child: 'original' },
    });

    const events: unknown[] = [];
    const unsubscribe = client.rtdbOnValue(observerRef, (snapshot) => events.push(snapshot.val()));
    await sleep();
    const presence = client.rtdbChild(writerRef, 'presence');
    await client.rtdbOnDisconnect(presence).set({ state: 'offline', child: 'parent-child' });
    await client.rtdbOnDisconnect(client.rtdbChild(presence, 'child')).set('queued-child');
    await client.rtdbOnDisconnect(client.rtdbChild(presence, 'child')).cancel();
    await client.rtdbOnDisconnect(client.rtdbChild(writerRef, 'update')).update({ value: 2, added: true });
    const nestedUpdate = client.rtdbChild(writerRef, 'nestedUpdate');
    await client.rtdbOnDisconnect(nestedUpdate).update({ a: { b: 'new' }, changed: true });
    await client.rtdbOnDisconnect(client.rtdbChild(nestedUpdate, 'a/b')).set('child-write');
    await client.rtdbOnDisconnect(client.rtdbChild(nestedUpdate, 'a/b')).cancel();
    await client.rtdbOnDisconnect(client.rtdbChild(writerRef, 'remove')).remove();
    await client.rtdbOnDisconnect(client.rtdbChild(writerRef, 'cancelled/child')).set('queued-child');
    await client.rtdbOnDisconnect(client.rtdbChild(writerRef, 'cancelled')).cancel();
    expect((await client.rtdbGet(client.rtdbChild(observerRef, 'presence'))).val())
      .toEqual({ state: 'online', child: 'original-child' });

    client.rtdbGoOffline(writerDb);
    await sleep();
    const terminal = (await client.rtdbGet(observerRef)).val();
    expect(terminal).toEqual({
      presence: { state: 'offline', child: 'original-child' },
      update: { keep: true, value: 2, added: true },
      nestedUpdate: { a: { b: 'old', c: 'keep' }, stable: true, changed: true },
      cancelled: { child: 'original' },
    });
    expect(events).toEqual([
      {
        presence: { state: 'online', child: 'original-child' },
        update: { keep: true, value: 1 },
        nestedUpdate: { a: { b: 'old', c: 'keep' }, stable: true },
        remove: { before: true },
        cancelled: { child: 'original' },
      },
      {
        presence: { state: 'offline', child: 'original-child' },
        update: { keep: true, value: 1 },
        nestedUpdate: { a: { b: 'old', c: 'keep' }, stable: true },
        remove: { before: true },
        cancelled: { child: 'original' },
      },
      {
        presence: { state: 'offline', child: 'original-child' },
        update: { keep: true, value: 2, added: true },
        nestedUpdate: { a: { b: 'old', c: 'keep' }, stable: true },
        remove: { before: true },
        cancelled: { child: 'original' },
      },
      {
        presence: { state: 'offline', child: 'original-child' },
        update: { keep: true, value: 2, added: true },
        nestedUpdate: { a: { b: 'old', c: 'keep' }, stable: true, changed: true },
        remove: { before: true },
        cancelled: { child: 'original' },
      },
      terminal,
    ]);
    await cleanupPortWithDisconnect(ctx, writerHostPort);
    await sleep();
    expect(events).toHaveLength(5);
    unsubscribe();
  });

  it('served app deletion drains its worker-owned onDisconnect queue', async () => {
    const ctx = await makeHostCtx();
    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port: FakePort;
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
    const { workerClientForApp } = await import('../../../src/serve/entries/app-client.js');
    const writerApp = initializeApp({ projectId: 'served-delete' }, 'served-delete-writer');
    const observerApp = initializeApp({ projectId: 'served-delete' }, 'served-delete-observer');
    const writerDb = client.rtdbGetDatabase(workerClientForApp(writerApp));
    const observerDb = client.rtdbGetDatabase(workerClientForApp(observerApp));
    const writerRef = client.rtdbRef(writerDb, 'served/delete');
    await client.rtdbSet(writerRef, 'online');
    await client.rtdbOnDisconnect(writerRef).set('offline');

    await deleteApp(writerApp);
    await sleep();
    expect((await client.rtdbGet(client.rtdbRef(observerDb, 'served/delete'))).val()).toBe('offline');
    await deleteApp(observerApp);
  });

  it('non-persisted pagehide drains the served app worker queue', async () => {
    const ctx = await makeHostCtx();
    const pagehideListeners = new Set<(event: Event) => void>();
    const priorAdd = globalThis.addEventListener;
    const priorRemove = globalThis.removeEventListener;
    globalThis.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'pagehide' && typeof listener === 'function') {
        pagehideListeners.add(listener as (event: Event) => void);
      }
    }) as typeof globalThis.addEventListener;
    globalThis.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'pagehide' && typeof listener === 'function') {
        pagehideListeners.delete(listener as (event: Event) => void);
      }
    }) as typeof globalThis.removeEventListener;
    try {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
        port: FakePort;
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
      const { workerClientForApp } = await import('../../../src/serve/entries/app-client.js');
      const writerApp = initializeApp({ projectId: 'served-delete' }, 'served-pagehide-writer');
      const writerDb = client.rtdbGetDatabase(workerClientForApp(writerApp));
      const writerRef = client.rtdbRef(writerDb, 'served/pagehide');
      await client.rtdbSet(writerRef, 'online');
      await client.rtdbOnDisconnect(writerRef).set('offline');

      for (const listener of pagehideListeners) {
        listener({ persisted: false } as PageTransitionEvent);
      }
      await sleep();
      const observerApp = initializeApp({ projectId: 'served-delete' }, 'served-pagehide-observer');
      const observerDb = client.rtdbGetDatabase(workerClientForApp(observerApp));
      expect((await client.rtdbGet(client.rtdbRef(observerDb, 'served/pagehide'))).val()).toBe('offline');
      await deleteApp(writerApp);
      await deleteApp(observerApp);
    } finally {
      globalThis.addEventListener = priorAdd;
      globalThis.removeEventListener = priorRemove;
    }
  });

  it('continues worker disconnect draining after a rules denial and still tears down the writer', async () => {
    const ctx = await makeHostCtx();
    const connectPort = (url: string) => {
      const { a: clientPort, b: hostPort } = portPair();
      const hostPortLike: PortLike = { postMessage: (message: OutboundMessage) => hostPort.postMessage(message) };
      hostPort.onmessage = (event) => { void handleMessage(ctx, hostPortLike, event.data as InboundMessage); };
      (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
        port = clientPort;
        constructor(_url: unknown, _opts: unknown) {}
      };
      return client.getFirestore(url);
    };

    const writerClient = connectPort('worker://disconnect-rules-writer');
    const observerClient = connectPort('worker://disconnect-rules-observer');
    const writerDb = client.rtdbGetDatabase(writerClient);
    const observerDb = client.rtdbGetDatabase(observerClient);
    const target = client.rtdbRef(writerDb, 'rulesTarget');
    const control = client.rtdbRef(writerDb, 'drainControl');
    await client.setDatabaseRules(writerClient, { rules: {
      rulesTarget: { '.read': true, '.write': true },
      drainControl: { '.read': true, '.write': true },
    } });
    await client.rtdbSet(target, 'seed');
    await client.rtdbOnDisconnect(target).set('denied');
    await client.rtdbOnDisconnect(control).set('drained');
    await client.setDatabaseRules(writerClient, { rules: {
      rulesTarget: { '.read': true, '.write': false },
      drainControl: { '.read': true, '.write': true },
    } });

    await expect(disconnectClient(writerClient)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect((await client.rtdbGet(client.rtdbRef(observerDb, 'rulesTarget'))).val()).toBe('seed');
    expect((await client.rtdbGet(client.rtdbRef(observerDb, 'drainControl'))).val()).toBe('drained');
  });

  it('Storage getDownloadURL returns a URL owned by the calling page', async () => {
    const { db } = await connectClient();
    const storage = client.getStorage(db);
    const r = client.ref(storage, 'download-url/ada.txt');
    await client.uploadBytes(r, new Blob(['worker-avatar'], { type: 'text/plain' }));

    const url = await client.getDownloadURL(r);
    try {
      expect(await (await fetch(url)).text()).toBe('worker-avatar');
    } finally {
      URL.revokeObjectURL(url);
      await client.deleteObject(r);
    }
  });
});

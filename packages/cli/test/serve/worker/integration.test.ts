/** Full client↔host round trips over a fake asynchronous MessagePort pair. */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import { getFirestore as ipGetFirestore } from 'pyric/firestore';
import { monitorFirebaseActivity, type ActivityIncident } from 'pyric/firestore/internal';
import * as client from '../../../src/serve/worker/client.js';
import {
  connectClient,
  makeHostCtx,
  portPair,
  sleep,
} from './integration-support.js';

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

  it('Storage uploadString round-trips over worker client across formats', async () => {
    const { db } = await connectClient();
    const storage = client.getStorage(db);

    // base64 format
    const rB64 = client.ref(storage, 'upload-string/b64.txt');
    await client.uploadString(rB64, 'aGVsbG8=', 'base64', { contentType: 'text/plain' });
    const urlB64 = await client.getDownloadURL(rB64);
    try {
      expect(await (await fetch(urlB64)).text()).toBe('hello');
    } finally {
      URL.revokeObjectURL(urlB64);
      await client.deleteObject(rB64);
    }

    // data_url format
    const rData = client.ref(storage, 'upload-string/data.txt');
    await client.uploadString(rData, 'data:text/plain;base64,d29ya2Vy', 'data_url');
    const urlData = await client.getDownloadURL(rData);
    try {
      expect(await (await fetch(urlData)).text()).toBe('worker');
    } finally {
      URL.revokeObjectURL(urlData);
      await client.deleteObject(rData);
    }

    // raw format
    const rRaw = client.ref(storage, 'upload-string/raw.txt');
    await client.uploadString(rRaw, 'raw text over worker', 'raw');
    const urlRaw = await client.getDownloadURL(rRaw);
    try {
      expect(await (await fetch(urlRaw)).text()).toBe('raw text over worker');
    } finally {
      URL.revokeObjectURL(urlRaw);
      await client.deleteObject(rRaw);
    }
  });
});

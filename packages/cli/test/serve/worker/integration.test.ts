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
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import {
  initializeSandbox,
  createMemoryBackend,
} from 'pyric/sandbox';
import { getFirestore as ipGetFirestore } from 'pyric/firestore';
import { getAuth as ipGetAuth } from 'pyric/auth';
import * as client from '../../../src/serve/worker/client.js';

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
  addEventListener(type: string, fn: () => void): void;
}
function portPair(): { a: FakePort; b: FakePort } {
  const a: FakePort = { onmessage: null, postMessage() {}, start() {}, addEventListener() {} };
  const b: FakePort = { onmessage: null, postMessage() {}, start() {}, addEventListener() {} };
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

import { afterEach, describe, expect, it } from 'bun:test';
import { initializeSandbox, type Sandbox } from 'pyric/sandbox';
import { getFirestore as getModularFirestore } from 'pyric/firestore';
import { getFirestore as getLocalBaseFirestore } from 'pyric/sandbox/admin-firestore';
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

import { PassThrough } from 'node:stream';
import * as upstreamAdminApp from 'firebase-admin/app';
import * as upstreamAdminFirestore from 'firebase-admin/firestore';
import * as upstreamAdminStorage from 'firebase-admin/storage';
import { deleteApp, getApps, initializeApp, type PyricAdminApp } from '../../src/app/index.js';
import {
  FieldPath,
  getFirestore,
  onSnapshot,
  Timestamp,
} from '../../src/firestore/index.js';
import { getStorage } from '../../src/storage/index.js';

const SERVE_URL = 'http://localhost:5000';

const OPEN_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

type ArmKind = 'local' | 'remote';

interface DualArmHarness {
  readonly kind: ArmKind;
  readonly hostSandbox: Sandbox;
  readonly targetSandbox: Sandbox | RemoteSandbox;
  readonly ctx?: HostCtx;
  createApp(name: string, options?: { storageBucket?: string }): PyricAdminApp;
  dispose(): void;
}

const activeDisposers: Array<() => void> = [];

function overWire<T>(frame: T): T {
  structuredClone(frame);
  return JSON.parse(JSON.stringify(frame)) as T;
}

function createHarness(kind: ArmKind): DualArmHarness {
  const hostSandbox = initializeSandbox();
  getLocalBaseFirestore(hostSandbox.withAuth(null)).setRules(OPEN_FIRESTORE_RULES);

  if (kind === 'local') {
    const harness: DualArmHarness = {
      kind,
      hostSandbox,
      targetSandbox: hostSandbox,
      createApp: (name, options) =>
        initializeApp({ sandbox: hostSandbox, ...options }, name),
      dispose: () => hostSandbox.dispose(),
    };
    activeDisposers.push(harness.dispose);
    return harness;
  }

  const bridge: Bridge = createBridge({ mode: 'sandbox', version: 'test' });
  const ctx: HostCtx = {
    db: getModularFirestore(hostSandbox),
    sandbox: hostSandbox,
    instanceId: `backend-parity-host-${Math.random().toString(36).slice(2)}`,
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
    'parity-tab',
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

  const harness: DualArmHarness = {
    kind,
    hostSandbox,
    targetSandbox: remote,
    ctx,
    createApp: (name, options) =>
      initializeApp({ sandbox: remote, ...options }, name),
    dispose: () => {
      remote.close();
      hostSandbox.dispose();
    },
  };
  activeDisposers.push(harness.dispose);
  return harness;
}

async function rejectedWithCode(fn: () => unknown): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return (err as { code?: string })?.code ?? 'thrown-without-code';
  }
}

describe('Admin Firestore & Storage dual-arm backend parity + upstream differential contracts', () => {
  afterEach(async () => {
    await Promise.all(upstreamAdminApp.getApps().map((app) => upstreamAdminApp.deleteApp(app).catch(() => {})));
    await Promise.all(getApps().map((app) => deleteApp(app).catch(() => {})));
    while (activeDisposers.length > 0) {
      activeDisposers.pop()?.();
    }
  });
  describe.each(['local', 'remote'] as const)('arm=%s: deleteApp Firestore lifecycle teardown', (arm) => {
    it('detaches active onSnapshot listeners and rejects retained Firestore, ref, query, batch, and transaction handles while preserving sibling apps', async () => {
      const h = createHarness(arm);
      const appPrimary = h.createApp(`primary-${arm}`);
      const appSibling = h.createApp(`sibling-${arm}`);

      const db = getFirestore(appPrimary);
      const siblingDb = getFirestore(appSibling);
      expect(getFirestore(appPrimary)).toBe(db);

      const heldDoc = db.doc('items/doc-1');
      const heldColl = db.collection('items');
      const heldQuery = heldColl.where('status', '==', 'active');
      const heldBatch = db.batch();

      await heldDoc.set({ status: 'active', owner: db.doc('users/u1') });
      const preDeleteSnap = await heldDoc.get();

      let postDeleteDocDeliveries = 0;
      let postDeleteQueryDeliveries = 0;
      let deleted = false;

      const heldDocWithListener = heldDoc as unknown as {
        onSnapshot(cb: () => void): () => void;
      };
      const unsubDoc = heldDocWithListener.onSnapshot(() => {
        if (deleted) postDeleteDocDeliveries += 1;
      });
      const unsubQuery = onSnapshot(heldQuery, () => {
        if (deleted) postDeleteQueryDeliveries += 1;
      });
      await new Promise((r) => setTimeout(r, 20));

      deleted = true;
      await deleteApp(appPrimary);

      // Sibling app mutates the watched document after primary app deletion:
      // detached listeners on appPrimary must not fire.
      await siblingDb.doc('items/doc-1').set({ status: 'active', updatedBy: 'sibling' });
      await new Promise((r) => setTimeout(r, 20));
      expect(postDeleteDocDeliveries).toBe(0);
      expect(postDeleteQueryDeliveries).toBe(0);

      unsubDoc();
      unsubQuery();

      expect(await rejectedWithCode(() => db.doc('items/doc-1'))).toBe('app/app-deleted');
      expect(await rejectedWithCode(() => db.collection('items'))).toBe('app/app-deleted');
      expect(await rejectedWithCode(() => db.collectionGroup('items'))).toBe('app/app-deleted');
      expect(await rejectedWithCode(() => db.batch())).toBe('app/app-deleted');
      expect(await rejectedWithCode(() => db.runTransaction(async () => 1))).toBe('app/app-deleted');
      expect(await rejectedWithCode(() => heldDoc.get())).toBe('app/app-deleted');
      expect(await rejectedWithCode(() => heldDoc.set({ status: 'stale' }))).toBe('app/app-deleted');
      expect(await rejectedWithCode(() => heldColl.add({ status: 'stale' }))).toBe('app/app-deleted');
      expect(await rejectedWithCode(() => heldQuery.get())).toBe('app/app-deleted');
      expect(await rejectedWithCode(() => heldDocWithListener.onSnapshot(() => {}))).toBe('app/app-deleted');
      expect(await rejectedWithCode(() => {
        heldBatch.set(heldDoc, { status: 'stale' });
        return heldBatch.commit();
      })).toBe('app/app-deleted');

      // Already-fetched snapshot remains readable in memory, while I/O on refs
      // derived from it rejects with app/app-deleted.
      const preDeleteData = preDeleteSnap.data() as { status: string; owner: { get(): Promise<unknown> } };
      expect(preDeleteData.status).toBe('active');
      expect(await rejectedWithCode(() => preDeleteSnap.ref.get())).toBe('app/app-deleted');
      expect(await rejectedWithCode(() => preDeleteData.owner.get())).toBe('app/app-deleted');

      const siblingSnap = await siblingDb.doc('items/doc-1').get();
      expect(siblingSnap.data()).toEqual({ status: 'active', updatedBy: 'sibling' });
    });

    it('rejects an in-flight runTransaction with app/app-deleted without committing when deleteApp resolves mid-attempt', async () => {
      const h = createHarness(arm);
      const appInFlight = h.createApp(`inflight-${arm}`);
      const appObserver = h.createApp(`observer-${arm}`);
      const db = getFirestore(appInFlight);
      const observerDb = getFirestore(appObserver);

      await db.doc('items/tx-doc').set({ writtenAfterDelete: false });

      let markInsideAttempt!: () => void;
      const insideAttempt = new Promise<void>((resolve) => {
        markInsideAttempt = resolve;
      });
      let releaseAttempt!: () => void;
      const attemptGate = new Promise<void>((resolve) => {
        releaseAttempt = resolve;
      });

      const txPromise = db.runTransaction(async (tx) => {
        await tx.get(db.doc('items/tx-doc'));
        tx.set(db.doc('items/tx-doc'), { writtenAfterDelete: true });
        markInsideAttempt();
        await attemptGate;
        return 'committed';
      });

      await insideAttempt;
      await deleteApp(appInFlight);
      releaseAttempt();

      expect(await rejectedWithCode(() => txPromise)).toBe('app/app-deleted');
      const finalSnap = await observerDb.doc('items/tx-doc').get();
      expect(finalSnap.data()).toEqual({ writtenAfterDelete: false });
    });
  });

  describe.each(['local', 'remote'] as const)('arm=%s: FieldPath special segment boundaries', (arm) => {
    it('preserves literal dots, slashes, and special characters in FieldPath across where and orderBy without spoofing raw backtick strings', async () => {
      const h = createHarness(arm);
      const app = h.createApp(`fieldpath-${arm}`);
      const db = getFirestore(app);

      await db.doc('items/doc-1').set({
        'meta.tag': 'alpha-literal',
        'a/b': 10,
        'a.b': { 'c/d': 'first' },
        'star*key': { 'bracket[0]': 'special-1' },
        '`meta': { 'tag`': 'backtick-nested' },
        meta: { tag: 'zzz-nested' },
      });
      await db.doc('items/doc-2').set({
        'meta.tag': 'omega-literal',
        'a/b': 20,
        'a.b': { 'c/d': 'second' },
        'star*key': { 'bracket[0]': 'special-2' },
        meta: { tag: 'aaa-nested' },
      });

      const dotSnap = await db.collection('items').where(new FieldPath('meta.tag'), '==', 'alpha-literal').get();
      expect(dotSnap.docs.map((d) => d.id)).toEqual(['doc-1']);

      const slashSnap = await db.collection('items').where(new FieldPath('a.b', 'c/d'), '==', 'second').get();
      expect(slashSnap.docs.map((d) => d.id)).toEqual(['doc-2']);

      const specialSnap = await db
        .collection('items')
        .where(new FieldPath('star*key', 'bracket[0]'), '==', 'special-1')
        .get();
      expect(specialSnap.docs.map((d) => d.id)).toEqual(['doc-1']);

      const rawBacktickFalse = await db.collection('items').where('`meta.tag`', '==', 'alpha-literal').get();
      expect(rawBacktickFalse.docs.map((d) => d.id)).toEqual([]);
      const rawBacktickNested = await db.collection('items').where('`meta.tag`', '==', 'backtick-nested').get();
      expect(rawBacktickNested.docs.map((d) => d.id)).toEqual(['doc-1']);

      const orderedSlash = await db.collection('items').orderBy(new FieldPath('a/b'), 'desc').get();
      expect(orderedSlash.docs.map((d) => d.id)).toEqual(['doc-2', 'doc-1']);

      const orderedMeta = await db.collection('items').orderBy(new FieldPath('meta.tag'), 'asc').get();
      expect(orderedMeta.docs.map((d) => d.id)).toEqual(['doc-1', 'doc-2']);
    });
  });

  describe.each(['local', 'remote'] as const)('arm=%s: runTransaction retry exhaustion parity', (arm) => {
    it('rejects contended transactions after maxAttempts with code aborted while preserving failed-precondition for read-after-write', async () => {
      const h = createHarness(arm);
      const app = h.createApp(`txn-${arm}`);
      const db = getFirestore(app);

      await db.doc('items/counter').set({ count: 0 });

      let markReadComplete!: () => void;
      const readCompleted = new Promise<void>((resolve) => {
        markReadComplete = resolve;
      });
      let unblockCommit!: () => void;
      const commitGate = new Promise<void>((resolve) => {
        unblockCommit = resolve;
      });

      const contendedPromise = db.runTransaction(
        async (tx) => {
          const snap = await tx.get(db.doc('items/counter'));
          markReadComplete();
          await commitGate;
          const current = (snap.data()?.count as number | undefined) ?? 0;
          tx.set(db.doc('items/counter'), { count: current + 1 });
        },
        { maxAttempts: 1 },
      );

      await readCompleted;
      await db.doc('items/counter').set({ count: 99 });
      unblockCommit();

      expect(await rejectedWithCode(() => contendedPromise)).toBe('aborted');
      expect((await db.doc('items/counter').get()).data()).toEqual({ count: 99 });

      expect(
        await rejectedWithCode(() =>
          db.runTransaction(async (tx) => {
            tx.set(db.doc('items/order-1'), { total: 10 });
            await tx.get(db.doc('items/order-1'));
          }),
        ),
      ).toBe('failed-precondition');
    });
  });

  describe('Timestamp finite integer validation differential & dual-arm wire parity', () => {
    it('matches firebase-admin/firestore Timestamp validation on NaN, Infinity, fractional, and out-of-range inputs', () => {
      const invalidPairs: ReadonlyArray<readonly [number, number]> = [
        [Number.NaN, 0],
        [0, Number.NaN],
        [Number.POSITIVE_INFINITY, 0],
        [Number.NEGATIVE_INFINITY, 0],
        [0, Number.POSITIVE_INFINITY],
        [1.5, 0],
        [0, 2.25],
        [0, -1],
        [0, 1_000_000_000],
        [-62_135_596_801, 0],
        [253_402_300_800, 0],
      ];

      for (const [sec, nano] of invalidPairs) {
        let upstreamThrew = false;
        try {
          new upstreamAdminFirestore.Timestamp(sec, nano);
        } catch {
          upstreamThrew = true;
        }
        expect(upstreamThrew).toBe(true);
        expect(() => new Timestamp(sec, nano)).toThrow();
      }

      expect(() => Timestamp.fromMillis(Number.NaN)).toThrow();
      expect(() => Timestamp.fromMillis(Number.POSITIVE_INFINITY)).toThrow();
      expect(() => Timestamp.fromDate(new Date('invalid-date'))).toThrow();

      const validUpstream = new upstreamAdminFirestore.Timestamp(1_700_000_000, 123_000_000);
      const validPyric = new Timestamp(1_700_000_000, 123_000_000);
      expect(validPyric.seconds).toBe(validUpstream.seconds);
      expect(validPyric.nanoseconds).toBe(validUpstream.nanoseconds);
      expect(validPyric.toMillis()).toBe(validUpstream.toMillis());
      expect(new Timestamp(1_700_000_000, 123_456_789).toJSON()).toEqual({
        type: 'firestore/timestamp/1.0',
        seconds: 1_700_000_000,
        nanoseconds: 123_456_789,
      });
    });

    it.each(['local', 'remote'] as const)(
      'arm=%s: rejects forged non-finite Timestamp instances and invalid wire markers instead of coercing to 1970-01-01T00:00:00Z',
      async (arm) => {
        const h = createHarness(arm);
        const app = h.createApp(`ts-${arm}`);
        const db = getFirestore(app);

        const forgedNan = Object.assign(Object.create(Timestamp.prototype), {
          seconds: Number.NaN,
          nanoseconds: 0,
        }) as Timestamp;

        expect(
          await rejectedWithCode(() => db.doc('items/bad-ts').set({ createdAt: forgedNan })),
        ).toBe('invalid-argument');
        expect((await db.doc('items/bad-ts').get()).exists).toBe(false);

        if (arm === 'remote' && h.ctx !== undefined) {
          let hostErrorCode: string | undefined;
          const capturePort: PortLike = {
            postMessage(raw: unknown) {
              const out = raw as OutboundMessage;
              if (out.t === 'res' && !out.ok) {
                hostErrorCode = out.error.code;
              }
            },
          };
          await handleMessage(h.ctx, capturePort, {
            t: 'op',
            id: 'op-999',
            method: 'setDoc',
            path: 'items/bad-wire-marker',
            lens: { mode: 'admin' },
            data: {
              createdAt: {
                type: 'firestore/timestamp/1.0',
                seconds: null,
                nanoseconds: 0,
              },
            },
          } as unknown as InboundMessage);
          expect(hostErrorCode).toBe('invalid-argument');
          expect((await db.doc('items/bad-wire-marker').get()).exists).toBe(false);
        }
      },
    );
  });

  describe('Storage negative end suffix byte ranges differential & dual-arm parity', () => {
    it.each(['local', 'remote'] as const)(
      'arm=%s: treats negative end options as tail byte counts matching @google-cloud/storage across download and createReadStream',
      async (arm) => {
        const upApp = upstreamAdminApp.initializeApp({ projectId: 'project-alpha' }, `up-range-${arm}`);
        const upFile = upstreamAdminStorage.getStorage(upApp).bucket('assets-bucket').file('docs/digits.txt') as unknown as {
          createReadStream(opts?: { start?: number; end?: number }): NodeJS.ReadableStream;
          requestStream: (reqOpts: { headers?: Record<string, string> }) => NodeJS.ReadableStream;
        };
        const capturedRanges: Array<string | undefined> = [];
        upFile.requestStream = (reqOpts) => {
          capturedRanges.push(reqOpts.headers?.Range);
          const stream = new PassThrough();
          queueMicrotask(() => {
            const responseStream = Object.assign(new PassThrough(), {
              statusCode: 206,
              headers: {},
              toJSON: () => ({ headers: {} }),
            });
            stream.emit('response', responseStream);
            responseStream.end();
          });
          return stream;
        };
        for (const opts of [{ start: 2, end: 5 }, { end: -4 }, { end: -1 }]) {
          for await (const _chunk of upFile.createReadStream(opts)) {
            // drain lazy stream to trigger upstream Range header construction
          }
        }
        expect(capturedRanges).toEqual(['bytes=2-5', 'bytes=-4', 'bytes=-1']);

        const h = createHarness(arm);
        const app = h.createApp(`range-${arm}`, { storageBucket: 'assets-bucket' });
        const file = getStorage(app).bucket().file('docs/digits.txt');
        await file.save('0123456789');

        const [posSlice] = await file.download({ start: 2, end: 5 });
        expect(posSlice.toString('utf8')).toBe('2345');

        const [tail4] = await file.download({ end: -4 });
        expect(tail4.toString('utf8')).toBe('6789');

        const [tail1] = await file.download({ end: -1 });
        expect(tail1.toString('utf8')).toBe('9');

        const [tailClamped] = await file.download({ end: -50 });
        expect(tailClamped.toString('utf8')).toBe('0123456789');

        const streamChunks: Buffer[] = [];
        for await (const chunk of file.createReadStream({ end: -4 })) {
          streamChunks.push(Buffer.from(chunk as Uint8Array));
        }
        expect(Buffer.concat(streamChunks).toString('utf8')).toBe('6789');
      },
    );
  });

  describe('Storage bucket(name) validation and gs:// normalization differential & dual-arm parity', () => {
    it.each(['local', 'remote'] as const)(
      'arm=%s: rejects empty/invalid bucket names with storage/invalid-argument and normalizes gs:// prefix and trailing slashes matching firebase-admin/storage',
      async (arm) => {
        const upApp = upstreamAdminApp.initializeApp({ projectId: 'project-alpha' }, `up-bucket-${arm}`);
        const upStorage = upstreamAdminStorage.getStorage(upApp);

        expect(await rejectedWithCode(() => upStorage.bucket(''))).toBe('storage/invalid-argument');
        expect(await rejectedWithCode(() => upStorage.bucket(null as unknown as string))).toBe(
          'storage/invalid-argument',
        );
        expect(upStorage.bucket('gs://assets-bucket/').name).toBe('assets-bucket');
        expect(upStorage.bucket('assets-bucket///').name).toBe('assets-bucket');

        const h = createHarness(arm);
        const app = h.createApp(`bucket-${arm}`);
        const storage = getStorage(app);

        for (const bad of ['', 'gs://', '/', '///', 'gs:///', null as unknown as string]) {
          expect(await rejectedWithCode(() => storage.bucket(bad))).toBe('storage/invalid-argument');
        }

        const gsBucket = storage.bucket('gs://assets-bucket/');
        const slashBucket = storage.bucket('assets-bucket///');
        const plainBucket = storage.bucket('assets-bucket');
        expect(gsBucket.name).toBe('assets-bucket');
        expect(slashBucket.name).toBe('assets-bucket');

        await gsBucket.file('docs/item.txt').save('normalized-payload');
        const [downloaded] = await plainBucket.file('docs/item.txt').download();
        expect(downloaded.toString('utf8')).toBe('normalized-payload');

        const [meta] = await gsBucket.file('docs/item.txt').getMetadata();
        expect(meta.bucket).toBe('assets-bucket');

        const [signedUrl] = await gsBucket
          .file('docs/item.txt')
          .getSignedUrl({ action: 'read', expires: 1_800_000_000_000 });
        expect(signedUrl).toBe(
          'pyric-sandbox-storage://assets-bucket/docs/item.txt?expires=1800000000000&action=read',
        );

        const configuredGsApp = h.createApp(`bucket-opt-${arm}`, {
          storageBucket: 'gs://team-bucket/',
        });
        expect(getStorage(configuredGsApp).bucket().name).toBe('team-bucket');

        // Lazy validation of app.options.storageBucket: getStorage(app) and explicit bucket('valid-bucket')
        // succeed even when storageBucket is invalid, while bare bucket() throws storage/invalid-argument.
        const badDefaultApp = h.createApp(`bucket-lazy-${arm}`, {
          storageBucket: 'gs://',
        });
        const badDefaultStorage = getStorage(badDefaultApp);
        expect(badDefaultStorage.bucket('valid-bucket').name).toBe('valid-bucket');
        expect(await rejectedWithCode(() => badDefaultStorage.bucket())).toBe(
          'storage/invalid-argument',
        );
      },
    );
  });

  describe('Storage default vs named bucket aliasing and File.copy metadata dual-arm parity', () => {
    it.each(['local', 'remote'] as const)(
      'arm=%s: preserves objects written to an explicit named bucket before a secondary app configures that storageBucket',
      async (arm) => {
        const h = createHarness(arm);
        const app1 = h.createApp(`alias-app1-${arm}`);
        await getStorage(app1).bucket('assets-bucket').file('docs/report.txt').save('v1');

        const app2 = h.createApp(`alias-app2-${arm}`, { storageBucket: 'assets-bucket' });
        const st2 = getStorage(app2);

        expect(await st2.bucket().file('docs/report.txt').exists()).toEqual([true]);
        expect(
          await getStorage(app1).bucket('assets-bucket').file('docs/report.txt').exists(),
        ).toEqual([true]);
        const [bytes] = await st2.bucket().file('docs/report.txt').download();
        expect(bytes.toString('utf8')).toBe('v1');
        expect(await getStorage(app1).bucket().file('docs/report.txt').exists()).toEqual([false]);
      },
    );

    it.each(['local', 'remote'] as const)(
      'arm=%s: does not retroactively alias a secondary storageBucket to the default bucket once unconfigured bucket() has been used',
      async (arm) => {
        const h = createHarness(arm);
        const app1 = h.createApp(`used-default-app1-${arm}`);
        await getStorage(app1).bucket().file('docs/def.txt').save('from-default');

        const app2 = h.createApp(`used-default-app2-${arm}`, {
          storageBucket: 'secondary-bucket',
        });
        expect(await getStorage(app2).bucket().file('docs/def.txt').exists()).toEqual([false]);
        expect(await getStorage(app1).bucket().file('docs/def.txt').exists()).toEqual([true]);
      },
    );

    it.each(['local', 'remote'] as const)(
      'arm=%s: stamps destination bucket name on File.copy into explicit pyric-default from an app with custom storageBucket',
      async (arm) => {
        const h = createHarness(arm);
        const copyApp = h.createApp(`copy-app-${arm}`, { storageBucket: 'team-default' });
        const st = getStorage(copyApp);

        await st.bucket('staging-bucket').file('docs/src.txt').save('copy-me');
        const [copiedFile, copiedMeta] = await st
          .bucket('staging-bucket')
          .file('docs/src.txt')
          .copy(st.bucket('pyric-default').file('docs/dst.txt'));

        expect(copiedFile.bucket.name).toBe('pyric-default');
        expect(copiedMeta.bucket).toBe('pyric-default');
        const [readMeta] = await st.bucket('pyric-default').file('docs/dst.txt').getMetadata();
        expect(readMeta.bucket).toBe('pyric-default');
      },
    );

    it.each(['local', 'remote'] as const)(
      'arm=%s: cross-app File.copy honors destination app defaultBucket aliasing and rejects deleted destination apps',
      async (arm) => {
        const h = createHarness(arm);
        const appSource = h.createApp(`cross-copy-src-${arm}`);
        const appDest = h.createApp(`cross-copy-dst-${arm}`, { storageBucket: 'team-default' });

        const src = getStorage(appSource).bucket('staging-bucket').file('docs/src.txt');
        await src.save('cross-app-bytes');

        const dst = getStorage(appDest).bucket().file('docs/dst.txt');
        const [copiedFile, copiedMeta] = await src.copy(dst);

        expect(copiedFile.bucket.name).toBe('team-default');
        expect(copiedMeta.bucket).toBe('team-default');
        expect(await getStorage(appSource).bucket().file('docs/dst.txt').exists()).toEqual([true]);

        await deleteApp(appDest);
        expect(await rejectedWithCode(() => src.copy(dst))).toBe('app/app-deleted');
      },
    );
  });
});

import { describe, expect, it } from 'bun:test';
import { FirebaseError } from 'pyric/app';
import { getAuth as ipGetAuth } from 'pyric/auth';
import { getFirestore as ipGetFirestore } from 'pyric/firestore';
import { createMemoryBackend, initializeSandbox, type RemoteSandbox } from 'pyric/sandbox';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';
import { getStorageSandbox, ref as storageRef, uploadString } from 'pyric/storage';
import {
  FieldValue as AdminFieldValue,
} from 'pyric/sandbox/admin-firestore';
import { createRemoteFirestore } from '../../../../pyric/src/sandbox/admin-firestore/remote/remote-firestore.js';
import {
  mintCustomToken,
  SANDBOX_PROJECT_ID,
} from 'pyric/sandbox/internal';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import {
  DOC_VALUE_ENCODING,
  serializeDocData,
  type InboundMessage,
  type OutboundMessage,
  type ResMessage,
} from '../../../src/serve/worker/protocol.js';
import * as client from '../../../src/serve/worker/client.js';
import {
  disableNetwork,
  enableNetwork,
} from '../../../src/serve/worker/client/firestore-network.js';
import { projectWorkerOfflineDoc } from '../../../src/serve/worker/client/firestore-offline-projection.js';
import { makeHostCtx, type FakePort } from './integration-support.js';
import { restoreSharedWorker } from './oracle-captures/support.ts';

restoreSharedWorker();

const POW53_PLUS_1 = 9007199254740993n;

/**
 * Bidirectional port pair that runs every frame through JSON.stringify + JSON.parse,
 * exercising the exact double-JSON relay invariant of remote and WebSocket transports.
 */
function jsonPortPair(): { a: FakePort; b: FakePort } {
  const a: FakePort = { onmessage: null, postMessage() {}, start() {}, close() {}, addEventListener() {} };
  const b: FakePort = { onmessage: null, postMessage() {}, start() {}, close() {}, addEventListener() {} };
  a.postMessage = (msg) => {
    const wire = JSON.parse(JSON.stringify(msg));
    setTimeout(() => b.onmessage?.({ data: wire }), 0);
  };
  b.postMessage = (msg) => {
    const wire = JSON.parse(JSON.stringify(msg));
    setTimeout(() => a.onmessage?.({ data: wire }), 0);
  };
  return { a, b };
}

function connectJsonClientToHost(ctx: HostCtx, url: string) {
  const { a: clientPort, b: hostPort } = jsonPortPair();
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
  return {
    db: client.getFirestore(url),
    auth: client.getAuth(url),
    storage: client.getStorage(url),
  };
}

/** Remote sandbox channel backed directly by handleMessage with strict JSON round-tripping. */
function makeJsonRemoteSandbox(ctx: HostCtx): RemoteSandbox {
  let seq = 0;
  const channel = {
    async op(payload: Record<string, unknown>): Promise<unknown> {
      const id = `remote-op-${++seq}`;
      const wireFrame = JSON.parse(JSON.stringify({ t: 'op', id, relaySource: 'remote', ...payload }));
      let reply: ResMessage | undefined;
      const port: PortLike = {
        postMessage(message: OutboundMessage) {
          const roundTripped = JSON.parse(JSON.stringify(message)) as OutboundMessage;
          if (roundTripped.t === 'res' && roundTripped.id === id) {
            reply = roundTripped;
          }
        },
      };
      await handleMessage(ctx, port, wireFrame as InboundMessage);
      if (reply === undefined) throw new Error(`Missing host reply for ${id}`);
      if (!reply.ok) {
        const err = new FirebaseError(reply.error.code, reply.error.message);
        throw err;
      }
      return reply.value;
    },
    subscribe(): () => void {
      return () => undefined;
    },
  };
  const remoteBrand = Symbol.for('pyric.sandbox.remote');
  const remoteSandbox = {
    [remoteBrand]: true,
    channel,
    withAuth(auth: unknown) {
      return { sandbox: remoteSandbox, auth };
    },
  };
  return remoteSandbox as unknown as RemoteSandbox;
}

describe('#1794: -0, NaN, Infinity, -Infinity over worker bridge and remote-client relay', () => {
  const SPECIAL_FLOAT_RULES = `rules_version = '2';
    service cloud.firestore {
      match /databases/{database}/documents {
        match /nums/{id} {
          allow write: if true;
          allow read: if resource.data.negZero is float
            && !(resource.data.negZero is int)
            && resource.data.negZero is number
            && resource.data.negZero != null
            && string(resource.data.negZero) == '-0.0'
            && resource.data.nan is float
            && !(resource.data.nan is int)
            && resource.data.nan is number
            && resource.data.nan != null
            && resource.data.posInf is float
            && !(resource.data.posInf is int)
            && resource.data.posInf is number
            && resource.data.posInf != null
            && resource.data.negInf is float
            && !(resource.data.negInf is int)
            && resource.data.negInf is number
            && resource.data.negInf != null;
        }
      }
    }`;

  it('round-trips all four special floats through worker bridge getDoc, onSnapshot, increment, and rules', async () => {
    const host = await makeHostCtx();
    setFirestoreRules(host.sandbox, SPECIAL_FLOAT_RULES);
    try {
      const { db } = connectJsonClientToHost(host, 'worker://special-floats-bridge');
      const directRef = client.doc(db, 'nums/direct');
      await client.setDoc(directRef, {
        negZero: -0,
        nan: Number.NaN,
        posInf: Number.POSITIVE_INFINITY,
        negInf: Number.NEGATIVE_INFINITY,
      });

      const incRef = client.doc(db, 'nums/inc');
      await client.setDoc(incRef, {
        negZero: client.increment(-0),
        nan: client.increment(Number.NaN),
        posInf: client.increment(Number.POSITIVE_INFINITY),
        negInf: client.increment(Number.NEGATIVE_INFINITY),
      });

      for (const ref of [directRef, incRef]) {
        const snap = await client.getDoc(ref);
        expect(snap.exists()).toBe(true);
        const data = snap.data() as Record<string, unknown>;
        expect(Object.is(data.negZero, -0)).toBe(true);
        expect(Number.isNaN(data.nan)).toBe(true);
        expect(data.posInf).toBe(Number.POSITIVE_INFINITY);
        expect(data.negInf).toBe(Number.NEGATIVE_INFINITY);
      }

      const delivered = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const unsub = client.onSnapshot(
          directRef,
          (snap) => {
            if (snap.exists()) {
              unsub();
              resolve(snap.data() as Record<string, unknown>);
            }
          },
          (error) => {
            unsub();
            reject(error);
          },
        );
      });
      expect(Object.is(delivered.negZero, -0)).toBe(true);
      expect(Number.isNaN(delivered.nan)).toBe(true);
      expect(delivered.posInf).toBe(Number.POSITIVE_INFINITY);
      expect(delivered.negInf).toBe(Number.NEGATIVE_INFINITY);
    } finally {
      host.sandbox.dispose();
    }
  });

  it('round-trips all four special floats through the remote-client relay for direct writes and FieldValue.increment', async () => {
    const host = await makeHostCtx();
    setFirestoreRules(host.sandbox, SPECIAL_FLOAT_RULES);
    try {
      const remoteSandbox = makeJsonRemoteSandbox(host);
      const remoteDb = createRemoteFirestore(remoteSandbox, { mode: 'anon' });

      await remoteDb.doc('nums/remoteDirect').set({
        negZero: -0,
        nan: Number.NaN,
        posInf: Number.POSITIVE_INFINITY,
        negInf: Number.NEGATIVE_INFINITY,
      });
      await remoteDb.doc('nums/remoteInc').set({
        negZero: AdminFieldValue.increment(-0),
        nan: AdminFieldValue.increment(Number.NaN),
        posInf: AdminFieldValue.increment(Number.POSITIVE_INFINITY),
        negInf: AdminFieldValue.increment(Number.NEGATIVE_INFINITY),
      });

      for (const docPath of ['nums/remoteDirect', 'nums/remoteInc']) {
        const snap = await remoteDb.doc(docPath).get();
        expect(snap.exists).toBe(true);
        const data = snap.data() as Record<string, unknown>;
        expect(Object.is(data.negZero, -0)).toBe(true);
        expect(Number.isNaN(data.nan)).toBe(true);
        expect(data.posInf).toBe(Number.POSITIVE_INFINITY);
        expect(data.negInf).toBe(Number.NEGATIVE_INFINITY);
      }
    } finally {
      host.sandbox.dispose();
    }
  });
});

describe('#1816 and #1430 over the worker bridge, transactions, offline projection, and legacy encoding', () => {
  it('increments across 2^53, commits transactions without phantom aborts, and rejects bigint writes/queries', async () => {
    const host = await makeHostCtx();
    setFirestoreRules(
      host.sandbox,
      `rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /counters/{id} {
            allow create: if request.resource.data.n is int;
            allow update: if request.resource.data.n is int
              && !(request.resource.data.n is float)
              && (request.resource.data.n == 9007199254740992
                || request.resource.data.n == 9007199254740993
                || request.resource.data.n == 9007199254740994);
            allow read: if resource.data.n is int
              && resource.data.n == 9007199254740993;
          }
        }
      }`,
    );
    try {
      const { db } = connectJsonClientToHost(host, 'worker://int64-bridge');
      const ref = client.doc(db, 'counters/c1');

      // #1430: worker client rejects bigint on writes and queries.
      await expect(client.setDoc(ref, { n: 1n })).rejects.toMatchObject({ code: 'invalid-argument' });
      expect(() => client.updateDoc(ref, { n: 1n })).toThrow(FirebaseError);
      expect(() =>
        client.query(client.collection(db, 'counters'), client.where('n', '==', 1n)),
      ).toThrow(FirebaseError);

      // #1816: increment across 2^53 -> 2^53 + 1.
      await client.setDoc(ref, { n: Number.MAX_SAFE_INTEGER, tag: 'v0' });
      await client.updateDoc(ref, { n: client.increment(1) });
      await client.updateDoc(ref, { n: client.increment(1) });

      const snap = await client.getDoc(ref);
      expect(snap.exists()).toBe(true);
      expect(typeof snap.data()?.n).toBe('number');

      // Transaction reading a stored 2^53 + 1 int64 commits cleanly without phantom abort.
      await client.runTransaction(db, async (tx) => {
        const current = await tx.get(ref);
        expect(current.exists()).toBe(true);
        expect(typeof current.data()?.n).toBe('number');
        tx.update(ref, { tag: 'v1' });
      });

      const updated = await client.getDoc(ref);
      expect(updated.data()?.tag).toBe('v1');

      // Offline projection across 2^53 keeps exact int64 marker.
      const projected = projectWorkerOfflineDoc(
        'counters/offline',
        { valueEncoding: DOC_VALUE_ENCODING, json: JSON.stringify({ n: Number.MAX_SAFE_INTEGER }) },
        [
          { mutations: [{ kind: 'update', path: 'counters/offline', fields: [{ path: ['n'], value: { __sentinel: 'increment', n: 2 } }] }] },
        ],
      );
      expect(projected.result.data?.json).toBe('{"n":{"__type":"int64","value":"9007199254740993"}}');

      // Legacy protocol-1 encoding unwraps int64 marker to a plain JSON number.
      const legacy = serializeDocData({ n: POW53_PLUS_1 }, 'legacy');
      expect(legacy.valueEncoding).toBeUndefined();
      expect(JSON.parse(legacy.json)).toEqual({ n: Number(POW53_PLUS_1) });
    } finally {
      host.sandbox.dispose();
    }
  });

  it('allows querying valid plain user maps shaped like int64 markers while rejecting nested bigints', async () => {
    const host = await makeHostCtx();
    setFirestoreRules(
      host.sandbox,
      `rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /maps/{id} {
            allow read, write: if true;
          }
        }
      }`,
    );
    try {
      const { db } = connectJsonClientToHost(host, 'worker://int64-marker-map-query');
      const markerMap = { __type: 'int64', value: '42' };
      const ref = client.doc(db, 'maps/m1');
      await client.setDoc(ref, { m: markerMap });

      const snap = await client.getDoc(ref);
      expect(snap.exists()).toBe(true);
      expect(snap.data()).toEqual({ m: markerMap });

      const matched = await client.getDocs(
        client.query(client.collection(db, 'maps'), client.where('m', '==', markerMap)),
      );
      expect(matched.docs.map((d) => d.id)).toEqual(['m1']);

      let nestedBigIntErr: unknown;
      try {
        client.query(
          client.collection(db, 'maps'),
          client.where('m', '==', { __type: 'int64', value: 1n }),
        );
      } catch (error) {
        nestedBigIntErr = error;
      }
      expect(nestedBigIntErr).toBeInstanceOf(FirebaseError);
      expect((nestedBigIntErr as FirebaseError).code).toBe('invalid-argument');
    } finally {
      host.sandbox.dispose();
    }
  });

  it('rejects bigint synchronously in worker writeBatch.set / tx.set and immediately in offline setDoc / addDoc', async () => {
    const host = await makeHostCtx();
    setFirestoreRules(
      host.sandbox,
      `rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /items/{id} {
            allow read, write: if true;
          }
        }
      }`,
    );
    try {
      const { db } = connectJsonClientToHost(host, 'worker://bigint-client-validation');
      const ref = client.doc(db, 'items/i1');

      const batch = client.writeBatch(db);
      let batchDirectErr: unknown;
      try {
        batch.set(ref, { v: 1n });
      } catch (error) {
        batchDirectErr = error;
      }
      expect(batchDirectErr).toBeInstanceOf(FirebaseError);
      expect((batchDirectErr as FirebaseError).code).toBe('invalid-argument');

      let batchSentinelErr: unknown;
      try {
        batch.set(ref, { v: client.increment(1n as unknown as number) });
      } catch (error) {
        batchSentinelErr = error;
      }
      expect(batchSentinelErr).toBeInstanceOf(FirebaseError);
      expect((batchSentinelErr as FirebaseError).code).toBe('invalid-argument');

      let batchArrayUnionErr: unknown;
      try {
        batch.set(ref, { v: client.arrayUnion(1n) });
      } catch (error) {
        batchArrayUnionErr = error;
      }
      expect(batchArrayUnionErr).toBeInstanceOf(FirebaseError);
      expect((batchArrayUnionErr as FirebaseError).code).toBe('invalid-argument');

      let txSyncErr: unknown;
      await client.runTransaction(db, async (tx) => {
        try {
          tx.set(ref, { v: 1n });
        } catch (error) {
          txSyncErr = error;
        }
      });
      expect(txSyncErr).toBeInstanceOf(FirebaseError);
      expect((txSyncErr as FirebaseError).code).toBe('invalid-argument');

      await disableNetwork(db);
      await expect(client.setDoc(ref, { v: 1n })).rejects.toMatchObject({ code: 'invalid-argument' });
      await expect(
        client.addDoc(client.collection(db, 'items'), { nested: { v: 1n } }),
      ).rejects.toMatchObject({ code: 'invalid-argument' });
      await enableNetwork(db);

      const afterReconnect = await client.getDoc(ref);
      expect(afterReconnect.exists()).toBe(false);
    } finally {
      host.sandbox.dispose();
    }
  });
});

describe('#1817 over the worker bridge for Firestore and Storage rules', () => {
  it('delivers exact 2^53 + 1 custom token claims to both Firestore and Storage rules and serializes getIdTokenResult over JSON', async () => {
    const sandbox = initializeSandbox();
    const hostStorage = getStorageSandbox(sandbox, {
      dbName: `worker-int64-claims-${Math.random().toString(36).slice(2, 8)}`,
      rules: `rules_version = '2';
      service firebase.storage {
        match /b/{bucket}/o {
          match /claims/exact.txt {
            allow write: if true;
            allow read: if request.auth.token.n is int
              && !(request.auth.token.n is float)
              && request.auth.token.n == 9007199254740993
              && request.auth.token.n != 9007199254740992;
          }
          match /claims/deny.txt {
            allow write: if true;
            allow read: if request.auth.token.n != 9007199254740993;
          }
        }
      }`,
    });
    ipGetAuth(sandbox);
    const host: HostCtx = {
      db: ipGetFirestore(sandbox),
      sandbox,
      subs: new Map(),
      sessionMode: 'LOCAL',
      sessionBackend: createMemoryBackend(),
      flushPersistence: async () => undefined,
    };
    setFirestoreRules(
      host.sandbox,
      `rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /claims/exact {
            allow write: if true;
            allow get: if request.auth.token.n is int
              && !(request.auth.token.n is float)
              && request.auth.token.n == 9007199254740993
              && request.auth.token.n != 9007199254740992;
          }
          match /claims/mustDeny {
            allow write: if true;
            allow get: if request.auth.token.n != 9007199254740993;
          }
        }
      }`,
    );
    await uploadString(storageRef(hostStorage, 'claims/exact.txt'), 'ok');
    await uploadString(storageRef(hostStorage, 'claims/deny.txt'), 'nope');
    try {
      const { db, auth, storage } = connectJsonClientToHost(host, 'worker://int64-claims-bridge');
      await client.setDoc(client.doc(db, 'claims/exact'), { ok: true });
      await client.setDoc(client.doc(db, 'claims/mustDeny'), { ok: true });

      const customToken = mintCustomToken({
        uid: 'bridge-int64-user',
        projectId: SANDBOX_PROJECT_ID,
        nowMs: Date.now(),
        claims: { n: POW53_PLUS_1 },
      });
      const cred = await client.signInWithCustomToken(auth, customToken);
      const tokenResult = await cred.user.getIdTokenResult();
      expect(typeof tokenResult.claims.n).toBe('number');
      const jwtPayload = Buffer.from(tokenResult.token.split('.')[1] ?? '', 'base64url').toString('utf8');
      expect(jwtPayload).toContain('"n":9007199254740993');

      expect((await client.getDoc(client.doc(db, 'claims/exact'))).exists()).toBe(true);
      await expect(client.getDoc(client.doc(db, 'claims/mustDeny'))).rejects.toThrow();

      const downloaded = await client.getBytes(client.ref(storage, 'claims/exact.txt'));
      expect(new TextDecoder().decode(downloaded)).toBe('ok');
      await expect(client.getBytes(client.ref(storage, 'claims/deny.txt'))).rejects.toThrow();
    } finally {
      host.sandbox.dispose();
    }
  });
});

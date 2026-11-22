import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import {
  addDoc,
  arrayRemove,
  arrayUnion,
  average,
  collection,
  doc,
  getAdminFirestore,
  getAggregateFromServer,
  getDoc,
  getDocs,
  getFirestore,
  increment,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  setDoc,
  sum,
  updateDoc,
  where,
  writeBatch,
  type FirestoreDataConverter,
} from 'pyric/firestore';
import { getAuth, signInWithCustomToken } from 'pyric/auth';
import { getBytes, getStorageSandbox, ref as storageRef, uploadString } from 'pyric/storage';
import { getFirestore as getAdminCompatFirestore } from 'pyric/sandbox/admin-firestore';
import {
  captureSandboxSnapshot,
  checkIdToken,
  encodeJson,
  mintCustomToken,
  restoreSandboxSnapshot,
  sandboxSignatureSync,
  SANDBOX_PROJECT_ID,
} from 'pyric/sandbox/internal';
import {
  decodeStateDocument,
  encodeStateDocument,
} from '../../src/sandbox/internal/state-values.js';
import { DOC_VALUE_ENCODING } from '../../src/firestore/internal/value-codec.js';
import { decodeOidcIdTokenClaims } from '../../src/auth/sandbox/oidc-jwt-credential.js';

const POW53_PLUS_1 = 9007199254740993n;
const INT64_MAX = 9223372036854775807n;
const INT64_MIN = -9223372036854775808n;

function setFirestoreRules(sandbox: ReturnType<typeof initializeSandbox>, rules: string): void {
  getAdminCompatFirestore(sandbox.withAuth(null)).setRules(rules);
}

function storageWithRules(sandbox: ReturnType<typeof initializeSandbox>, label: string, rules: string) {
  return getStorageSandbox(sandbox, {
    dbName: `int64-${label}-${Math.random().toString(36).slice(2, 8)}`,
    rules,
  });
}

async function expectInvalidArgument(run: () => unknown): Promise<void> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect((caught as { code?: unknown }).code).toBe('invalid-argument');
}

describe('#1430: Web SDK rejects bigint field values while query engine compares stored int64 exactly', () => {
  test('rejects bigint across setDoc, addDoc, updateDoc, writeBatch, runTransaction, and sentinels', async () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox);
    const ref = doc(db, 'b/x');
    const coll = collection(db, 'b');

    await expectInvalidArgument(() => setDoc(ref, { v: 1n }));
    await expectInvalidArgument(() => setDoc(ref, { nested: { v: 1n } }));
    await expectInvalidArgument(() => setDoc(ref, { arr: [1, 2n] }));
    await expectInvalidArgument(() => setDoc(ref, { arr: arrayUnion(1n) }));
    await expectInvalidArgument(() => setDoc(ref, { arr: arrayRemove(1n) }));
    await expectInvalidArgument(() => setDoc(ref, { n: increment(1n as unknown as number) }));
    await expectInvalidArgument(() => addDoc(coll, { v: 1n }));
    await expectInvalidArgument(() => updateDoc(ref, { v: 1n }));
    await expectInvalidArgument(() => updateDoc(ref, 'v', 1n));

    const batch = writeBatch(db);
    await expectInvalidArgument(() => batch.set(ref, { v: 1n }));
    await expectInvalidArgument(() => batch.update(ref, { v: 1n }));

    await setDoc(ref, { v: 0 });
    await expectInvalidArgument(() =>
      runTransaction(db, async (tx) => {
        await tx.get(ref);
        tx.set(ref, { v: 1n });
      }),
    );
    await expectInvalidArgument(() =>
      runTransaction(db, async (tx) => {
        await tx.get(ref);
        tx.update(ref, { v: 1n });
      }),
    );
  });

  test('distinguishes stored int64 values past 2^53 in queries and returns numbers from Web SDK reads', async () => {
    const sandbox = initializeSandbox();
    const db = getFirestore(sandbox);
    const adminDb = getAdminFirestore(sandbox);

    await setDoc(doc(db, 'items/a'), { n: Number.MAX_SAFE_INTEGER });
    await updateDoc(doc(db, 'items/a'), { n: increment(1) });

    await setDoc(doc(db, 'items/b'), { n: Number.MAX_SAFE_INTEGER });
    await updateDoc(doc(db, 'items/b'), { n: increment(1) });
    await updateDoc(doc(db, 'items/b'), { n: increment(1) });

    await expectInvalidArgument(() => setDoc(doc(adminDb, 'items/overflow'), { n: INT64_MAX + 1n }));

    const eqPow53 = await getDocs(query(collection(db, 'items'), where('n', '==', 2 ** 53)));
    expect(eqPow53.docs.map((d) => d.id)).toEqual(['a']);

    const gtPow53 = await getDocs(query(collection(db, 'items'), where('n', '>', 2 ** 53)));
    expect(gtPow53.docs.map((d) => d.id)).toEqual(['b']);

    const ordered = await getDocs(query(collection(db, 'items'), orderBy('n', 'desc')));
    expect(ordered.docs.map((d) => d.id)).toEqual(['b', 'a']);
    expect(typeof ordered.docs[0]?.data().n).toBe('number');
    expect(typeof ordered.docs[1]?.data().n).toBe('number');

    const converter: FirestoreDataConverter<{ n: number }> = {
      toFirestore: (v) => v,
      fromFirestore: (snap) => ({ n: Number(snap.data().n) }),
    };
    const converted = await getDocs(collection(db, 'items').withConverter(converter));
    expect(converted.size).toBe(2);

    const listenerIds = await new Promise<string[]>((resolve, reject) => {
      const unsub = onSnapshot(
        query(collection(db, 'items'), orderBy('n', 'asc')),
        (snap) => {
          unsub();
          resolve(snap.docs.map((d) => d.id));
        },
        (error) => {
          unsub();
          reject(error);
        },
      );
    });
    expect(listenerIds).toEqual(['a', 'b']);

    const agg = await getAggregateFromServer(collection(db, 'items'), {
      total: sum('n'),
      mean: average('n'),
    });
    expect(typeof agg.data().total).toBe('number');
    expect(typeof agg.data().mean).toBe('number');
  });
});

describe('#1816: increment() past 2^53 stays exact int64 through writes, persistence, and rules', () => {
  test('increments across 2^53 and -2^53, clamps at int64 bounds, and obeys float promotion', async () => {
    const sandbox = initializeSandbox();
    setFirestoreRules(
      sandbox,
      `rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /counters/pos {
            allow create: if request.resource.data.n is int;
            allow update: if request.resource.data.n is int
              && !(request.resource.data.n is float)
              && (request.resource.data.n == 9007199254740992
                || request.resource.data.n == 9007199254740993
                || request.resource.data.n == 9007199254740994
                || request.resource.data.n == 9007199254740991);
            allow get: if resource.data.n is int
              && (resource.data.n == 9007199254740993 || resource.data.n == 9007199254740991);
          }
          match /counters/neg {
            allow create: if request.resource.data.n is int;
            allow update: if request.resource.data.n is int
              && (request.resource.data.n == -9007199254740992
                || request.resource.data.n == -9007199254740993);
            allow get: if resource.data.n is int && resource.data.n == -9007199254740993;
          }
          match /counters/clampMax {
            allow write, get: if request.resource.data.n is int
              && request.resource.data.n == 9223372036854775807;
          }
          match /counters/clampMin {
            allow write, get: if request.resource.data.n is int
              && request.resource.data.n == -9223372036854775808;
          }
          match /counters/floatPrior {
            allow write: if request.resource.data.n is float && !(request.resource.data.n is int);
          }
          match /counters/floatDelta {
            allow create: if request.resource.data.n is int;
            allow update: if request.resource.data.n is float && !(request.resource.data.n is int);
          }
          match /counters/nested {
            allow create: if request.resource.data.stats.count is int;
            allow update: if request.resource.data.stats.count is int
              && request.resource.data.stats.count == 9007199254740993;
          }
        }
      }`,
    );
    const db = getFirestore(sandbox);
    const adminDb = getAdminFirestore(sandbox);

    // Positive crossing 2^53 - 1 -> 2^53 -> 2^53 + 1 via updateDoc, setDoc merge, batch, transaction.
    const posRef = doc(db, 'counters/pos');
    await setDoc(posRef, { n: Number.MAX_SAFE_INTEGER });
    await updateDoc(posRef, { n: increment(1) });
    await setDoc(posRef, { n: increment(1) }, { merge: true });
    const posSnap = await getDoc(posRef);
    expect(posSnap.exists()).toBe(true);
    expect(typeof posSnap.data()?.n).toBe('number');

    const batch = writeBatch(db);
    batch.update(posRef, { n: increment(1) });
    batch.update(posRef, { n: increment(-1) });
    await batch.commit();
    expect((await getDoc(posRef)).exists()).toBe(true);

    // Step back into safe integer range and back up via runTransaction.
    await runTransaction(db, async (tx) => {
      await tx.get(posRef);
      tx.update(posRef, { n: increment(-2) });
    });
    await runTransaction(db, async (tx) => {
      await tx.get(posRef);
      tx.update(posRef, { n: increment(2) });
    });
    expect((await getDoc(posRef)).exists()).toBe(true);

    // Negative crossing -(2^53 - 1) -> -2^53 -> -(2^53 + 1).
    const negRef = doc(db, 'counters/neg');
    await setDoc(negRef, { n: Number.MIN_SAFE_INTEGER });
    await updateDoc(negRef, { n: increment(-1) });
    await updateDoc(negRef, { n: increment(-1) });
    expect((await getDoc(negRef)).exists()).toBe(true);

    // Clamping at INT64_MAX and INT64_MIN.
    await setDoc(doc(adminDb, 'counters/clampMax'), { n: INT64_MAX });
    await updateDoc(doc(db, 'counters/clampMax'), { n: increment(10) });

    await setDoc(doc(adminDb, 'counters/clampMin'), { n: INT64_MIN });
    await updateDoc(doc(db, 'counters/clampMin'), { n: increment(-10) });

    // Float prior (2^53 written directly as double) + increment(1) stays float.
    await setDoc(doc(db, 'counters/floatPrior'), { n: 2 ** 53 });
    await updateDoc(doc(db, 'counters/floatPrior'), { n: increment(1) });

    // Int64 prior + float increment(0.5) becomes float.
    await setDoc(doc(adminDb, 'counters/floatDelta'), { n: POW53_PLUS_1 });
    await updateDoc(doc(db, 'counters/floatDelta'), { n: increment(0.5) });

    // Nested field path increment past 2^53.
    await setDoc(doc(db, 'counters/nested'), { stats: { count: Number.MAX_SAFE_INTEGER } });
    await updateDoc(doc(db, 'counters/nested'), { 'stats.count': increment(2) });
  });

  test('survives persistence reload, snapshot export/restore, event history, and Storage firestore.get', async () => {
    const backend = createMemoryBackend();
    const persistenceKey = 'int64-reload-test';
    const fsRules = `rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /counters/{id} {
            allow create, update: if request.resource.data.n is int;
            allow get: if resource.data.n is int
              && !(resource.data.n is float)
              && resource.data.n == 9007199254740993
              && resource.data.n != 9007199254740992;
          }
        }
      }`;

    const s1 = initializeSandbox();
    setFirestoreRules(s1, fsRules);
    await s1.enablePersistence({ key: persistenceKey, injectedBackend: backend });
    const db1 = getFirestore(s1);
    await setDoc(doc(db1, 'counters/c1'), { n: Number.MAX_SAFE_INTEGER });
    await updateDoc(doc(db1, 'counters/c1'), { n: increment(2) });
    expect(s1.history().length).toBeGreaterThan(0);

    const exported = await captureSandboxSnapshot(s1);
    await s1.flush();

    // Persistence reload into a brand-new sandbox.
    const s2 = initializeSandbox();
    setFirestoreRules(s2, fsRules);
    await s2.enablePersistence({ key: persistenceKey, injectedBackend: backend });
    const reloaded = await getDoc(doc(getFirestore(s2), 'counters/c1'));
    expect(reloaded.exists()).toBe(true);
    expect(typeof reloaded.data()?.n).toBe('number');

    // Cross-service Storage rules lookup via firestore.get().
    const storage2 = storageWithRules(
      s2,
      'fs-lookup',
      `rules_version = '2';
      service firebase.storage {
        match /b/{bucket}/o {
          match /files/{name} {
            allow write: if true;
            allow read: if firestore.get(/databases/(default)/documents/counters/c1).data.n is int
              && firestore.get(/databases/(default)/documents/counters/c1).data.n == 9007199254740993
              && firestore.get(/databases/(default)/documents/counters/c1).data.n != 9007199254740992;
          }
        }
      }`,
    );
    await uploadString(storageRef(storage2, 'files/check.txt'), 'ok');
    const bytes = await getBytes(storageRef(storage2, 'files/check.txt'));
    expect(new TextDecoder().decode(bytes)).toBe('ok');

    // Snapshot restore into a third sandbox.
    const s3 = initializeSandbox();
    setFirestoreRules(s3, fsRules);
    await restoreSandboxSnapshot(s3, exported);
    const restored = await getDoc(doc(getFirestore(s3), 'counters/c1'));
    expect(restored.exists()).toBe(true);
  });
});

describe('#1794: -0, NaN, Infinity, and -Infinity round-trip as floats through persistence and rules', () => {
  test('state-values codec and persistence reload keep all four values as floats in rules', async () => {
    const encoded = encodeStateDocument({
      negZero: -0,
      nan: Number.NaN,
      posInf: Number.POSITIVE_INFINITY,
      negInf: Number.NEGATIVE_INFINITY,
    });
    const decoded = decodeStateDocument(encoded, DOC_VALUE_ENCODING);
    expect(Object.is(decoded.negZero, -0)).toBe(true);
    expect(Number.isNaN(decoded.nan)).toBe(true);
    expect(decoded.posInf).toBe(Number.POSITIVE_INFINITY);
    expect(decoded.negInf).toBe(Number.NEGATIVE_INFINITY);

    const backend = createMemoryBackend();
    const key = 'special-floats-reload';
    const rules = `rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /nums/{id} {
            allow write: if true;
            allow get: if resource.data.negZero is float
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

    const s1 = initializeSandbox();
    setFirestoreRules(s1, rules);
    await s1.enablePersistence({ key, injectedBackend: backend });
    const db1 = getFirestore(s1);
    await setDoc(doc(db1, 'nums/direct'), {
      negZero: -0,
      nan: Number.NaN,
      posInf: Number.POSITIVE_INFINITY,
      negInf: Number.NEGATIVE_INFINITY,
    });
    await setDoc(doc(db1, 'nums/inc'), {
      negZero: increment(-0),
      nan: increment(Number.NaN),
      posInf: increment(Number.POSITIVE_INFINITY),
      negInf: increment(Number.NEGATIVE_INFINITY),
    });
    await s1.flush();

    const s2 = initializeSandbox();
    setFirestoreRules(s2, rules);
    await s2.enablePersistence({ key, injectedBackend: backend });
    const db2 = getFirestore(s2);

    for (const id of ['direct', 'inc']) {
      const snap = await getDoc(doc(db2, `nums/${id}`));
      expect(snap.exists()).toBe(true);
      const data = snap.data() as Record<string, unknown>;
      expect(Object.is(data.negZero, -0)).toBe(true);
      expect(Number.isNaN(data.nan)).toBe(true);
      expect(data.posInf).toBe(Number.POSITIVE_INFINITY);
      expect(data.negInf).toBe(Number.NEGATIVE_INFINITY);
    }
  });
});

describe('#1817: lossless int64 token claims across every path into Firestore and Storage rules', () => {
  test('preserves 2^53 + 1 via custom token sign-in in both Firestore and Storage rules', async () => {
    const sandbox = initializeSandbox();
    const auth = getAuth(sandbox);

    const firestoreRules = `rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /claims/exact {
            allow get: if request.auth.token.n is int
              && !(request.auth.token.n is float)
              && request.auth.token.n == 9007199254740993
              && request.auth.token.n != 9007199254740992
              && request.auth.token.nested.max == 9223372036854775807
              && request.auth.token.nested.min == -9223372036854775808
              && request.auth.token.pastInt64 is float;
          }
          match /claims/mustDeny {
            allow get: if request.auth.token.n != 9007199254740993;
          }
        }
      }`;
    const storageRules = `rules_version = '2';
      service firebase.storage {
        match /b/{bucket}/o {
          match /exact/file.txt {
            allow write: if true;
            allow read: if request.auth.token.n is int
              && !(request.auth.token.n is float)
              && request.auth.token.n == 9007199254740993
              && request.auth.token.n != 9007199254740992
              && request.auth.token.nested.max == 9223372036854775807
              && request.auth.token.nested.min == -9223372036854775808
              && request.auth.token.pastInt64 is float;
          }
          match /deny/file.txt {
            allow write: if true;
            allow read: if request.auth.token.n != 9007199254740993;
          }
        }
      }`;

    setFirestoreRules(sandbox, firestoreRules);
    const storage = storageWithRules(sandbox, 'claims-exact', storageRules);

    const adminDb = getAdminFirestore(sandbox);
    await setDoc(doc(adminDb, 'claims/exact'), { ok: true });
    await setDoc(doc(adminDb, 'claims/mustDeny'), { ok: true });

    await uploadString(storageRef(storage, 'exact/file.txt'), 'secret');
    await uploadString(storageRef(storage, 'deny/file.txt'), 'secret');

    const customToken = mintCustomToken({
      uid: 'int64-user',
      projectId: SANDBOX_PROJECT_ID,
      nowMs: Date.now(),
      claims: {
        n: POW53_PLUS_1,
        nested: { max: INT64_MAX, min: INT64_MIN },
        pastInt64: 2 ** 63,
      },
    });
    const cred = await signInWithCustomToken(auth, customToken);

    const idToken = await cred.user.getIdToken();
    const checked = await checkIdToken(idToken);
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.claims.n).toBe(POW53_PLUS_1);
    }

    const db = getFirestore(sandbox);
    expect((await getDoc(doc(db, 'claims/exact'))).exists()).toBe(true);
    await expect(getDoc(doc(db, 'claims/mustDeny'))).rejects.toThrow();

    const exactBytes = await getBytes(storageRef(storage, 'exact/file.txt'));
    expect(new TextDecoder().decode(exactBytes)).toBe('secret');
    await expect(getBytes(storageRef(storage, 'deny/file.txt'))).rejects.toThrow();
  });

  test('decodes raw JSON custom tokens and OIDC JWT payloads with 2^53 + 1 losslessly', async () => {
    const header = encodeJson({ alg: 'RS256', typ: 'JWT' });
    const nowSec = Math.floor(Date.now() / 1000);
    const rawCustomPayload = JSON.stringify({
      aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
      iat: nowSec,
      exp: nowSec + 3600,
      iss: `firebase-adminsdk-pyric@${SANDBOX_PROJECT_ID}.iam.gserviceaccount.com`,
      sub: `firebase-adminsdk-pyric@${SANDBOX_PROJECT_ID}.iam.gserviceaccount.com`,
      uid: 'raw-json-user',
      claims: { n: 0 },
    }).replace('"n":0', '"n":9007199254740993');
    const payloadSegment = Buffer.from(rawCustomPayload, 'utf8').toString('base64url');
    const sig = sandboxSignatureSync(
      'pyric-sandbox-custom-token-signing-key',
      `${header}.${payloadSegment}`,
    );
    const rawCustomToken = `${header}.${payloadSegment}.${sig}`;

    const sandbox = initializeSandbox();
    setFirestoreRules(
      sandbox,
      `rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          match /check/1 {
            allow get: if request.auth.token.n == 9007199254740993 && request.auth.token.n is int;
          }
        }
      }`,
    );
    await setDoc(doc(getAdminFirestore(sandbox), 'check/1'), { ok: true });
    await signInWithCustomToken(getAuth(sandbox), rawCustomToken);
    expect((await getDoc(doc(getFirestore(sandbox), 'check/1'))).exists()).toBe(true);

    const oidcPayload = Buffer.from('{"sub":"oidc-user","n":9007199254740993}', 'utf8').toString('base64url');
    const oidcJwt = `${header}.${oidcPayload}.sig`;
    const decodedOidc = decodeOidcIdTokenClaims(oidcJwt);
    expect(decodedOidc).not.toBeNull();
    expect(decodedOidc?.claims.n).toBe(POW53_PLUS_1);
  });
});

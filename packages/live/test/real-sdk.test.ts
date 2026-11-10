/**
 * The live rows over the real Firebase SDK, with no backend reachable however
 * the suite is run. Firestore points at a loopback port nothing listens on
 * and has its network disabled before any call, so it answers from its
 * memory cache. Auth points at the same closed port, and App Check uses a
 * `CustomProvider`, so no sign-in or attestation service is contacted. That
 * is enough to show who owns each instance and which class each result is.
 */
import { createServer } from 'node:net';
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import * as realApp from 'firebase/app';
import * as realAppCheck from 'firebase/app-check';
import * as realAuth from 'firebase/auth';
import * as realFirestore from 'firebase/firestore';
import { SDK_MODULES, swappedFirebaseEntries } from '@pyric/cli/vite/internal/supplied-rows';
import { LIVE_MODULES, LIVE_ROWS, liveFirebaseEntries, liveModuleFor, replacedExports, type LiveCallRecord, type LiveModuleSite, type LiveObserver } from '../src/index.js';
import { firestoreContext } from '../src/firestore.js';
import type { LiveListener } from '../src/observe.js';
import { realmHash } from '../src/keyed-hash.js';
import { observedCallOf } from '../src/page-observer.js';

/** The host's own reader, loaded at run time so this package's typecheck stays out of it. */
interface HostReader {
  readObservedCall(value: unknown): { query?: unknown; listener?: unknown };
}
const host = (await import(new URL('../../pyric/src/sandbox/internal/observed-call.ts', import.meta.url).href)) as HostReader;

/** A loopback port nothing listens on: the system hands one out, and the server is closed again. */
async function closedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('no loopback port');
  return address.port;
}

const CLOSED_PORT = await closedLoopbackPort();
const SDK_VERSION = realApp.SDK_VERSION;

const records: LiveCallRecord[] = [];
let recorderFails = false;
const observer: LiveObserver = (record) => {
  if (recorderFails) throw new Error('recorder down');
  records.push(record);
};

const site: LiveModuleSite = { observer, sdkVersion: SDK_VERSION, client: 'node' };
const app = liveModuleFor('firebase/app', realApp, site);
const auth = liveModuleFor('firebase/auth', realAuth, site);
const firestore = liveModuleFor('firebase/firestore', realFirestore, site);
const appCheck = liveModuleFor('firebase/app-check', realAppCheck, site);

const OPTIONS = { apiKey: 'demo-api-key', projectId: 'demo-live', appId: '1:123456789012:web:0a1b2c3d4e5f6071' };
const REAL_MODULES: Record<string, object> = {
  'firebase/app': realApp,
  'firebase/auth': realAuth,
  'firebase/firestore': realFirestore,
  'firebase/app-check': realAppCheck,
};
const WRAPPED_MODULES: Record<string, object> = {
  'firebase/app': app,
  'firebase/auth': auth,
  'firebase/firestore': firestore,
  'firebase/app-check': appCheck,
};

const liveApp = app.initializeApp(OPTIONS, 'live-ownership');
const db = firestore.getFirestore(liveApp);
realFirestore.connectFirestoreEmulator(db, '127.0.0.1', CLOSED_PORT);
await realFirestore.disableNetwork(db);
realAuth.connectAuthEmulator(auth.getAuth(liveApp), `http://127.0.0.1:${CLOSED_PORT}`, { disableWarnings: true });

afterAll(async () => {
  await realFirestore.terminate(db);
  await realApp.deleteApp(liveApp);
});

function outcomesOf(name: string): string[] {
  return records.filter((record) => record.name === name).map((record) => record.outcome);
}

/** The exports a live row replaces: the observed ones and the guarded ones. */
function observedNames(specifier: string): string[] {
  const key = LIVE_ROWS.get(specifier as never);
  if (key === undefined) return [];
  return replacedExports(key);
}

describe('the live row set', () => {
  test('serves firebase/app, firebase/auth, firebase/firestore and firebase/app-check from the live modules', () => {
    const entries = liveFirebaseEntries();
    expect(entries.get('firebase/app')).toBe('live-app');
    expect(entries.get('firebase/auth')).toBe('live-auth');
    expect(entries.get('firebase/firestore')).toBe('live-firestore');
    expect(entries.get('firebase/app-check')).toBe('live-app-check');
  });

  test('leaves every other row of the one swap table as it is', () => {
    const sandbox = swappedFirebaseEntries('sandbox');
    for (const specifier of SDK_MODULES) {
      const isLive = LIVE_ROWS.has(specifier);
      if (!isLive) expect(liveFirebaseEntries().get(specifier)).toBe(sandbox.get(specifier));
    }
  });

  test('has no row for a specifier it does not serve', () => {
    expect(() => liveModuleFor('firebase/functions', {}, site)).toThrow('no live row for firebase/functions');
  });
});

describe('the suite reaches no backend', () => {
  test('Firestore and Auth point at a closed loopback port', () => {
    const settings = Reflect.get(db.toJSON(), 'settings') as { host: string; ssl: boolean };
    expect(settings.host).toBe(`127.0.0.1:${CLOSED_PORT}`);
    expect(settings.ssl).toBe(false);
    expect(auth.getAuth(liveApp).emulatorConfig?.host).toBe('127.0.0.1');
    expect(auth.getAuth(liveApp).emulatorConfig?.port).toBe(CLOSED_PORT);
  });
});

describe('each wrapped module forwards the installed SDK', () => {
  for (const specifier of Object.keys(REAL_MODULES)) {
    const real = REAL_MODULES[specifier]!;
    const wrapped = WRAPPED_MODULES[specifier]!;
    const observed = new Set(observedNames(specifier));

    test(`${specifier}: every observed name is a function the installed SDK exports`, () => {
      const missing = [...observed].filter((name) => typeof Reflect.get(real, name) !== 'function');
      expect(missing).toEqual([]);
    });

    test(`${specifier}: every export is present, and every one not observed is the SDK's own value`, () => {
      expect(Object.keys(wrapped).sort()).toEqual(Object.keys(real).sort());
      const replaced = Object.keys(real).filter((name) => !observed.has(name) && Reflect.get(wrapped, name) !== Reflect.get(real, name));
      expect(replaced).toEqual([]);
    });
  }
});

describe('Auth, Firestore and App Check share the app object the app holds', () => {
  test('getApp() returns the app initializeApp returned', () => {
    expect(app.getApp('live-ownership')).toBe(liveApp);
    expect(realApp.getApp('live-ownership')).toBe(liveApp);
  });

  test('db.app is the app', () => {
    expect(db.app).toBe(liveApp);
    expect(db).toBeInstanceOf(realFirestore.Firestore);
  });

  test('auth.app is the app', () => {
    expect(auth.getAuth(liveApp).app).toBe(liveApp);
  });

  test('the App Check instance is attached to the app', () => {
    const instance = appCheck.initializeAppCheck(liveApp, {
      provider: new realAppCheck.CustomProvider({ getToken: async () => ({ token: 'demo-token', expireTimeMillis: Date.now() + 3_600_000 }) }),
    });
    expect(instance.app).toBe(liveApp);
  });
});

describe('results are the real SDK classes, recorded as they settle', () => {
  test('a cached query resolves to the SDK QuerySnapshot', async () => {
    const snapshot = await firestore.getDocsFromCache(firestore.collection(db, 'rooms'));
    expect(snapshot).toBeInstanceOf(realFirestore.QuerySnapshot);
    expect(outcomesOf('getDocsFromCache')).toEqual(['resolved']);
  });

  test('a cache miss rejects with the SDK FirebaseError, recorded with its code', async () => {
    const reason = await firestore.getDocFromCache(firestore.doc(db, 'rooms/missing')).catch((error: unknown) => error);
    expect(reason).toBeInstanceOf(realApp.FirebaseError);
    expect((reason as realApp.FirebaseError).code).toBe('unavailable');
    expect(records.filter((record) => record.name === 'getDocFromCache')).toEqual([
      { module: 'firebase/firestore', name: 'getDocFromCache', outcome: 'rejected', code: 'unavailable', message: expect.stringContaining('Failed to get document from cache.'), projectId: 'demo-live', path: 'rooms/missing' },
    ]);
  });

  test('a listener delivers the SDK DocumentSnapshot, and the delivery is recorded', async () => {
    const snapshot = await new Promise<realFirestore.DocumentSnapshot>((resolve, reject) => {
      const unsubscribe = firestore.onSnapshot(firestore.doc(db, 'rooms/lobby'), (value) => {
        unsubscribe();
        resolve(value);
      }, reject);
    });
    expect(snapshot).toBeInstanceOf(realFirestore.DocumentSnapshot);
    expect(snapshot.metadata.fromCache).toBe(true);
    expect(outcomesOf('onSnapshot')).toEqual(['attached', 'delivered', 'detached']);
  });

  test('an auth listener and a sign-out are recorded', async () => {
    const instance = auth.getAuth(liveApp);
    const user = await new Promise<unknown>((resolve) => {
      const unsubscribe = auth.onAuthStateChanged(instance, (value) => {
        unsubscribe();
        resolve(value);
      });
    });
    expect(user).toBeNull();
    await auth.signOut(instance);
    expect(outcomesOf('onAuthStateChanged')).toEqual(['returned', 'delivered']);
    expect(outcomesOf('signOut')).toEqual(['resolved']);
  });

  test('an App Check token failure reaches the app listener and is recorded as a listener error', async () => {
    const failingApp = app.initializeApp(OPTIONS, 'live-app-check-error');
    const instance = appCheck.initializeAppCheck(failingApp, {
      provider: new realAppCheck.CustomProvider({ getToken: () => Promise.reject(new Error('attestation down')) }),
      isTokenAutoRefreshEnabled: false,
    });
    const reason = await new Promise<unknown>((resolve) => {
      appCheck.onTokenChanged(instance, () => undefined, resolve);
      void appCheck.getToken(instance).catch(() => undefined);
    });
    expect(reason).toBeInstanceOf(Error);
    expect(outcomesOf('onTokenChanged')).toContain('listener-error');
    await realApp.deleteApp(failingApp);
  });

  test('an App Check token failure with no app error callback is recorded, and logs nothing, as the SDK does', async () => {
    const failingApp = app.initializeApp(OPTIONS, 'live-app-check-uncaught');
    const instance = appCheck.initializeAppCheck(failingApp, {
      provider: new realAppCheck.CustomProvider({ getToken: () => Promise.reject(new Error('attestation down')) }),
      isTokenAutoRefreshEnabled: false,
    });
    const before = records.filter((record) => record.name === 'onTokenChanged' && record.outcome === 'listener-error').length;
    const errorLog = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      appCheck.onTokenChanged(instance, () => undefined);
      await appCheck.getToken(instance).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
    const after = records.filter((record) => record.name === 'onTokenChanged' && record.outcome === 'listener-error').length;
    expect(after).toBe(before + 1);
    await realApp.deleteApp(failingApp);
  });
});

describe('a Firestore listener error with no app error callback is logged as the SDK logs it', () => {
  test('the line matches the SDK logger: its prefix, its version and the AsyncObserver message', async () => {
    const logUncaught = LIVE_MODULES['live-firestore'].uncaughtListenerError!(SDK_VERSION);
    // A real FirestoreError, whose toString the SDK's message uses: a cache miss.
    const error = await realFirestore.getDocFromCache(realFirestore.doc(db, 'rooms/absent')).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(realApp.FirebaseError);
    // `_logWarn` is the SDK's own logger as Firestore exports it, so it shows the prefix and version that logger writes.
    const sdkLog = Reflect.get(realFirestore, '_logWarn') as (message: string, ...values: unknown[]) => void;
    const ours: unknown[][] = [];
    const sdks: unknown[][] = [];
    const errorLog = spyOn(console, 'error').mockImplementation((...args: unknown[]) => void ours.push(args));
    const warnLog = spyOn(console, 'warn').mockImplementation((...args: unknown[]) => void sdks.push(args));
    try {
      logUncaught(error);
      sdkLog('Uncaught Error in snapshot listener:', String(error));
    } finally {
      errorLog.mockRestore();
      warnLog.mockRestore();
    }
    const timestamp = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]  @firebase\/firestore:$/;
    expect(ours).toHaveLength(1);
    expect(sdks).toHaveLength(1);
    expect(ours[0]![0]).toMatch(timestamp);
    expect(sdks[0]![0]).toMatch(timestamp);
    expect(ours[0]!.slice(1)).toEqual(sdks[0]!.slice(1));
    expect(ours[0]!.slice(1)).toEqual([
      `Firestore (${SDK_VERSION}): Uncaught Error in snapshot listener:`,
      `FirebaseError: [code=unavailable]: ${(error as realApp.FirebaseError).message}`,
    ]);
  });
});

describe('a recorder failure never changes what the app sees from the real SDK', () => {
  test('reads, rejections and listener deliveries pass through while every record throws', async () => {
    recorderFails = true;
    try {
      const snapshot = await firestore.getDocsFromCache(firestore.collection(db, 'rooms'));
      expect(snapshot).toBeInstanceOf(realFirestore.QuerySnapshot);
      const reason = await firestore.getDocFromCache(firestore.doc(db, 'rooms/missing')).catch((error: unknown) => error);
      expect((reason as realApp.FirebaseError).code).toBe('unavailable');
      const delivered = await new Promise<realFirestore.DocumentSnapshot>((resolve, reject) => {
        const unsubscribe = firestore.onSnapshot(firestore.doc(db, 'rooms/hall'), (value) => {
          unsubscribe();
          resolve(value);
        }, reject);
      });
      expect(delivered).toBeInstanceOf(realFirestore.DocumentSnapshot);
    } finally {
      recorderFails = false;
    }
  });
});

describe('the documents a real SDK listener delivery was billed for', () => {
  /** Listens with includeMetadataChanges for two deliveries, writing `written` after the first; resolves with their billed documents. */
  async function billedOver(target: unknown, written: string): Promise<(number | undefined)[]> {
    const start = records.length;
    await new Promise<void>((resolve, reject) => {
      let seen = 0;
      const unsubscribe = firestore.onSnapshot(target as never, { includeMetadataChanges: true }, () => {
        seen += 1;
        // Offline, the write stays pending and never settles; its local delivery is enough.
        if (seen === 1) void firestore.setDoc(firestore.doc(db, written), { title: 'a' });
        if (seen < 2) return;
        unsubscribe();
        resolve();
      }, reject);
    });
    return records.slice(start).filter((record) => record.outcome === 'delivered').map((record) => record.billedDocuments);
  }

  test('a query listener counts its first snapshot once and each document a write added', async () => {
    expect(await billedOver(firestore.query(firestore.collection(db, 'notes')), 'notes/n1')).toEqual([1, 1]);
  });

  test('a document listener counts its first snapshot once and the write that changed it', async () => {
    expect(await billedOver(firestore.doc(db, 'notes/n2'), 'notes/n2')).toEqual([1, 1]);
  });
});

describe('records name where the call went', () => {
  test("every record names the project the app's Firebase config set, read from the call's own arguments", async () => {
    await firestore.getDocsFromCache(firestore.query(firestore.collection(db, 'rooms'))).catch(() => undefined);
    await auth.signOut(auth.getAuth(liveApp));
    const named = records.filter((record) => record.name === 'getDocsFromCache' || record.name === 'signOut');
    expect(named.length).toBeGreaterThan(1);
    for (const record of named) expect(record.projectId, record.name).toBe(OPTIONS.projectId);
  });
});

describe('a Firestore list or listener names its query shape, never its values', () => {
  const FINGERPRINT = /^[0-9a-f]{16}$/;

  /** The records one call made, from where the records stood before it. */
  async function recordsOf(act: () => Promise<unknown>): Promise<LiveCallRecord[]> {
    const start = records.length;
    await act();
    return records.slice(start);
  }

  /** The one record a cached list of `target` makes. */
  async function listed(target: unknown): Promise<LiveCallRecord> {
    const made = await recordsOf(() => firestore.getDocsFromCache(target as never));
    expect(made).toHaveLength(1);
    return made[0]!;
  }

  function ownersQuery(owner: string): unknown {
    const { query, collection, where, orderBy, limit } = firestore;
    return query(collection(db, 'rooms'), where('owner', '==', owner), orderBy('createdAt', 'desc'), limit(5));
  }

  test('a where, orderBy and limit query: scope, fields, operators, direction, a limit and a fingerprint', async () => {
    const record = await listed(ownersQuery('owner-value-1'));
    expect(record.path).toBe('rooms');
    expect(record.query).toEqual({
      scope: 'collection',
      filters: [{ field: 'owner', op: '==' }],
      orderBy: [{ field: 'createdAt', direction: 'desc' }],
      limit: true,
      fingerprint: expect.stringMatching(FINGERPRINT),
    });
    expect(JSON.stringify(record)).not.toContain('owner-value-1');
  });

  test('the host reads the page\'s call with the same shape, as request.query names it', async () => {
    const record = await listed(ownersQuery('owner-value-1'));
    const call = observedCallOf(record, Date.now());
    expect(call?.query as unknown).toEqual(record.query);
    const read = host.readObservedCall(JSON.parse(JSON.stringify(call)));
    expect(read.query).toEqual(record.query!);
  });

  test('one query with one value keeps its fingerprint; another value changes it', async () => {
    const first = await listed(ownersQuery('owner-value-1'));
    const again = await listed(ownersQuery('owner-value-1'));
    const other = await listed(ownersQuery('owner-value-2'));
    expect(again.query?.fingerprint).toBe(first.query?.fingerprint!);
    expect(other.query?.fingerprint).not.toBe(first.query?.fingerprint!);
  });

  test('a cursor value changes the fingerprint and never leaves the page', async () => {
    const { query, collection, orderBy, startAfter } = firestore;
    const one = await listed(query(collection(db, 'rooms'), orderBy('createdAt'), startAfter('cursor-value-1')));
    const two = await listed(query(collection(db, 'rooms'), orderBy('createdAt'), startAfter('cursor-value-2')));
    expect(one.query?.orderBy).toEqual([{ field: 'createdAt', direction: 'asc' }]);
    expect(one.query?.fingerprint).not.toBe(two.query?.fingerprint!);
    expect(JSON.stringify(one)).not.toContain('cursor-value-1');
  });

  test('a collection-group query names its scope', async () => {
    const { query, collectionGroup, where } = firestore;
    const record = await listed(query(collectionGroup(db, 'messages'), where('score', '>=', 3)));
    expect(record.query).toEqual({ scope: 'collection-group', filters: [{ field: 'score', op: '>=' }], fingerprint: expect.stringMatching(FINGERPRINT) });
  });

  test('a bare collection names its scope and nothing else', async () => {
    const record = await listed(firestore.collection(db, 'rooms'));
    expect(record.query).toEqual({ scope: 'collection' });
  });

  test('an or() composite flattens into its filters', async () => {
    const { query, collection, where, or, and } = firestore;
    const record = await listed(query(collection(db, 'rooms'), or(where('a', '==', 1), and(where('b', 'in', [1, 2]), where('c', '!=', 'x')))));
    expect(record.query?.filters).toEqual([
      { field: 'a', op: '==' },
      { field: 'b', op: 'in' },
      { field: 'c', op: '!=' },
    ]);
  });

  test('a listener on a query names its shape on each delivery', async () => {
    const { query, collection, where } = firestore;
    const made = await recordsOf(() => new Promise<void>((resolve, reject) => {
      const unsubscribe = firestore.onSnapshot(query(collection(db, 'rooms'), where('open', '==', true)), () => {
        unsubscribe();
        resolve();
      }, reject);
    }));
    const delivered = made.filter((record) => record.outcome === 'delivered');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.query).toEqual({ scope: 'collection', filters: [{ field: 'open', op: '==' }], fingerprint: expect.stringMatching(FINGERPRINT) });
  });

  test('a realm without crypto still draws its own key and hashes the values with it', async () => {
    const ours = (await listed(ownersQuery('owner-value-1'))).query?.fingerprint;
    expect(ours).toMatch(FINGERPRINT);
    const values = JSON.stringify(['owner-value-1']);
    const crypto = Reflect.getOwnPropertyDescriptor(globalThis, 'crypto');
    Reflect.deleteProperty(globalThis, 'crypto');
    try {
      expect(Reflect.get(globalThis, 'crypto')).toBeUndefined();
      const fresh = (await import(`../src/keyed-hash.js?no-crypto=${Date.now()}`)) as typeof import('../src/keyed-hash.js');
      expect(fresh.realmHash(values)).toMatch(FINGERPRINT);
      // A fresh module drew its own key, so one value hashes apart from this realm's.
      expect(fresh.realmHash(values)).not.toBe(realmHash(values));
      expect(fresh.realmHash(JSON.stringify(['owner-value-2']))).not.toBe(fresh.realmHash(values));
    } finally {
      if (crypto !== undefined) Object.defineProperty(globalThis, 'crypto', crypto);
    }
  });

  test('a document read names no query', async () => {
    const read = await recordsOf(() => firestore.getDocFromCache(firestore.doc(db, 'rooms/missing')).catch(() => undefined));
    expect(read[0]?.query).toBeUndefined();
  });

  test('any bounded field path keeps its query shape, while an overlong field drops the shape and keeps the row', async () => {
    const { query, collection, where, orderBy } = firestore;
    const emailField = await listed(query(collection(db, 'rooms'), where('alice@example.com', '==', true)));
    const tokenField = await listed(query(collection(db, 'rooms'), orderBy(`k${'0123456789'.repeat(5)}`)));
    const jwtField = await listed(query(collection(db, 'rooms'), where('eyJhbGciOiJIUzI1NiJ9', '==', true)));
    for (const record of [emailField, tokenField, jwtField]) {
      expect(record.outcome).toBe('resolved');
      expect(record.path).toBe('rooms');
      expect(record.query).toBeDefined();
      const read = host.readObservedCall(JSON.parse(JSON.stringify(observedCallOf(record, Date.now()))));
      expect(read.query).toEqual(record.query!);
    }

    const overlongField = await listed(query(collection(db, 'rooms'), where('a'.repeat(1501), '==', true)));
    expect(overlongField.outcome).toBe('resolved');
    expect(overlongField.path).toBe('rooms');
    expect(overlongField.query).toBeUndefined();
    const sentOverlong = { ...observedCallOf(overlongField, Date.now()), query: { scope: 'collection', filters: [{ field: 'a'.repeat(1501), op: '==' }] } };
    expect(() => host.readObservedCall(sentOverlong)).toThrow('query.filters.field');
  });

  test('a field that only contains eyJ, as the host takes it, keeps the shape', async () => {
    const { query, collection, where, orderBy } = firestore;
    const record = await listed(query(collection(db, 'surveys'), where('surveyJson', '==', 'v'), orderBy('keyJson')));
    expect(record.query?.filters).toEqual([{ field: 'surveyJson', op: '==' }]);
    expect(record.query?.orderBy).toEqual([{ field: 'keyJson', direction: 'asc' }]);
    const read = host.readObservedCall(JSON.parse(JSON.stringify(observedCallOf(record, Date.now()))));
    expect(read.query).toEqual(record.query!);
  });
});

describe("a real SDK listener's attach and detach", () => {
  /** Listens to one document until its first delivery, and resolves with the wrapped unsubscribe. */
  function listen(path: string): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const unsubscribe = firestore.onSnapshot(firestore.doc(db, path), () => resolve(unsubscribe), reject);
    });
  }

  test('two listeners on one document own their ids and share a hashed key, and the host reads each attach and detach', async () => {
    const start = records.length;
    const first = await listen('rooms/lobby');
    const second = await listen('rooms/lobby');
    first();
    second();
    first();
    const lifecycle = records.slice(start).filter((record) => record.listener !== undefined);
    expect(lifecycle.map((record) => record.outcome)).toEqual(['attached', 'attached', 'detached', 'detached']);
    const [attachedFirst, attachedSecond, detachedFirst, detachedSecond] = lifecycle;
    expect(attachedFirst!.listener!.id).not.toBe(attachedSecond!.listener!.id);
    expect(attachedFirst!.listener!.key).toBe(attachedSecond!.listener!.key);
    expect(detachedFirst!.listener).toEqual(attachedFirst!.listener!);
    expect(detachedSecond!.listener).toEqual(attachedSecond!.listener!);
    for (const record of lifecycle) {
      const call = observedCallOf(record, Date.now());
      const read = host.readObservedCall(JSON.parse(JSON.stringify(call)));
      const phase = record.outcome === 'attached' ? 'attach' : 'detach';
      expect(read.listener).toEqual({ phase, id: record.listener!.id, target: 'rooms/lobby', key: record.listener!.key });
    }
  });
});

describe('an onSnapshotResume names the path of the snapshot it resumes', () => {
  /** A bundle as the SDK writes one: each element's UTF-8 byte length, then its JSON. */
  function bundleOf(elements: readonly object[]): string {
    return elements.map((element) => {
      const json = JSON.stringify(element);
      return `${new TextEncoder().encode(json).byteLength}${json}`;
    }).join('');
  }

  /** Loads one document into the cache from a bundle, so a real `DocumentSnapshot` of it has no pending writes. */
  async function cachedDocument(path: string, fields: Record<string, unknown>): Promise<realFirestore.DocumentSnapshot> {
    const name = `projects/${OPTIONS.projectId}/databases/(default)/documents/${path}`;
    const time = '2026-11-01T08:00:00.000000Z';
    const body = [{ documentMetadata: { name, readTime: time, exists: true } }, { document: { name, fields, createTime: time, updateTime: time } }];
    const totalBytes = new TextEncoder().encode(bundleOf(body)).byteLength;
    await realFirestore.loadBundle(db, bundleOf([{ metadata: { id: `cached-${path}`, createTime: time, version: 1, totalDocuments: 1, totalBytes } }, ...body]));
    return firestore.getDocFromCache(firestore.doc(db, path));
  }

  /** Resumes `json` until its first delivery and unsubscribes; the records the resume made. */
  async function resumed(json: object): Promise<LiveCallRecord[]> {
    const start = records.length;
    await new Promise<void>((resolve, reject) => {
      const unsubscribe = firestore.onSnapshotResume(db, json, () => {
        unsubscribe();
        resolve();
      }, reject);
    });
    return records.slice(start).filter((record) => record.name === 'onSnapshotResume');
  }

  /** `<outcome> <path>` for each record, and the path the host reads from each one it takes. */
  function pathsOf(resumes: readonly LiveCallRecord[]): { recorded: string[]; read: unknown[] } {
    const calls = resumes.map((record) => observedCallOf(record, Date.now())).filter((call) => call !== null);
    return {
      recorded: resumes.map((record) => `${record.outcome} ${record.path}`),
      read: calls.map((call) => (host.readObservedCall(JSON.parse(JSON.stringify(call))) as { path?: unknown }).path),
    };
  }

  test('a document snapshot: its attach, delivery and detach name the document', async () => {
    const snapshot = await cachedDocument('rooms/resumed', { name: { stringValue: 'Resumed' } });
    const resumes = await resumed(snapshot.toJSON());
    expect(pathsOf(resumes)).toEqual({
      recorded: ['attached rooms/resumed', 'delivered rooms/resumed', 'detached rooms/resumed'],
      read: ['rooms/resumed', 'rooms/resumed', 'rooms/resumed'],
    });
  });

  test("a query snapshot: its attach, delivery and detach name the collection the bundle's query reads", async () => {
    const snapshot = await firestore.getDocsFromCache(firestore.collection(db, 'halls'));
    expect(pathsOf(await resumed(snapshot.toJSON()))).toEqual({
      recorded: ['attached halls', 'delivered halls', 'detached halls'],
      read: ['halls', 'halls', 'halls'],
    });
  });

  test("a subcollection query snapshot: the SDK bundles its query under the database root, so the resume names the collection there, as it listens", async () => {
    const snapshot = await firestore.getDocsFromCache(firestore.collection(db, 'rooms/lobby/seats'));
    expect(pathsOf(await resumed(snapshot.toJSON()))).toEqual({
      recorded: ['attached seats', 'delivered seats', 'detached seats'],
      read: ['seats', 'seats', 'seats'],
    });
  });

  test('a collection-group query snapshot: its attach, delivery and detach name the group id, as a live query does', async () => {
    const snapshot = await firestore.getDocsFromCache(firestore.collectionGroup(db, 'seats'));
    expect(pathsOf(await resumed(snapshot.toJSON()))).toEqual({
      recorded: ['attached seats', 'delivered seats', 'detached seats'],
      read: ['seats', 'seats', 'seats'],
    });
  });

  test("a query snapshot's attach and detach carry one listener id and a hashed key, which the host reads as it reads an onSnapshot's", async () => {
    const json = (await firestore.getDocsFromCache(firestore.collection(db, 'halls'))).toJSON();
    const lifecycle = (await resumed(json)).filter((record) => record.listener !== undefined);
    expect(lifecycle.map((record) => record.outcome)).toEqual(['attached', 'detached']);
    const [attached, detached] = lifecycle;
    expect(detached!.listener).toEqual(attached!.listener!);
    expect(attached!.listener!.key).toMatch(/^[0-9a-f]{16}$/);
    for (const record of lifecycle) {
      const read = host.readObservedCall(JSON.parse(JSON.stringify(observedCallOf(record, Date.now()))));
      const phase = record.outcome === 'attached' ? 'attach' : 'detach';
      expect(read.listener).toEqual({ phase, id: record.listener!.id, target: 'halls', key: record.listener!.key });
    }
  });

  test('two resumes of one query snapshot own their ids and share a key', async () => {
    const json = (await firestore.getDocsFromCache(firestore.collection(db, 'halls'))).toJSON();
    const [first, second] = [await resumed(json), await resumed(json)].map((made) => made.find((record) => record.outcome === 'attached')!.listener!);
    expect(first!.id).not.toBe(second!.id);
    expect(first!.key).toBe(second!.key);
  });

  test("a document snapshot's resume shares the key an onSnapshot of its document has", async () => {
    const snapshot = await cachedDocument('rooms/resumed', { name: { stringValue: 'Resumed' } });
    const resumedKey = (await resumed(snapshot.toJSON())).find((record) => record.outcome === 'attached')!.listener!.key;
    const start = records.length;
    await new Promise<void>((resolve, reject) => {
      const unsubscribe = firestore.onSnapshot(firestore.doc(db, 'rooms/resumed'), () => {
        unsubscribe();
        resolve();
      }, reject);
    });
    const listened = records.slice(start).find((record) => record.name === 'onSnapshot' && record.outcome === 'attached');
    expect(listened!.listener!.key).toBe(resumedKey);
  });

  describe("in the page's activity journal", () => {
    /** Each journal step a second wrapped module makes: `open` with the listener, then `close`. */
    const steps: Array<['open', LiveListener] | ['close', string]> = [];
    const journaling: LiveObserver = Object.assign((record: LiveCallRecord) => {
      records.push(record);
    }, {
      journal: (listener: LiveListener) => {
        steps.push(['open', listener]);
        return {
          deliver: (_value: unknown, _billed: number | undefined, run: () => unknown) => run(),
          fail: () => undefined,
          close: () => steps.push(['close', listener.method]),
        };
      },
    });
    const journaled = liveModuleFor('firebase/firestore', realFirestore, { observer: journaling, sdkVersion: SDK_VERSION, client: 'node' });

    /** Listens with `subscribe` until its first delivery and unsubscribes; the journal steps it made. */
    async function journalOf(subscribe: (next: () => void, fail: (error: unknown) => void) => () => void): Promise<typeof steps> {
      const start = steps.length;
      await new Promise<void>((resolve, reject) => {
        const unsubscribe = subscribe(() => {
          unsubscribe();
          resolve();
        }, reject);
      });
      return steps.slice(start);
    }

    /** The Firestore listener the steps opened. */
    function opened(made: typeof steps): Extract<LiveListener, { firestore: object }> {
      const open = made.find((step) => step[0] === 'open');
      const listener = open?.[1];
      const isFirestore = typeof listener === 'object' && 'firestore' in listener;
      if (!isFirestore) throw new Error(`no Firestore journal open in ${JSON.stringify(made.map((step) => step[0]))}`);
      return listener;
    }

    test('a resumed document opens and closes as an onSnapshot of that document does, under the same Firestore and key', async () => {
      const snapshot = await cachedDocument('rooms/journaled', { name: { stringValue: 'Journaled' } });
      const resume = await journalOf((next, fail) => journaled.onSnapshotResume(db, snapshot.toJSON(), next, fail));
      const listen = await journalOf((next, fail) => journaled.onSnapshot(journaled.doc(db, 'rooms/journaled'), next, fail));
      expect(resume.map((step) => step[0])).toEqual(['open', 'close']);
      const [resumedListener, listened] = [opened(resume), opened(listen)];
      expect({ ...resumedListener, firestore: undefined }).toEqual({ ...listened, method: 'onSnapshotResume', firestore: undefined });
      expect(resumedListener.firestore).toBe(listened.firestore);
    });

    test('a resumed query opens and closes as an onSnapshot of that query does, under the same Firestore', async () => {
      const json = (await journaled.getDocsFromCache(journaled.collection(db, 'halls'))).toJSON();
      const resume = await journalOf((next, fail) => journaled.onSnapshotResume(db, json, next, fail));
      const listen = await journalOf((next, fail) => journaled.onSnapshot(journaled.collection(db, 'halls'), next, fail));
      expect(resume.map((step) => step[0])).toEqual(['open', 'close']);
      const [resumedListener, listened] = [opened(resume), opened(listen)];
      expect({ method: resumedListener.method, target: resumedListener.target, isQuery: resumedListener.isQuery }).toEqual({ method: 'onSnapshotResume', target: 'halls', isQuery: true });
      expect({ target: listened.target, isQuery: listened.isQuery }).toEqual({ target: 'halls', isQuery: true });
      expect(resumedListener.firestore).toBe(listened.firestore);
    });
  });

  test('a query snapshot whose bundle holds no readable query names no path, as any unread call does', async () => {
    const json = (await firestore.getDocsFromCache(firestore.collection(db, 'rooms'))).toJSON() as Record<string, unknown>;
    expect(firestoreContext('onSnapshotResume', [db, json])).toHaveProperty('path', 'rooms');
    for (const bundle of ['12{"broken":', '99{}', 'x', 7]) {
      expect(firestoreContext('onSnapshotResume', [db, { ...json, bundle }])).not.toHaveProperty('path');
    }
  });
});

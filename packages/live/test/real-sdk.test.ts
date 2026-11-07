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
import { observedCallOf } from '../src/page-observer.js';

/** The host's own reader, loaded at run time so this package's typecheck stays out of it. */
interface HostReader {
  readObservedCall(value: unknown): { query?: unknown };
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
      { module: 'firebase/firestore', name: 'getDocFromCache', outcome: 'rejected', code: 'unavailable', projectId: 'demo-live', path: 'rooms/missing' },
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
    expect(outcomesOf('onSnapshot')).toEqual(['returned', 'delivered']);
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

  test('a realm without crypto still salts and hashes the values', async () => {
    const ours = (await listed(ownersQuery('owner-value-1'))).query?.fingerprint;
    const crypto = Reflect.getOwnPropertyDescriptor(globalThis, 'crypto');
    Reflect.deleteProperty(globalThis, 'crypto');
    try {
      expect(Reflect.get(globalThis, 'crypto')).toBeUndefined();
      const fresh = (await import(`../src/firestore.js?no-crypto=${Date.now()}`)) as typeof import('../src/firestore.js');
      const shape = fresh.queryShape('getDocs', ownersQuery('owner-value-1'));
      expect(shape?.fingerprint).toMatch(FINGERPRINT);
      // A fresh module drew its own salt, so one value hashes apart from this realm's.
      expect(shape?.fingerprint).not.toBe(ours!);
      expect(fresh.queryShape('getDocs', ownersQuery('owner-value-2'))?.fingerprint).not.toBe(shape?.fingerprint!);
    } finally {
      if (crypto !== undefined) Object.defineProperty(globalThis, 'crypto', crypto);
    }
  });

  test('a document read names no query', async () => {
    const read = await recordsOf(() => firestore.getDocFromCache(firestore.doc(db, 'rooms/missing')).catch(() => undefined));
    expect(read[0]?.query).toBeUndefined();
  });

  test('a field the host would refuse drops the shape and keeps the row', async () => {
    const { query, collection, where, orderBy } = firestore;
    const emailField = await listed(query(collection(db, 'rooms'), where('alice@example.com', '==', true)));
    const tokenField = await listed(query(collection(db, 'rooms'), orderBy(`k${'0123456789'.repeat(5)}`)));
    const jwtField = await listed(query(collection(db, 'rooms'), where('eyJhbGciOiJIUzI1NiJ9', '==', true)));
    for (const record of [emailField, tokenField, jwtField]) {
      expect(record.outcome).toBe('resolved');
      expect(record.path).toBe('rooms');
      expect(record.query).toBeUndefined();
      const read = host.readObservedCall(JSON.parse(JSON.stringify(observedCallOf(record, Date.now()))));
      expect(read.query).toBeUndefined();
    }
    // The host refuses that field, which is why the page never sends it.
    const sent = { ...observedCallOf(emailField, Date.now()), query: { scope: 'collection', filters: [{ field: 'alice@example.com', op: '==' }] } };
    expect(() => host.readObservedCall(sent)).toThrow('query.filters.field');
    const sentJwt = { ...observedCallOf(jwtField, Date.now()), query: { scope: 'collection', filters: [{ field: 'eyJhbGciOiJIUzI1NiJ9', op: '==' }] } };
    expect(() => host.readObservedCall(sentJwt)).toThrow('query.filters.field');
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

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
    expect(() => liveModuleFor('firebase/database', {}, site)).toThrow('no live row for firebase/database');
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
      { module: 'firebase/firestore', name: 'getDocFromCache', outcome: 'rejected', code: 'unavailable' },
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

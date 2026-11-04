/**
 * The live rows over the real Firebase SDK, with no backend reachable. The
 * suite runs in a network namespace with only loopback, so Firestore's
 * channel fails name resolution and the SDK answers from its memory cache:
 * enough to show who owns each instance and which class each result is,
 * without a request reaching Google. App Check uses a `CustomProvider`, so no
 * attestation service is contacted either.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as realApp from 'firebase/app';
import * as realAppCheck from 'firebase/app-check';
import * as realAuth from 'firebase/auth';
import * as realFirestore from 'firebase/firestore';
import { SDK_MODULES, swappedFirebaseEntries } from '../../cli/src/serve/firebase-module-swap.js';
import { LIVE_MODULES, LIVE_ROWS, liveFirebaseEntries, liveModuleFor, type LiveCallRecord, type LiveObserver } from '../src/index.js';

const records: LiveCallRecord[] = [];
let recorderFails = false;
const observer: LiveObserver = (record) => {
  if (recorderFails) throw new Error('recorder down');
  records.push(record);
};

const app = liveModuleFor('firebase/app', realApp, observer);
const auth = liveModuleFor('firebase/auth', realAuth, observer);
const firestore = liveModuleFor('firebase/firestore', realFirestore, observer);
const appCheck = liveModuleFor('firebase/app-check', realAppCheck, observer);

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

afterAll(async () => {
  await realFirestore.terminate(db);
  await realApp.deleteApp(liveApp);
});

function outcomesOf(name: string): string[] {
  return records.filter((record) => record.name === name).map((record) => record.outcome);
}

function observedNames(specifier: string): string[] {
  const key = LIVE_ROWS.get(specifier as never);
  if (key === undefined) return [];
  const spec = LIVE_MODULES[key];
  return [...spec.calls, ...spec.listeners];
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
    expect(() => liveModuleFor('firebase/database', {}, observer)).toThrow('no live row for firebase/database');
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

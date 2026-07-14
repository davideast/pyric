/**
 * Oracle conformance (client app registry) — wires the `app-registry-*` captures
 * of the installed `firebase/app` package (packages/conformance/observations/app/)
 * into the test suite so the CAPTURED real-firebase behavior is machine-checked
 * against pyric/app's default-app registry, not merely cited in comments.
 *
 * Philosophy (see packages/pyric/test/auth/oracle-conformance.test.ts and the
 * admin twin packages/pyric-admin/test/app/oracle-conformance.test.ts): each
 * observation's recorded values are the EXPECTED side. We assert the
 * environment-independent facts the capture pinned — error CODES, error-class
 * NAMES, message text, app names, registry counts, idempotency identity,
 * FirebaseOptions snapshots, settings, and per-app service containers. The two
 * single-config limitations are replayed as explicit documented divergences.
 *
 * Every `app-registry-*` observation must be either asserted here or listed in
 * NOT_APPLICABLE with a reason; the completeness test at the bottom enforces
 * that so a new capture can't silently go un-checked.
 *
 * The registry is a process-global singleton (mirroring firebase/app's store),
 * so each case resets it first via getApps()/deleteApp().
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import 'fake-indexeddb/auto';
import {
  initializeApp,
  getApp,
  getApps,
  deleteApp,
  onLog,
  setLogLevel,
  registerVersion,
  SDK_VERSION,
  FirebaseError,
} from '../../src/app/index.js';
import { resetAppRegistryForTests } from '../../src/app/registry.js';
import { getAuth } from '../../src/auth/index.js';
import { getFirestore } from '../../src/firestore/index.js';
import { getDatabase, ref as databaseRef } from '../../src/database/index.js';
import { getStorage, ref as storageRef } from '../../src/storage/index.js';
import { getAI } from '../../src/ai/index.js';

// app-registry-* observations live under the 'app' surface subdirectory.
const OBS_DIR = join(import.meta.dir, '..', '..', '..', '..', 'packages', 'conformance', 'observations', 'app');

/** Observations that cannot be replayed against the pyric/app sandbox registry. */
const NOT_APPLICABLE: Record<string, string> = {};
const OPTS = {
  apiKey: 'fake-api-key',
  projectId: 'demo-app-registry',
  appId: '1:0:web:0',
};

function load(name: string): Record<string, unknown> {
  const json = JSON.parse(readFileSync(join(OBS_DIR, `${name}.json`), 'utf8')) as {
    behavior: Record<string, unknown>;
  };
  return json.behavior;
}

/** Run `fn`, assert it threw with the given `.code`, and return the error so
 *  callers can additionally assert class name / message. */
function expectThrewCode(fn: () => unknown, code: string): Error {
  try {
    fn();
  } catch (e) {
    expect((e as { code?: string }).code).toBe(code);
    return e as Error;
  }
  throw new Error(`expected a throw with code ${code}`);
}

async function expectRejectedOrThrewCode(p: () => Promise<unknown>, code: string): Promise<Error> {
  try {
    await p();
  } catch (e) {
    expect((e as { code?: string }).code).toBe(code);
    return e as Error;
  }
  throw new Error(`expected a rejection/throw with code ${code}`);
}

beforeEach(async () => {
  await resetAppRegistryForTests();
  await Promise.all(getApps().map((app) => deleteApp(app)));
});
afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('oracle conformance (client app registry)', () => {
  it('app-registry-default-service-factories', () => {
    const obs = load('app-registry-default-service-factories');
    const app = initializeApp(OPTS);
    expect(getAuth().app === app).toBe(obs.authUsesDefaultApp as boolean);
    expect(getFirestore().app === app).toBe(obs.firestoreUsesDefaultApp as boolean);
    expect(getDatabase().app === app).toBe(obs.databaseUsesDefaultApp as boolean);
    expect(getStorage().app === app).toBe(obs.storageUsesDefaultApp as boolean);
  });

  it('app-registry-initializeapp-default', () => {
    const obs = load('app-registry-initializeapp-default');
    const app = initializeApp(OPTS); // implicit [DEFAULT]
    expect(app.name).toBe(obs.name as string); // '[DEFAULT]'
    expect(getApps().length).toBe(obs.getAppsLength as number); // 1
    expect(getApp() === app).toBe(obs.getAppNoArgResolvesSame as boolean); // true
    expect(app.automaticDataCollectionEnabled).toBe(obs.automaticDataCollectionEnabled as boolean);
    expect(Object.keys(app.options).sort()).toEqual(obs.optionKeys as string[]);
  });

  it('app-registry-initializeapp-named', () => {
    const obs = load('app-registry-initializeapp-named');
    const def = initializeApp(OPTS);
    const named = initializeApp({ ...OPTS }, 'secondary');
    expect(def.name).toBe(obs.defaultName as string); // '[DEFAULT]'
    expect(named.name).toBe(obs.namedName as string); // 'secondary'
    expect(getApps().length).toBe(obs.getAppsLength as number); // 2
    expect(getApp('secondary') === named).toBe(obs.getAppByNameResolvesSame as boolean);
  });

  it('app-registry-initializeapp-duplicate-name', () => {
    const obs = load('app-registry-initializeapp-duplicate-name');
    initializeApp(OPTS); // default
    const err = expectThrewCode(
      () => initializeApp({ ...OPTS, projectId: 'a-different-project' }),
      obs.code as string, // 'app/duplicate-app'
    );
    expect(err.constructor.name).toBe(obs.errorName as string); // 'FirebaseError'
    expect(err instanceof Error).toBe(obs.isError as boolean);
    expect(err.message).toBe(obs.message as string);
  });

  it('app-registry-initializeapp-duplicate-config', () => {
    const obs = load('app-registry-initializeapp-duplicate-config');
    const first = initializeApp(OPTS);
    const second = initializeApp({ ...OPTS });
    expect(first === second).toBe(obs.returnedSameInstance as boolean); // true
    expect(getApps().length).toBe(obs.getAppsLength as number); // 1
  });

  it('app-registry-getapp-default', () => {
    const obs = load('app-registry-getapp-default');
    const app = initializeApp(OPTS);
    const got = getApp();
    expect(got === app).toBe(obs.resolvesSameInstance as boolean);
    expect(got.name).toBe(obs.name as string); // '[DEFAULT]'
  });

  it('app-registry-getapp-named', () => {
    const obs = load('app-registry-getapp-named');
    initializeApp(OPTS);
    const named = initializeApp(OPTS, 'secondary');
    const got = getApp('secondary');
    expect(got === named).toBe(obs.resolvesSameInstance as boolean);
    expect(got.name).toBe(obs.name as string); // 'secondary'
  });

  it('app-registry-getapp-unknown-name', () => {
    const obs = load('app-registry-getapp-unknown-name');
    const err = expectThrewCode(() => getApp('does-not-exist'), obs.code as string); // 'app/no-app'
    expect(err.constructor.name).toBe(obs.errorName as string); // 'FirebaseError'
    expect(err instanceof Error).toBe(obs.isError as boolean);
    expect(err.message).toBe(obs.message as string);
  });

  it('app-registry-getapps-contents', () => {
    const obs = load('app-registry-getapps-contents');
    const def = initializeApp(OPTS);
    const named = initializeApp(OPTS, 'secondary');
    const apps = getApps();
    expect(Array.isArray(apps)).toBe(obs.isArray as boolean);
    expect(apps.length).toBe(obs.length as number); // 2
    expect(apps.includes(def)).toBe(obs.includesDefault as boolean);
    expect(apps.includes(named)).toBe(obs.includesNamed as boolean);
  });

  it('app-registry-deleteapp', async () => {
    const obs = load('app-registry-deleteapp');
    const named = initializeApp(OPTS, 'secondary');
    const ret = deleteApp(named);
    expect(Boolean(ret && typeof ret.then === 'function')).toBe(obs.deleteReturnsPromise as boolean);
    await ret;
    expect(getApps().filter((a) => a.name === 'secondary').length).toBe(obs.getAppsAfterDelete as number); // 0
    const err = expectThrewCode(() => getApp('secondary'), obs.getAppAfterDeleteCode as string); // 'app/no-app'
    expect((err as { code?: string }).code).toBe(obs.getAppAfterDeleteCode as string);
    expect(obs.getAppAfterDeleteThrew).toBe(true);
    // The name can be re-initialized after deletion (the slot is free).
    let reinitThrew = false;
    try {
      initializeApp(OPTS, 'secondary');
    } catch {
      reinitThrew = true;
    }
    expect(reinitThrew).toBe(obs.reinitAfterDeleteThrew as boolean); // false
  });

  it('app-registry-deleteapp-double', async () => {
    const obs = load('app-registry-deleteapp-double');
    const named = initializeApp(OPTS, 'secondary');
    await deleteApp(named);
    const err = await expectRejectedOrThrewCode(() => Promise.resolve(deleteApp(named)), obs.code as string); // 'app/app-deleted'
    expect(err.constructor.name).toBe(obs.errorName as string); // 'FirebaseError'
    expect(err instanceof Error).toBe(obs.isError as boolean);
    expect(err.message).toBe(obs.message as string);
  });

  it('app-registry-deleted-property-access', async () => {
    const obs = load('app-registry-deleted-property-access') as Record<
      'name' | 'options' | 'automaticDataCollectionEnabled',
      Record<string, unknown>
    >;
    const app = initializeApp(OPTS, 'secondary');
    await deleteApp(app);

    const accessors = {
      name: () => app.name,
      options: () => app.options,
      automaticDataCollectionEnabled: () => app.automaticDataCollectionEnabled,
    };
    for (const key of Object.keys(accessors) as Array<keyof typeof accessors>) {
      const expected = obs[key];
      const err = expectThrewCode(accessors[key], expected.code as string);
      expect(err.constructor.name).toBe(expected.errorName as string);
      expect(err instanceof Error).toBe(expected.isError as boolean);
      expect(err.message).toBe(expected.message as string);
    }
  });

  it('app-registry-deleted-service-factories', async () => {
    const obs = load('app-registry-deleted-service-factories') as Record<
      'auth' | 'firestore' | 'database' | 'storage' | 'ai',
      Record<string, unknown>
    >;
    const app = initializeApp(OPTS, 'deleted-services');
    await deleteApp(app);

    const factories = {
      auth: () => getAuth(app),
      firestore: () => getFirestore(app),
      database: () => getDatabase(app),
      storage: () => getStorage(app),
      ai: () => getAI(app),
    };
    for (const key of ['auth', 'firestore', 'database', 'storage'] as const) {
      const expected = obs[key];
      const err = expectThrewCode(factories[key], expected.code as string);
      expect(err.constructor.name).toBe(expected.errorName as string);
      expect(err instanceof Error).toBe(expected.isError as boolean);
      expect(err.message).toBe(expected.message as string);
    }
    const ai = factories.ai();
    expect(obs.ai.threw).toBe(false);
    expect(ai.app === app).toBe(obs.ai.usesDeletedApp as boolean);

    const retainedApp = initializeApp(OPTS, 'retained-services');
    const auth = getAuth(retainedApp);
    const firestore = getFirestore(retainedApp);
    const database = getDatabase(retainedApp);
    const storage = getStorage(retainedApp);
    await deleteApp(retainedApp);

    expect(getAuth(retainedApp) === auth).toBe(obs.cachedAuthFactory.usesDeletedApp as boolean);
    expect(getFirestore(retainedApp) === firestore).toBe(obs.cachedFirestoreFactory.usesDeletedApp as boolean);
    expect(getDatabase(retainedApp) === database).toBe(obs.cachedDatabaseFactory.usesDeletedApp as boolean);
    expect(getStorage(retainedApp) === storage).toBe(obs.cachedStorageFactory.usesDeletedApp as boolean);
    void auth;
    void database;
    void storage;
  });

  it('app-registry-initializeapp-settings-options', () => {
    const obs = load('app-registry-initializeapp-settings-options');
    const input = { ...OPTS };
    const app = initializeApp(input, {
      name: 'settings-app',
      automaticDataCollectionEnabled: false,
    });
    expect(app.name).toBe(obs.name as string);
    expect(app.options === input).toBe(obs.optionsSameReference as boolean);
    expect(Object.isFrozen(app.options)).toBe(obs.optionsFrozen as boolean);
    input.projectId = 'mutated-after-initialize';
    expect(app.options.projectId).toBe(obs.projectIdAfterInputMutation as string);
    expect(app.automaticDataCollectionEnabled).toBe(obs.initialAutomaticDataCollectionEnabled as boolean);
    app.automaticDataCollectionEnabled = true;
    expect(app.automaticDataCollectionEnabled).toBe(obs.automaticDataCollectionEnabledAfterMutation as boolean);
  });

  it('app-registry-initializeapp-named-equal-config', () => {
    const obs = load('app-registry-initializeapp-named-equal-config');
    const defaultApp = initializeApp(OPTS);
    const namedApp = initializeApp({ ...OPTS }, 'secondary');
    expect(defaultApp !== namedApp).toBe(obs.distinctApps as boolean);
    expect(JSON.stringify(defaultApp.options) === JSON.stringify(namedApp.options)).toBe(obs.equalOptions as boolean);
    expect(getApp() === defaultApp).toBe(obs.defaultLookupSame as boolean);
    expect(getApp('secondary') === namedApp).toBe(obs.namedLookupSame as boolean);
    expect(getApps().map((app) => app.name)).toEqual(obs.appNames as string[]);
  });

  it('app-registry-multi-app-service-containers', () => {
    const obs = load('app-registry-multi-app-service-containers');
    const options = {
      ...OPTS,
      databaseURL: 'https://demo-app-registry-default-rtdb.firebaseio.com',
      storageBucket: 'demo-app-registry.appspot.com',
    };
    const a = initializeApp(options, 'app-a');
    const b = initializeApp({ ...options }, 'app-b');
    const authA = getAuth(a);
    const authB = getAuth(b);
    const firestoreA = getFirestore(a);
    const firestoreB = getFirestore(b);
    const databaseA = getDatabase(a);
    const databaseB = getDatabase(b);
    const storageA = getStorage(a);
    const storageB = getStorage(b);
    expect(authA !== authB).toBe(obs.authDistinct as boolean);
    expect(authA.app === a && authB.app === b).toBe(obs.authAppsCorrect as boolean);
    expect(firestoreA !== firestoreB).toBe(obs.firestoreDistinct as boolean);
    expect(firestoreA.app === a && firestoreB.app === b).toBe(obs.firestoreAppsCorrect as boolean);
    expect(databaseA !== databaseB).toBe(obs.databaseDistinct as boolean);
    expect(databaseA.app === a && databaseB.app === b).toBe(obs.databaseAppsCorrect as boolean);
    expect(databaseRef(databaseA, 'probe').toString() === databaseRef(databaseB, 'probe').toString()).toBe(
      obs.databaseLocatorsEqual as boolean,
    );
    expect(storageA !== storageB).toBe(obs.storageDistinct as boolean);
    expect(storageA.app === a && storageB.app === b).toBe(obs.storageAppsCorrect as boolean);
    expect(storageRef(storageA, 'probe').toString() === storageRef(storageB, 'probe').toString()).toBe(
      obs.storageLocatorsEqual as boolean,
    );
  });

  it('app-registry-initializeapp-named-different-config — documented single-backend divergence', () => {
    const obs = load('app-registry-initializeapp-named-different-config');
    initializeApp(OPTS);
    expect(obs.threw).toBe(false);
    const err = expectThrewCode(
      () => initializeApp({ ...OPTS, projectId: 'other-app-registry', appId: '1:1:web:1' }, 'secondary'),
      'app/multiple-configs-not-supported',
    );
    expect(err.constructor.name).toBe('FirebaseError');
  });

  it('app-registry-delete-reinitialize-different-config — documented runtime-lock divergence', async () => {
    const obs = load('app-registry-delete-reinitialize-different-config');
    const first = initializeApp(OPTS);
    await deleteApp(first);
    expect(obs.threw).toBe(false);
    expectThrewCode(
      () => initializeApp({ ...OPTS, projectId: 'other-app-registry', appId: '1:1:web:1' }),
      'app/multiple-configs-not-supported',
    );
  });

  it('app-registry-initializeapp-no-options', () => {
    const obs = load('app-registry-initializeapp-no-options');
    const err = expectThrewCode(() => initializeApp(), obs.code as string);
    expect(err.constructor.name).toBe(obs.errorName as string);
    expect(err instanceof Error).toBe(obs.isError as boolean);
    expect(err.message).toBe(obs.message as string);
  });

  it('app-registry-sdk-version', () => {
    const obs = load('app-registry-sdk-version');
    // The mirror pins the SDK version whose observations it replays, so type,
    // semver shape, and exact value all stay aligned with the oracle envelope.
    expect(typeof SDK_VERSION).toBe(obs.type as string); // 'string'
    expect(/^\d+\.\d+\.\d+/.test(SDK_VERSION)).toBe(obs.isSemver as boolean);
    expect(SDK_VERSION).toBe(obs.value as string);
  });

  it('app-registry-firebaseerror-shape', () => {
    const obs = load('app-registry-firebaseerror-shape');
    const e = new FirebaseError('app/probe-code', 'probe message');
    expect(e.name).toBe(obs.errorName as string);
    expect(e.constructor.name).toBe(obs.ctorName as string);
    expect(e.code).toBe(obs.code as string);
    expect(e.message).toBe(obs.message as string);
    expect(e instanceof Error).toBe(obs.isError as boolean);
    expect(e instanceof FirebaseError).toBe(obs.isFirebaseError as boolean);
  });

  it('app-registry-onlog-setloglevel', () => {
    const obs = load('app-registry-onlog-setloglevel');
    const captured: Array<{ level: unknown; type: unknown; messageIsString: boolean; argsIsArray: boolean }> = [];
    let onLogReturn: unknown;
    try {
      onLogReturn = onLog((entry) => {
        captured.push({
          level: entry.level,
          type: entry.type,
          messageIsString: typeof entry.message === 'string',
          argsIsArray: Array.isArray(entry.args),
        });
      });
      setLogLevel('warn');
      registerVersion('pyric probe lib!!', 'not a version??');
    } finally {
      onLog(null);
      setLogLevel('info');
    }
    expect(onLogReturn === undefined ? 'undefined' : typeof onLogReturn).toBe(obs.onLogReturn as string);
    expect(captured.length).toBe(obs.emittedCount as number); // 1
    expect(captured[0]?.level).toBe(obs.emittedLevel as string); // 'warn'
    expect(captured[0]?.type).toBe(obs.emittedType as string); // '@firebase/app'
    expect(captured[0]?.messageIsString).toBe(obs.emittedMessageIsString as boolean);
    expect(captured[0]?.argsIsArray).toBe(obs.emittedArgsIsArray as boolean);
  });

  it('app-registry-registerversion', () => {
    const obs = load('app-registry-registerversion');
    let threw = false;
    let returnedUndefined = false;
    try {
      const ret = registerVersion('pyric-probe-lib', '1.2.3');
      returnedUndefined = ret === undefined;
    } catch {
      threw = true;
    }
    expect(threw).toBe(obs.threw as boolean); // false
    expect(returnedUndefined).toBe(obs.returnedUndefined as boolean); // true
  });

  // ── completeness: every app-registry observation is asserted or explicitly N/A ─

  it('every app-registry observation is covered (no silent gaps)', () => {
    const all = readdirSync(OBS_DIR).filter((f) => f.startsWith('app-registry-') && f.endsWith('.json'));
    expect(all.length).toBeGreaterThanOrEqual(14);
    const source = readFileSync(import.meta.path, 'utf8');
    const uncovered = all.filter((f) => !source.includes(f.replace('.json', '')) && !(f in NOT_APPLICABLE));
    expect(uncovered).toEqual([]);
  });
});

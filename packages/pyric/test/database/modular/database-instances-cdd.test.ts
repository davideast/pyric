import { describe, expect, it } from 'bun:test';
import { deleteApp, initializeApp } from 'firebase/app';
import {
  Database as FirebaseDatabase,
  getDatabase as getFirebaseDatabase,
  goOffline as goFirebaseOffline,
} from 'firebase/database';
import { initializeSandbox } from 'pyric/sandbox';
import {
  get,
  getDatabase,
  ref,
  set,
  TARGET_SYMBOL,
  sandbox as rtdbSandbox,
} from '../../../src/database/index.js';
import { load } from './oracle-conformance.support.js';

describe('RTDB CDD database instance cases', () => {
  it('rtdb-modular#94 returns a tagged frozen-context database', () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox.withAuth({ uid: 'frozen' }));
    expect(TARGET_SYMBOL in db).toBe(true);
    expect(db[TARGET_SYMBOL].kind).toBe('sandbox');
  });

  it('rtdb-modular#95 returns a tagged sandbox-live database', () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox);
    expect(TARGET_SYMBOL in db).toBe(true);
    expect(db[TARGET_SYMBOL].kind).toBe('sandbox-live');
  });

  it('rtdb-modular#98 shares one backend across handles for a sandbox', async () => {
    const sandbox = initializeSandbox();
    const first = getDatabase(sandbox.withAuth({ uid: 'first' }));
    const second = getDatabase(sandbox.withAuth({ uid: 'second' }));
    rtdbSandbox.setDefaultPolicy(first, 'allow');
    await set(ref(first, 'shared'), { ok: true });
    expect((await get(ref(second, 'shared'))).val()).toEqual({ ok: true });
  });

  it('rtdb-modular#99 routes each reference to its owning target', async () => {
    const first = getDatabase(initializeSandbox().withAuth({ uid: 'first' }));
    const second = getDatabase(initializeSandbox().withAuth({ uid: 'second' }));
    rtdbSandbox.setDefaultPolicy(first, 'allow');
    rtdbSandbox.setDefaultPolicy(second, 'allow');
    await set(ref(first, 'owned'), 1);
    await set(ref(second, 'owned'), 2);
    expect((await get(ref(first, 'owned'))).val()).toBe(1);
    expect((await get(ref(second, 'owned'))).val()).toBe(2);
  });

  it('rtdb-modular#96 leaves inactive canonical Firebase databases untagged while matching captured Database identity', async () => {
    const obs = load('rtdb-modular-runtime-class-identity.json');
    const exportTypes = obs.exportTypes as Record<string, string>;
    const dbObs = obs.database as {
      constructorName: string;
      instanceOf: boolean;
      prototypeIsExportPrototype: boolean;
      prototypeKeys: string[];
    };
    expect(typeof FirebaseDatabase).toBe(exportTypes.Database);

    const app = initializeApp(
      {
        projectId: 'inactive-canonical',
        databaseURL: 'https://inactive-canonical.firebaseio.com',
      },
      `inactive-${Date.now()}`,
    );
    let production: ReturnType<typeof getFirebaseDatabase> | undefined;
    try {
      production = getFirebaseDatabase(app);
      expect(production.constructor.name).toBe(dbObs.constructorName);
      expect(production instanceof FirebaseDatabase).toBe(dbObs.instanceOf);
      expect(Object.getPrototypeOf(production) === FirebaseDatabase.prototype).toBe(
        dbObs.prototypeIsExportPrototype,
      );
      expect(Object.getOwnPropertyNames(FirebaseDatabase.prototype).sort()).toEqual(
        dbObs.prototypeKeys,
      );
      expect(TARGET_SYMBOL in production).toBe(false);
      expect(() => getDatabase(app as never)).toThrow(/package resolution/i);
    } finally {
      if (production !== undefined) {
        goFirebaseOffline(production);
      }
      await deleteApp(app);
    }
  });
});

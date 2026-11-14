/**
 * Offline differential contract suite comparing `pyric-admin/database` (both
 * `in-process` and `shared-worker` arms) directly against `firebase-admin`
 * running offline (`db.goOffline()`), plus independent literal assertions.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  deleteApp as deleteProdApp,
  getApps as getProdApps,
  initializeApp as initializeProdApp,
} from 'firebase-admin/app';
import {
  getDatabase as getProdDatabase,
  getDatabaseWithUrl as getProdDatabaseWithUrl,
  type Database as ProdDatabase,
} from 'firebase-admin/database';
import {
  getDatabase as getModularDatabase,
  sandbox as databaseSandbox,
} from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';
import {
  deleteApp,
  getApps,
  initializeApp,
} from '../../src/app/index.js';
import {
  getDatabase,
  getDatabaseWithUrl,
  type Database,
  type DataSnapshot,
} from '../../src/database/index.js';
import { sharedWorkerArm } from './arms.js';

const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let seq = 0;

interface DifferentialDriver {
  readonly kind: 'firebase-admin' | 'in-process' | 'shared-worker';
  readonly db: Database | ProdDatabase;
  readonly openUrl: (url: string) => Database | ProdDatabase;
  readonly write: (path: string, value: unknown) => Promise<void>;
}

function makeProdDriver(projectId = 'demo-org', databaseURL = 'https://demo-org-default-rtdb.firebaseio.com'): DifferentialDriver {
  const app = initializeProdApp({ projectId, databaseURL }, `diff-prod-${++seq}`);
  const db = getProdDatabase(app);
  db.goOffline();
  return {
    kind: 'firebase-admin',
    db,
    openUrl: (url: string) => {
      const opened = getProdDatabaseWithUrl(url, app);
      opened.goOffline();
      return opened;
    },
    write: async (path: string, value: unknown) => {
      void db.ref(path).set(value).catch(() => {});
    },
  };
}

function makePyricDrivers(
  projectId = 'demo-org',
  databaseURL: string | undefined = 'https://demo-org-default-rtdb.firebaseio.com',
): DifferentialDriver[] {
  const localHost = initializeSandbox({ projectId });
  databaseSandbox.setDefaultPolicy(getModularDatabase(localHost), 'allow');
  const localOptions: { sandbox: typeof localHost; projectId: string; databaseURL?: string } = {
    sandbox: localHost,
    projectId,
  };
  if (databaseURL !== undefined) {
    localOptions.databaseURL = databaseURL;
  }
  const localApp = initializeApp(localOptions, `diff-local-${++seq}`);
  const localDb = getDatabase(localApp);

  const { app: baseRemote } = sharedWorkerArm();
  const remoteOptions: { sandbox: typeof baseRemote.sandbox; projectId: string; databaseURL?: string } = {
    sandbox: baseRemote.sandbox,
    projectId,
  };
  if (databaseURL !== undefined) {
    remoteOptions.databaseURL = databaseURL;
  }
  const remoteApp = initializeApp(remoteOptions, `diff-remote-${++seq}`);
  const remoteDb = getDatabase(remoteApp);

  return [
    {
      kind: 'in-process',
      db: localDb,
      openUrl: (url: string) => getDatabaseWithUrl(url, localApp),
      write: async (path: string, value: unknown) => {
        await localDb.ref(path).set(value);
      },
    },
    {
      kind: 'shared-worker',
      db: remoteDb,
      openUrl: (url: string) => getDatabaseWithUrl(url, remoteApp),
      write: async (path: string, value: unknown) => {
        await remoteDb.ref(path).set(value);
        await tick();
      },
    },
  ];
}

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
  await Promise.all(getProdApps().map((app) => deleteProdApp(app)));
});

describe('offline firebase-admin differential contracts', () => {
  test('off(eventType, cb, ctx?) detaches one duplicate registration per call and pairs (callback, context) without wildcarding omitted context', async () => {
    async function runScenario(driver: DifferentialDriver) {
      const db = driver.db as Database;
      await driver.write('items/dup', 'v1');
      const dupSeen: unknown[] = [];
      const dupCb = (snap: DataSnapshot): void => {
        dupSeen.push(snap.val());
      };
      db.ref('items/dup').on('value', dupCb);
      db.ref('items/dup').on('value', dupCb);
      if (driver.kind === 'shared-worker') await tick();
      db.ref('items/dup').off('value', dupCb);
      await driver.write('items/dup', 'v2');
      db.ref('items/dup').off('value', dupCb);
      await driver.write('items/dup', 'v3');
      db.ref('items/dup').off();

      await driver.write('items/ctx', 'v1');
      const ctxA = { label: 'bound-a' };
      const ctxB = { label: 'bound-b' };
      const ctxSeen: string[] = [];
      function ctxCb(this: { label?: string } | undefined, snap: DataSnapshot): void {
        const tag = this?.label ?? 'unbound';
        ctxSeen.push(`${tag}:${String(snap.val())}`);
      }
      db.ref('items/ctx').on('value', ctxCb, ctxA);
      db.ref('items/ctx').on('value', ctxCb, ctxB);
      db.ref('items/ctx').on('value', ctxCb);
      if (driver.kind === 'shared-worker') await tick();

      // Omitting context detaches only the unbound registration, leaving ctxA and ctxB active.
      db.ref('items/ctx').off('value', ctxCb);
      await driver.write('items/ctx', 'v2');

      // Specific context detaches only ctxA, leaving ctxB active.
      db.ref('items/ctx').off('value', ctxCb, ctxA);
      await driver.write('items/ctx', 'v3');
      db.ref('items/ctx').off();

      return { dupSeen, ctxSeen };
    }

    const oracle = await runScenario(makeProdDriver());
    expect(oracle).toEqual({
      dupSeen: ['v1', 'v1', 'v2'],
      ctxSeen: [
        'bound-a:v1',
        'bound-b:v1',
        'unbound:v1',
        'bound-a:v2',
        'bound-b:v2',
        'bound-b:v3',
      ],
    });

    for (const driver of makePyricDrivers()) {
      expect(await runScenario(driver)).toEqual(oracle);
    }
  });

  test('canonicalizes QuerySpec identity across slash-padded orderByChild paths and equalTo vs startAt+endAt for isEqual and cross-form off()', async () => {
    async function runScenario(driver: DifferentialDriver) {
      const db = driver.db as Database;
      const qChildCanonical = db.ref('items').orderByChild('meta/rank');
      const qChildSlashed = db.ref('items').orderByChild('/meta/rank/');
      const qChildMultiSlash = db.ref('items').orderByChild('//meta///rank//');

      const qEqual = db.ref('items').orderByChild('score').equalTo(20);
      const qRange = db.ref('items').orderByChild('score').startAt(20).endAt(20);

      const qEqualKey = db.ref('items').orderByChild('score').equalTo(20, 'i1');
      const qRangeKey = db.ref('items').orderByChild('score').startAt(20, 'i1').endAt(20, 'i1');
      const qRangeDiffKey = db.ref('items').orderByChild('score').startAt(20, 'i1').endAt(20, 'i2');

      const identity = {
        eqSlash: qChildCanonical.isEqual(qChildSlashed),
        eqMultiSlash: qChildCanonical.isEqual(qChildMultiSlash),
        eqBounds: qEqual.isEqual(qRange),
        eqBoundsWithKey: qEqualKey.isEqual(qRangeKey),
        neqDifferentCursorKey: qEqualKey.isEqual(qRangeDiffKey),
        eqPriorityDefault: db.ref('items').isEqual(db.ref('items').orderByPriority()),
      };

      await driver.write('items', { i1: { meta: { rank: 1 }, score: 20 } });

      const slashDeliveries: unknown[] = [];
      const slashCb = (snap: DataSnapshot): void => {
        slashDeliveries.push(snap.val());
      };
      qChildCanonical.on('value', slashCb);
      if (driver.kind === 'shared-worker') await tick();
      qChildSlashed.off('value', slashCb);

      const rangeDeliveries: unknown[] = [];
      const rangeCb = (snap: DataSnapshot): void => {
        rangeDeliveries.push(snap.val());
      };
      qEqual.on('value', rangeCb);
      if (driver.kind === 'shared-worker') await tick();
      qRange.off('value', rangeCb);

      await driver.write('items', { i1: { meta: { rank: 2 }, score: 20 } });
      db.ref('items').off();

      return {
        identity,
        slashDeliveryCount: slashDeliveries.length,
        rangeDeliveryCount: rangeDeliveries.length,
      };
    }

    const oracle = await runScenario(makeProdDriver());
    expect(oracle).toEqual({
      identity: {
        eqSlash: true,
        eqMultiSlash: true,
        eqBounds: true,
        eqBoundsWithKey: true,
        neqDifferentCursorKey: false,
        eqPriorityDefault: true,
      },
      slashDeliveryCount: 1,
      rangeDeliveryCount: 1,
    });

    for (const driver of makePyricDrivers()) {
      expect(await runScenario(driver)).toEqual(oracle);
    }
  });

  test('suppresses spurious child_moved on object-to-object orderByChild edits while preserving scalar-to-object and orderByValue moves', async () => {
    async function runScenario(driver: DifferentialDriver) {
      const db = driver.db as Database;

      // 1. Object -> object edit at orderByChild('meta') emits child_changed only, zero child_moved.
      await driver.write('items/objRank', {
        a: { meta: { tier: 1 } },
        b: { meta: { tier: 2 } },
      });
      const objMoved: string[] = [];
      const objChanged: string[] = [];
      db.ref('items/objRank').orderByChild('meta').on('child_moved', (snap) => {
        objMoved.push(String(snap.key));
      });
      db.ref('items/objRank').orderByChild('meta').on('child_changed', (snap) => {
        objChanged.push(String(snap.key));
      });
      if (driver.kind === 'shared-worker') await tick();
      await driver.write('items/objRank/a/meta', { tier: 99 });
      db.ref('items/objRank').off();

      // 2. Scalar -> object transition at orderByChild('meta') changes PathIndex rank and emits child_moved.
      await driver.write('items/typeTransition', {
        a: { meta: 1 },
        b: { meta: { tier: 2 } },
      });
      const transitionMoved: string[] = [];
      db.ref('items/typeTransition').orderByChild('meta').on('child_moved', (snap) => {
        transitionMoved.push(String(snap.key));
      });
      if (driver.kind === 'shared-worker') await tick();
      await driver.write('items/typeTransition/a/meta', { tier: 99 });
      db.ref('items/typeTransition').off();

      // 3. Object -> object edit under orderByValue() uses ValueIndex structural equality and DOES emit child_moved.
      await driver.write('items/valRank', {
        a: { tier: 1 },
        b: { tier: 2 },
      });
      const valMoved: string[] = [];
      db.ref('items/valRank').orderByValue().on('child_moved', (snap) => {
        valMoved.push(String(snap.key));
      });
      if (driver.kind === 'shared-worker') await tick();
      await driver.write('items/valRank/a', { tier: 99 });
      db.ref('items/valRank').off();

      return { objMoved, objChanged, transitionMoved, valMoved };
    }

    const oracle = await runScenario(makeProdDriver());
    expect(oracle).toEqual({
      objMoved: [],
      objChanged: ['a'],
      transitionMoved: ['a'],
      valMoved: ['a'],
    });

    for (const driver of makePyricDrivers()) {
      expect(await runScenario(driver)).toEqual(oracle);
    }
  });

  test('Reference#set, update, remove, and push validate onComplete synchronously before mutating state', async () => {
    async function runScenario(driver: DifferentialDriver) {
      const db = driver.db as Database;
      await driver.write('items/guarded', { keep: 'intact' });

      const captureSync = (invoke: () => unknown): string => {
        try {
          const ret = invoke() as { catch?: (fn: () => void) => void } | undefined;
          ret?.catch?.(() => {});
          return 'did-not-throw-sync';
        } catch (err) {
          return `${(err as Error).name}:${(err as Error).message}`;
        }
      };

      const errors = {
        set: captureSync(() => db.ref('items/guarded/setKey').set('mutated', 'bad' as never)),
        update: captureSync(() => db.ref('items/guarded/updKey').update({ flag: true }, 'bad' as never)),
        remove: captureSync(() => db.ref('items/guarded/keep').remove('bad' as never)),
        pushWithVal: captureSync(() => db.ref('items/guarded/pushed').push('mutated', 'bad' as never)),
        pushEmpty: captureSync(() => db.ref('items/guarded/pushed').push(undefined, 123 as never)),
      };

      let snapshotAfter: unknown;
      if (driver.kind === 'firebase-admin') {
        db.ref('items/guarded').once('value', (snap) => {
          snapshotAfter = snap.val();
        });
      } else {
        if (driver.kind === 'shared-worker') await tick();
        snapshotAfter = (await db.ref('items/guarded').get()).val();
      }

      return { errors, snapshotAfter };
    }

    const oracle = await runScenario(makeProdDriver());
    expect(oracle).toEqual({
      errors: {
        set: 'Error:Reference.set failed: onComplete argument must be a valid function.',
        update: 'Error:Reference.update failed: onComplete argument must be a valid function.',
        remove: 'Error:Reference.remove failed: onComplete argument must be a valid function.',
        pushWithVal: 'Error:Reference.push failed: onComplete argument must be a valid function.',
        pushEmpty: 'Error:Reference.push failed: onComplete argument must be a valid function.',
      },
      snapshotAfter: { keep: 'intact' },
    });

    for (const driver of makePyricDrivers()) {
      expect(await runScenario(driver)).toEqual(oracle);
    }
  });

  test('Database#ref(existingRef) resolves same-host References and rejects cross-shard References with host-mismatch error', async () => {
    async function runScenario(driver: DifferentialDriver) {
      const db = driver.db as Database;
      const shardDb = driver.openUrl('https://demo-org-shard.firebaseio.com') as Database;

      const orig = db.ref('orgs/o1/members');
      const cloned = db.ref(orig);
      const sameDbEqual = cloned.isEqual(orig);
      const sameDbUrl = cloned.toString();

      let crossShardError = 'accepted';
      try {
        shardDb.ref(orig);
      } catch (err) {
        crossShardError = (err as Error).message;
      }

      return { sameDbEqual, sameDbUrl, crossShardError };
    }

    const oracle = await runScenario(makeProdDriver());
    expect(oracle).toEqual({
      sameDbEqual: true,
      sameDbUrl: 'https://demo-org-default-rtdb.firebaseio.com/orgs/o1/members',
      crossShardError:
        'FIREBASE FATAL ERROR: refFromURL: Host name does not match the current database: (found demo-org-default-rtdb.firebaseio.com but expected demo-org-shard.firebaseio.com) ',
    });

    for (const driver of makePyricDrivers()) {
      expect(await runScenario(driver)).toEqual(oracle);
    }
  });

  test('isolates Database shells by canonical URL across default and legacy host aliases without mutating urlMeta or skipping fallback host validation', async () => {
    function runExplicitUrlScenario(driver: DifferentialDriver) {
      const defaultDb = driver.db as Database;
      const legacyDb = driver.openUrl('https://demo-org.firebaseio.com') as Database;

      const sameDefaultAgain = driver.openUrl('https://demo-org-default-rtdb.firebaseio.com') as Database;
      const distinctShells = defaultDb !== legacyDb;
      const cachedSameUrl = defaultDb === sameDefaultAgain;
      const defaultRefStr = defaultDb.ref('items/i1').toString();
      const legacyRefStr = legacyDb.ref('items/i1').toString();
      const crossAliasEqual = defaultDb.ref('items/i1').isEqual(legacyDb.ref('items/i1'));
      const legacySelfKey = legacyDb.refFromURL('https://demo-org.firebaseio.com/items/i1').key;

      let defaultAcceptsLegacy = 'accepted';
      try {
        defaultDb.refFromURL('https://demo-org.firebaseio.com/items/i1');
      } catch (err) {
        defaultAcceptsLegacy = (err as Error).message;
      }

      let defaultAcceptsForeign = 'accepted';
      try {
        defaultDb.refFromURL('https://foreign-org.firebaseio.com/items/i1');
      } catch (err) {
        defaultAcceptsForeign = (err as Error).message;
      }

      return {
        distinctShells,
        cachedSameUrl,
        defaultRefStr,
        legacyRefStr,
        crossAliasEqual,
        legacySelfKey,
        defaultAcceptsLegacy,
        defaultAcceptsForeign,
      };
    }

    const oracle = runExplicitUrlScenario(makeProdDriver());
    expect(oracle).toEqual({
      distinctShells: true,
      cachedSameUrl: true,
      defaultRefStr: 'https://demo-org-default-rtdb.firebaseio.com/items/i1',
      legacyRefStr: 'https://demo-org.firebaseio.com/items/i1',
      crossAliasEqual: false,
      legacySelfKey: 'i1',
      defaultAcceptsLegacy:
        'FIREBASE FATAL ERROR: refFromURL: Host name does not match the current database: (found demo-org.firebaseio.com but expected demo-org-default-rtdb.firebaseio.com) ',
      defaultAcceptsForeign:
        'FIREBASE FATAL ERROR: refFromURL: Host name does not match the current database: (found foreign-org.firebaseio.com but expected demo-org-default-rtdb.firebaseio.com) ',
    });

    for (const driver of makePyricDrivers()) {
      expect(runExplicitUrlScenario(driver)).toEqual(oracle);
    }

    // Pyric fallback convenience when databaseURL is omitted: enforces projectId default host
    // and never mutates urlMeta when getDatabaseWithUrl opens a legacy default alias.
    for (const driver of makePyricDrivers('demo-org', undefined)) {
      const fallbackDb = driver.db as Database;
      const mintedUrl = fallbackDb.ref('items/i1').toString();
      expect(mintedUrl).toBe('https://demo-org-default-rtdb.firebaseio.com/items/i1');
      expect(() => fallbackDb.refFromURL('https://foreign-org.firebaseio.com/items/i1')).toThrow(
        'FIREBASE FATAL ERROR: refFromURL: Host name does not match the current database: (found foreign-org.firebaseio.com but expected demo-org-default-rtdb.firebaseio.com) ',
      );

      const legacyDb = driver.openUrl('https://demo-org.firebaseio.com') as Database;
      expect(fallbackDb.refFromURL(mintedUrl).key).toBe('i1');
      expect(legacyDb.refFromURL('https://demo-org.firebaseio.com/items/i1').key).toBe('i1');

      await driver.write('items/sharedDefault', 'ok');
      expect((await legacyDb.ref('items/sharedDefault').get()).val()).toBe('ok');
    }
  });
});

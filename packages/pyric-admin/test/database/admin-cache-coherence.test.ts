/**
 * Regression suite for `AdminPathCache` wire-epoch descendant coherence, cold
 * `ServerValue.increment` non-fabrication, primitive-to-object ancestor
 * `.priority` preservation, and `databaseAuthVariableOverride` `.read: false`
 * pass-0 redaction across both `pyric-admin/database` arms.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  deleteApp as deleteProdApp,
  getApps as getProdApps,
  initializeApp as initializeProdApp,
} from 'firebase-admin/app';
import { getDatabase as getProdDatabase } from 'firebase-admin/database';
import * as modular from 'pyric/database';
import { initializeSandbox, type Sandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp, type PyricAdminApp } from '../../src/app/index.js';
import { AdminPathCache } from '../../src/database/admin-path-cache.js';
import { getDatabase, ServerValue } from '../../src/database/index.js';
import { sharedWorkerArm } from './arms.js';

const tick = (ms = 25): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let seq = 0;

interface ArmPair {
  readonly label: 'in-process' | 'remote';
  readonly app: PyricAdminApp;
  readonly host: Sandbox;
}

function makeArms(): ArmPair[] {
  const localHost = initializeSandbox({ projectId: 'demo-coherence' });
  modular.sandbox.setDefaultPolicy(modular.getDatabase(localHost), 'allow');
  const localApp = initializeApp(
    {
      sandbox: localHost,
      projectId: 'demo-coherence',
      databaseURL: 'https://demo-coherence-default-rtdb.firebaseio.com',
    },
    `coh-local-${++seq}`,
  );
  const remote = sharedWorkerArm();
  return [
    { label: 'in-process', app: localApp, host: localHost },
    { label: 'remote', app: remote.app, host: remote.host },
  ];
}

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
  await Promise.all(getProdApps().map((app) => deleteProdApp(app)));
});

describe('AdminPathCache coherence & security rules isolation (#1459, #1211)', () => {
  test('ancestor set/update with ServerValue.increment never double-applies when an active listener sits on a descendant (#1211)', async () => {
    for (const { label, app } of makeArms()) {
      const db = getDatabase(app);
      await db.ref('counters/views').set({ total: 10 });
      db.ref('counters/views').on('value', () => undefined);
      await tick();

      await db.ref('counters').update({ 'views/total': ServerValue.increment(5) });
      const afterUpdate: unknown[] = [];
      const cb1 = db.ref('counters/views').on('value', (s) => {
        afterUpdate.push(s.val());
      });
      await tick();
      db.ref('counters/views').off('value', cb1);
      expect({ label, afterUpdate }).toEqual({ label, afterUpdate: [{ total: 15 }] });

      await db.ref('counters').set({
        views: { total: ServerValue.increment(5) },
        sibling: 'ok',
      });
      const afterSet: unknown[] = [];
      const cb2 = db.ref('counters/views').on('value', (s) => {
        afterSet.push(s.val());
      });
      await tick();
      db.ref('counters/views').off();
      expect({ label, afterSet }).toEqual({ label, afterSet: [{ total: 20 }] });
    }
  });

  test('cold ServerValue.increment writes leave AdminPathCache cold rather than fabricating 0 + delta (#1211)', async () => {
    for (const { label, app, host } of makeArms()) {
      const hostAdmin = modular.getAdminDatabase(host);
      await modular.set(modular.ref(hostAdmin, 'c2/views'), { total: 10 });
      await modular.set(modular.ref(hostAdmin, 'c2/direct'), { total: 10 });
      await modular.setWithPriority(modular.ref(hostAdmin, 'c2/prioNode'), 'v', 4);

      const coldApp = initializeApp(
        {
          sandbox: app.sandbox,
          projectId: 'demo-coherence',
          databaseURL: 'https://demo-coherence-default-rtdb.firebaseio.com',
        },
        `coh-cold-${label}-${++seq}`,
      );
      const coldDb = getDatabase(coldApp);

      await coldDb.ref('c2/views').update({ total: ServerValue.increment(5) });
      const updateSeen: unknown[] = [];
      const updateRes = await coldDb.ref('c2/views/total').transaction((cur) => {
        updateSeen.push(cur);
        if (cur === null) {
          return -1;
        }
        return undefined;
      });
      expect(updateRes.committed).toBe(false);
      expect({ label, updateSeen }).toEqual({ label, updateSeen: [null, 15] });
      expect(updateRes.snapshot.val()).toBe(15);

      await coldDb.ref('c2/direct').set({ total: ServerValue.increment(5) });
      const setSeen: unknown[] = [];
      const setRes = await coldDb.ref('c2/direct/total').transaction((cur) => {
        setSeen.push(cur);
        if (cur === null) {
          return -1;
        }
        return undefined;
      });
      expect(setRes.committed).toBe(false);
      expect({ label, setSeen }).toEqual({ label, setSeen: [null, 15] });
      expect(setRes.snapshot.val()).toBe(15);

      await coldDb.ref('c2/prioNode').set({ a: 1, '.priority': ServerValue.increment(5) });
      expect((await coldDb.ref('c2/prioNode').get()).getPriority()).toBe(9);
    }
  });

  test('writing a non-null child beneath a prioritized primitive leaf preserves the ancestor .priority (#1459)', async () => {
    const prodApp = initializeProdApp(
      { projectId: 'demo-prim-1459', databaseURL: 'https://demo-prim-1459-default-rtdb.firebaseio.com' },
      `prod-prim-${++seq}`,
    );
    const prodDb = getProdDatabase(prodApp);
    prodDb.goOffline();
    void prodDb.ref('prim').setWithPriority('hello', 7);
    void prodDb.ref('prim/child').set('world');
    let prodExport: unknown;
    prodDb.ref('prim').once('value', (s) => {
      prodExport = s.exportVal();
    });
    expect(prodExport).toEqual({ child: 'world', '.priority': 7 });

    const unitCache = new AdminPathCache();
    unitCache.recordSet('/prim', 'hello', 7);
    unitCache.recordSet('/prim/child', 'world');
    expect(unitCache.readSnapshot('/prim').exported).toEqual({ child: 'world', '.priority': 7 });

    for (const { label, app } of makeArms()) {
      const db = getDatabase(app);
      db.ref('/').on('value', () => undefined);
      await tick();
      await db.ref('prim').setWithPriority('hello', 7);
      await db.ref('prim/child').set('world');
      await tick();

      const warmExports: unknown[] = [];
      db.ref('prim').on('value', (s) => {
        warmExports.push(s.exportVal());
      });
      await tick();
      db.ref('/').off();
      db.ref('prim').off();
      expect({ label, warmExports }).toEqual({ label, warmExports: [prodExport] });
    }
  });

  test('databaseAuthVariableOverride never warms or leaks .read: false data on pass-0 transactions after writes or setRules', async () => {
    const writeOnlyRules = {
      rules: {
        room: {
          '.read': false,
          '.write': "auth != null && auth.uid === 'u1'",
        },
      },
    };
    const openRules = {
      rules: {
        room: {
          '.read': "auth != null && auth.uid === 'u1'",
          '.write': "auth != null && auth.uid === 'u1'",
        },
      },
    };

    for (const { label, app, host } of makeArms()) {
      const adminDb = getDatabase(app);
      await adminDb.setRules(writeOnlyRules);

      const scopedApp = initializeApp(
        {
          sandbox: app.sandbox,
          projectId: 'demo-coherence',
          databaseURL: 'https://demo-coherence-default-rtdb.firebaseio.com',
          databaseAuthVariableOverride: { uid: 'u1' },
        },
        `coh-scoped-${label}-${++seq}`,
      );
      const scopedDb = getDatabase(scopedApp);

      await scopedDb.ref('room').set({ secret: 999 });
      const hostAdmin = modular.getAdminDatabase(host);
      await modular.set(modular.ref(hostAdmin, 'room'), { secret: 12345 });

      const seenWriteOnly: unknown[] = [];
      const tx1 = await scopedDb.ref('room').transaction((cur) => {
        seenWriteOnly.push(cur);
        if (cur === null) {
          return { ok: 1 };
        }
        return undefined;
      });
      expect(tx1.committed).toBe(true);
      expect({ label, seenWriteOnly }).toEqual({ label, seenWriteOnly: [null] });

      // Even after a committed write-only transaction, /room stays uncached when .read is false.
      await modular.set(modular.ref(hostAdmin, 'room'), { secret: 67890 });
      const seenSecondTx: unknown[] = [];
      await scopedDb.ref('room').transaction((cur) => {
        seenSecondTx.push(cur);
        return undefined;
      });
      expect({ label, seenSecondTx }).toEqual({ label, seenSecondTx: [null] });

      // Warm /room while .read is true, then revoke .read via adminDb.setRules: pass-0 must reset to null.
      await adminDb.setRules(openRules);
      expect((await scopedDb.ref('room').get()).val()).toEqual({ secret: 67890 });
      await adminDb.setRules(writeOnlyRules);
      await modular.set(modular.ref(hostAdmin, 'room'), { secret: 55555 });
      const seenAfterRevoke: unknown[] = [];
      await scopedDb.ref('room').transaction((cur) => {
        seenAfterRevoke.push(cur);
        return undefined;
      });
      expect({ label, seenAfterRevoke }).toEqual({ label, seenAfterRevoke: [null] });
    }
  });
});

/**
 * Focused regression and differential parity suite for `pyric-admin/database`
 * issues `#1459` (remote-arm snapshot priorities), `#1420` (`val()` and
 * transaction `(priority, nameCompare)` key ordering on both arms), and `#1211`
 * (`ServerValue.TIMESTAMP` / `ServerValue.increment()` resolution, inline
 * sentinel priorities, warm cache coherence, and `set(undefined)` parity),
 * including a real hosted `node --import @pyric/cli/register` entry-point test.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { deleteApp as deleteProdApp, getApps as getProdApps, initializeApp as initializeProdApp } from 'firebase-admin/app';
import { getDatabase as getProdDatabase, ServerValue as ProdServerValue } from 'firebase-admin/database';
import * as modular from 'pyric/database';
import { initializeSandbox, type Sandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp, type PyricAdminApp } from '../../src/app/index.js';
import { getDatabase, ServerValue, type DataSnapshot } from '../../src/database/index.js';
import { inProcessApp, sharedWorkerApp, sharedWorkerArm } from './arms.js';

const tick = (ms = 25): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let seq = 0;

interface ArmHarness {
  readonly label: 'in-process' | 'remote';
  readonly app: PyricAdminApp;
  readonly host: Sandbox;
}

function makeArms(): ArmHarness[] {
  const localHost = initializeSandbox({ projectId: 'demo-fu' });
  modular.sandbox.setDefaultPolicy(modular.getDatabase(localHost), 'allow');
  const localApp = initializeApp(
    { sandbox: localHost, projectId: 'demo-fu', databaseURL: 'https://demo-fu-default-rtdb.firebaseio.com' },
    `fu-local-${++seq}`,
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

describe('#1459: pyric-admin remote-arm and local-arm snapshots preserve host priorities across cold, warm, and mutated reads', () => {
  test('reproduces #1459 verbatim: client setWithPriority(ref(db, "c"), 5, 3) reads back priority 3 and { ".value": 5, ".priority": 3 } on both arms', async () => {
    for (const { label, app, host } of makeArms()) {
      const clientDb = modular.getDatabase(host);
      await modular.setWithPriority(modular.ref(clientDb, 'c'), 5, 3);

      const adminDb = getDatabase(app);
      const getSnap = await adminDb.ref('c').get();
      const onceSnap = await adminDb.ref('c').once('value');
      let onSnap: DataSnapshot | null = null;
      const cb = adminDb.ref('c').on('value', (s) => {
        onSnap = s;
      });
      await tick();
      adminDb.ref('c').off('value', cb);

      for (const snap of [getSnap, onceSnap, onSnap]) {
        expect(snap).not.toBeNull();
        if (snap !== null) {
          const observed = { label, val: snap.val(), prio: snap.getPriority(), exp: snap.exportVal(), json: snap.toJSON() };
          expect(observed).toEqual({ label, val: 5, prio: 3, exp: { '.value': 5, '.priority': 3 }, json: { '.value': 5, '.priority': 3 } });
        }
      }
    }
  });

  test('warm second on("value") listener preserves priorities and priority-then-key order in a single delivery matching firebase-admin', async () => {
    const prodApp = initializeProdApp(
      { projectId: 'demo-warm-1459', databaseURL: 'https://demo-warm-1459-default-rtdb.firebaseio.com' },
      `prod-warm-${++seq}`,
    );
    const prodDb = getProdDatabase(prodApp);
    prodDb.goOffline();
    void prodDb.ref('ranked').set({
      a: { '.value': 'alpha', '.priority': 30 },
      b: { '.value': 'beta', '.priority': 10 },
      '.priority': 'root-prio',
    });

    const prodSecond: Array<{ keys: string[]; prio: string | number | null; exportVal: unknown }> = [];
    prodDb.ref('ranked').on('value', () => undefined);
    prodDb.ref('ranked').on('value', (s) => {
      prodSecond.push({
        keys: Object.keys(s.val() as object),
        prio: s.getPriority(),
        exportVal: s.exportVal(),
      });
    });
    prodDb.ref('ranked').off();

    expect(prodSecond).toEqual([{
      keys: ['b', 'a'],
      prio: 'root-prio',
      exportVal: { b: { '.value': 'beta', '.priority': 10 }, a: { '.value': 'alpha', '.priority': 30 }, '.priority': 'root-prio' },
    }]);

    for (const { label, app, host } of makeArms()) {
      const clientDb = modular.getAdminDatabase(host);
      await modular.setWithPriority(modular.ref(clientDb, 'ranked/a'), 'alpha', 30);
      await modular.setWithPriority(modular.ref(clientDb, 'ranked/b'), 'beta', 10);
      await modular.setPriority(modular.ref(clientDb, 'ranked'), 'root-prio');

      const adminDb = getDatabase(app);
      adminDb.ref('ranked').on('value', () => undefined);
      await tick();

      const secondDeliveries: Array<{ keys: string[]; prio: string | number | null; exportVal: unknown }> = [];
      adminDb.ref('ranked').on('value', (s) => {
        secondDeliveries.push({
          keys: Object.keys(s.val() as object),
          prio: s.getPriority(),
          exportVal: s.exportVal(),
        });
      });
      await tick();
      adminDb.ref('ranked').off();

      expect({ label, secondDeliveries }).toEqual({ label, secondDeliveries: prodSecond });
    }
  });

  test('warm listener after admin setWithPriority, setPriority, and update(.priority) under an active root listener carries exact priorities', async () => {
    for (const { label, app } of makeArms()) {
      const db = getDatabase(app);
      db.ref('/').on('value', () => undefined);
      await tick();

      await db.ref('sub/leaf').setWithPriority('hello', 7);
      await db.ref('sub/obj').set({ x: 1, y: 2 });
      await db.ref('sub/obj').setPriority('obj-prio', () => undefined);
      await db.ref('sub/obj').update({ 'x/.priority': 20, 'y/.priority': 5 });
      await tick();

      const leafDeliveries: unknown[] = [];
      db.ref('sub/leaf').on('value', (s) => {
        leafDeliveries.push({ val: s.val(), prio: s.getPriority(), exportVal: s.exportVal() });
      });
      const objDeliveries: unknown[] = [];
      db.ref('sub/obj').on('value', (s) => {
        objDeliveries.push({
          keys: Object.keys(s.val() as object),
          prio: s.getPriority(),
          exportVal: s.exportVal(),
        });
      });
      await tick();
      db.ref('/').off();
      db.ref('sub/leaf').off();
      db.ref('sub/obj').off();

      expect({ label, leafDeliveries }).toEqual({ label, leafDeliveries: [{ val: 'hello', prio: 7, exportVal: { '.value': 'hello', '.priority': 7 } }] });
      expect({ label, objDeliveries }).toEqual({
        label,
        objDeliveries: [{ keys: ['y', 'x'], prio: 'obj-prio', exportVal: { y: { '.value': 2, '.priority': 5 }, x: { '.value': 1, '.priority': 20 }, '.priority': 'obj-prio' } }],
      });
    }
  });
});

describe('#1420: pyric-admin snapshot val() and transaction update inputs follow priority-then-key order on both arms', () => {
  test('orders val(), exportVal(), toJSON(), forEach(), child(), and transaction(currentData) keys identically to firebase-admin', async () => {
    const prodApp = initializeProdApp(
      { projectId: 'demo-order-1420', databaseURL: 'https://demo-order-1420-default-rtdb.firebaseio.com' },
      `prod-order-${++seq}`,
    );
    const prodDb = getProdDatabase(prodApp);
    prodDb.goOffline();

    void prodDb.ref('plain').set({ b: 1, a: 3, c: 2 });
    let prodPlainKeys: string[] = [];
    prodDb.ref('plain').once('value', (s) => {
      prodPlainKeys = Object.keys(s.val() as object);
    });

    const mixedPayload = {
      dNoPrioB: 'null-b',
      dNoPrioA: 'null-a',
      strBeta: { '.value': 'sb', '.priority': 'beta' },
      numPos: { '.value': 'np', '.priority': 20 },
      strAlpha: { '.value': 'sa', '.priority': 'alpha' },
      numNeg: { '.value': 'nn', '.priority': -5 },
      nested: {
        z: { '.value': 1, '.priority': 2 },
        m: { '.value': 2, '.priority': 1 },
        '.priority': 0,
      },
    };
    void prodDb.ref('mixed').set(mixedPayload);
    let prodMixedValKeys: string[] = [];
    let prodMixedNestedKeys: string[] = [];
    const prodForEachKeys: string[] = [];
    let prodTxKeys: string[] = [];
    prodDb.ref('mixed').once('value', (s) => {
      const valObj = s.val() as { nested: object };
      prodMixedValKeys = Object.keys(valObj);
      prodMixedNestedKeys = Object.keys(valObj.nested);
      s.forEach((child) => {
        if (child.key !== null) prodForEachKeys.push(child.key);
      });
    });
    void prodDb.ref('mixed').transaction((current) => {
      if (current !== null && typeof current === 'object') {
        prodTxKeys = Object.keys(current);
      }
      return current;
    });

    expect(prodPlainKeys).toEqual(['a', 'b', 'c']);
    expect(prodMixedValKeys).toEqual(['dNoPrioA', 'dNoPrioB', 'numNeg', 'nested', 'numPos', 'strAlpha', 'strBeta']);
    expect(prodMixedNestedKeys).toEqual(['m', 'z']);
    expect(prodForEachKeys).toEqual(prodMixedValKeys);
    expect(prodTxKeys).toEqual(prodMixedValKeys);

    for (const { label, app, host } of makeArms()) {
      const db = getDatabase(app);
      await db.ref('plain').set({ b: 1, a: 3, c: 2 });
      const plainSnap = await db.ref('plain').get();
      expect({ label, keys: Object.keys(plainSnap.val() as object) }).toEqual({
        label,
        keys: prodPlainKeys,
      });

      await db.ref('mixed').set(mixedPayload);
      const mixedSnap = await db.ref('mixed').get();
      const mixedVal = mixedSnap.val() as { nested: object };
      const walked: string[] = [];
      mixedSnap.forEach((child) => {
        if (child.key !== null) walked.push(child.key);
      });
      expect({ label, valKeys: Object.keys(mixedVal) }).toEqual({ label, valKeys: prodMixedValKeys });
      expect({ label, nestedKeys: Object.keys(mixedVal.nested) }).toEqual({ label, nestedKeys: prodMixedNestedKeys });
      expect({ label, walked }).toEqual({ label, walked: prodForEachKeys });

      // Warm pass-0 transaction key order.
      const warmTxSeen: string[][] = [];
      await db.ref('mixed').transaction((current) => {
        if (current !== null && typeof current === 'object') {
          warmTxSeen.push(Object.keys(current));
        }
        return current;
      });
      expect({ label, warmTxSeen }).toEqual({ label, warmTxSeen: [prodTxKeys] });

      // Cold -> retry transaction key order via fresh app on same host.
      const clientDb = modular.getAdminDatabase(host);
      await modular.setWithPriority(modular.ref(clientDb, 'coldTx/b'), 1, 20);
      await modular.setWithPriority(modular.ref(clientDb, 'coldTx/a'), 2, 30);
      await modular.setWithPriority(modular.ref(clientDb, 'coldTx/c'), 3, 10);
      const coldApp = initializeApp(
        { sandbox: app.sandbox, projectId: 'demo-fu', databaseURL: 'https://demo-fu-default-rtdb.firebaseio.com' },
        `fu-cold-${label}-${++seq}`,
      );
      const coldSeen: Array<string[] | null> = [];
      const coldRes = await getDatabase(coldApp).ref('coldTx').transaction((current) => {
        if (current === null) {
          coldSeen.push(null);
          return { probe: true };
        }
        if (typeof current === 'object') {
          coldSeen.push(Object.keys(current));
        }
        return undefined;
      });
      expect(coldRes.committed).toBe(false);
      expect({ label, coldSeen }).toEqual({ label, coldSeen: [null, ['c', 'b', 'a']] });
      expect(Object.keys(coldRes.snapshot.val() as object)).toEqual(['c', 'b', 'a']);

      const commitApp = initializeApp(
        { sandbox: app.sandbox, projectId: 'demo-fu', databaseURL: 'https://demo-fu-default-rtdb.firebaseio.com' },
        `fu-commit-${label}-${++seq}`,
      );
      const commitRes = await getDatabase(commitApp).ref('coldTx').transaction((current) => {
        if (current === null) return { probe: true };
        return {
          a: { '.value': 20, '.priority': 30 },
          b: { '.value': 10, '.priority': 20 },
          c: { '.value': 30, '.priority': 10 },
        };
      });
      expect(commitRes.committed).toBe(true);
      expect(Object.keys(commitRes.snapshot.val() as object)).toEqual(['c', 'b', 'a']);
    }
  });
});

describe('#1211: ServerValue.TIMESTAMP and ServerValue.increment() resolve across values, inline priorities, and warm caches on both arms', () => {
  test('resolves inline .priority ServerValue.TIMESTAMP and ServerValue.increment(delta) identically across firebase-admin and both arms', async () => {
    const prodApp = initializeProdApp(
      { projectId: 'demo-sv-1211', databaseURL: 'https://demo-sv-1211-default-rtdb.firebaseio.com' },
      `prod-sv-${++seq}`,
    );
    const prodDb = getProdDatabase(prodApp);
    prodDb.goOffline();
    void prodDb.ref('incPrio').set({ a: 1, '.priority': 10 });
    void prodDb.ref('incPrio').set({ a: 2, '.priority': ProdServerValue.increment(5) });
    let prodIncExport: unknown;
    prodDb.ref('incPrio').once('value', (s) => {
      prodIncExport = s.exportVal();
    });
    expect(prodIncExport).toEqual({ a: 2, '.priority': 15 });

    for (const [arm, makeApp] of [['in-process', inProcessApp], ['remote', sharedWorkerApp]] as const) {
      const db = getDatabase(makeApp());
      const before = Date.now();

      await db.ref('objTsPrio').set({ a: 1, '.priority': ServerValue.TIMESTAMP });
      await db.ref('leafTsPrio').set({ '.value': 'hi', '.priority': ServerValue.TIMESTAMP });
      await db.ref('svWithPrio').set({ '.sv': 'timestamp', '.priority': 5 });
      await db.ref('svExtraSibling').set({ '.sv': 'timestamp', ignored: 'dropped' });
      await db.ref('incPrio').set({ a: 1, '.priority': 10 });
      await db.ref('incPrio').set({ a: 2, '.priority': ServerValue.increment(5) });
      await db.ref('updPrio').set({ child: { k: 1 }, scalar: 'v' });
      await db.ref('updPrio').update({
        child: { k: 2, '.priority': ServerValue.TIMESTAMP },
        'scalar/.priority': ServerValue.increment(4),
      });
      const pushed = await db.ref('pushedPrio').push({ ok: true, '.priority': ServerValue.TIMESTAMP });
      await db.ref('swpNullOverride').setWithPriority({ a: 1, '.priority': null }, 50);

      const objSnap = await db.ref('objTsPrio').get();
      expect(typeof objSnap.getPriority()).toBe('number');
      expect(objSnap.getPriority() as number).toBeGreaterThanOrEqual(before);

      const leafSnap = await db.ref('leafTsPrio').get();
      expect(leafSnap.val()).toBe('hi');
      expect(typeof leafSnap.getPriority()).toBe('number');

      const svPrioSnap = await db.ref('svWithPrio').get();
      expect(typeof svPrioSnap.val()).toBe('number');
      expect(svPrioSnap.getPriority()).toBe(5);

      const svExtraSnap = await db.ref('svExtraSibling').get();
      expect(typeof svExtraSnap.val()).toBe('number');
      expect(svExtraSnap.getPriority()).toBeNull();

      expect({ arm, inc: (await db.ref('incPrio').get()).exportVal() }).toEqual({ arm, inc: prodIncExport });

      const updSnap = await db.ref('updPrio').get();
      expect(typeof updSnap.child('child').getPriority()).toBe('number');
      expect(updSnap.child('scalar').exportVal()).toEqual({ '.value': 'v', '.priority': 4 });

      expect(typeof (await pushed.get()).getPriority()).toBe('number');
      expect((await db.ref('swpNullOverride').get()).getPriority()).toBeNull();
    }
  });

  test('remote ServerValue writes never leak raw .sv objects into warm on("value") listeners or pass-0 transactions', async () => {
    for (const [arm, makeApp] of [['in-process', inProcessApp], ['remote', sharedWorkerApp]] as const) {
      const db = getDatabase(makeApp());
      db.ref('liveCounter').on('value', () => undefined);
      await tick();

      await db.ref('liveCounter').set({
        n: ServerValue.increment(5),
        at: ServerValue.TIMESTAMP,
      });
      const warmValues: Array<{ n: unknown; at: unknown }> = [];
      db.ref('liveCounter').on('value', (s) => {
        warmValues.push(s.val() as { n: unknown; at: unknown });
      });
      await tick();
      db.ref('liveCounter').off();

      expect(warmValues).toHaveLength(1);
      expect({ arm, n: warmValues[0]?.n, atType: typeof warmValues[0]?.at }).toEqual({ arm, n: 5, atType: 'number' });

      await db.ref('txCounter').get();
      await db.ref('txCounter').set({
        n: ServerValue.increment(7),
        at: ServerValue.TIMESTAMP,
      });
      const txSeen: Array<{ n: unknown; at: unknown }> = [];
      const txRes = await db.ref('txCounter').transaction((current) => {
        if (current === null) return undefined;
        const rec = current as { n: number; at: number };
        txSeen.push({ n: rec.n, at: rec.at });
        return { n: rec.n + 1, at: rec.at };
      });
      expect(txRes.committed).toBe(true);
      expect(typeof txSeen[0]?.n).toBe('number');
      expect(typeof txSeen[0]?.at).toBe('number');
      expect((txRes.snapshot.val() as { n: number }).n).toBe(8);
    }
  });
});

describe('hosted node --import @pyric/cli/register integration (#1459, #1420, #1211)', () => {
  test(
    'a registered Node process reads host priorities, priority-ordered val() keys, and resolved ServerValue writes via firebase-admin',
    async () => {
      const cacheParent = join(homedir(), '.cache', 'pyric-test-tmp');
      mkdirSync(cacheParent, { recursive: true });
      const directory = mkdtempSync(join(cacheParent, 'admin-rtdb-followups-hosted-'));
      const ownerMarker = join(directory, '.pyric-test-owner');
      writeFileSync(ownerMarker, 'admin-rtdb-followups');
      try {
        const repoRoot = new URL('../../../../', import.meta.url).pathname;
        symlinkSync(join(repoRoot, 'node_modules'), join(directory, 'node_modules'), 'dir');

        const cliDist = new URL('../../../cli/dist/', import.meta.url).href;
        const adminDist = new URL('../../dist/', import.meta.url).href;
        const childSource = `
          import { initializeApp as initAdmin } from 'firebase-admin/app';
          import { getDatabase as getAdminDb, ServerValue } from 'firebase-admin/database';

          const config = { projectId: 'demo-app', databaseURL: 'https://demo-app-default-rtdb.firebaseio.com' };
          const admin = getAdminDb(initAdmin(config));

          const cSnap = await admin.ref('c').get();
          await new Promise((resolve) => admin.ref('c').once('value', () => resolve()));
          let warmPrio = null;
          let warmExport = null;
          admin.ref('c').on('value', (s) => {
            if (warmPrio === null) {
              warmPrio = s.getPriority();
              warmExport = s.exportVal();
            }
          });
          await new Promise((resolve) => setTimeout(resolve, 25));
          admin.ref('c').off();

          const ordSnap = await admin.ref('ordered').get();
          let txKeys = null;
          await admin.ref('ordered').transaction((cur) => {
            if (cur === null) return { probe: true };
            txKeys = Object.keys(cur);
            return undefined;
          });

          await admin.ref('sv').set({ count: ServerValue.increment(4), at: ServerValue.TIMESTAMP });
          const svSnap = await admin.ref('sv').get();

          const syncThrow = (fn) => {
            try {
              fn();
              return null;
            } catch (err) {
              return err instanceof Error ? err.message : String(err);
            }
          };

          process.stdout.write(JSON.stringify({
            cPrio: cSnap.getPriority(),
            cExport: cSnap.exportVal(),
            warmPrio,
            warmExport,
            ordKeys: Object.keys(ordSnap.val()),
            txKeys,
            svCount: svSnap.val().count,
            svAtType: typeof svSnap.val().at,
            undefError: syncThrow(() => admin.ref('bad').set(undefined)),
            infoError: syncThrow(() => admin.ref('.info/connected').set(true)),
            svError: syncThrow(() => admin.ref('bad').set({ '.sv': 'bogus' })),
          }) + '\\n');
          process.exit(0);
        `;

        const hostSource = `
          import assert from 'node:assert/strict';
          import { spawn } from 'node:child_process';
          import { once } from 'node:events';
          import { realpathSync } from 'node:fs';
          import { createServer } from 'node:http';
          import { deleteApp, initializeApp } from ${JSON.stringify(`${adminDist}app/index.js`)};
          import { getDatabase } from ${JSON.stringify(`${adminDist}database/index.js`)};
          import { createBridgeMount } from ${JSON.stringify(`${cliDist}serve/bridge-mount.js`)};
          import { connectRemoteSandbox } from ${JSON.stringify(`${cliDist}remote/index.js`)};

          const dir = realpathSync(process.argv[2]);
          const childScript = process.argv[3];
          const SESSION = 'session-admin-rtdb-followups';
          const ALLOW_ALL = JSON.stringify({ rules: { '.read': true, '.write': true } });

          const mount = createBridgeMount({ hosted: true, projectKey: dir, disableAuditLog: true });
          const server = createServer((req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost');
            if (url.pathname === '/__pyric/init.json') {
              res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sessionToken: SESSION }));
              return;
            }
            void mount.handler(req, res, url).then((handled) => {
              if (!handled) res.writeHead(404).end();
            });
          });
          server.listen(0, '127.0.0.1');
          await once(server, 'listening');
          const addr = server.address();
          assert.ok(addr && typeof addr === 'object');
          const base = 'http://127.0.0.1:' + addr.port;

          await mount.startHostedSandbox({
            rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
            bridgeUrl: null, seed: null, capture: false, hosted: true,
            projectKey: dir, sessionToken: SESSION,
          }, base);
          mount.attachHost({ servers: [server], projectDir: dir, origin: () => ({ host: '127.0.0.1', port: addr.port }) });
          await mount.deployHostedRules('database', ALLOW_ALL);

          const seederRemote = await connectRemoteSandbox({ url: base });
          const seederApp = initializeApp({ sandbox: seederRemote, projectId: 'demo-app' }, 'seeder');
          const seederDb = getDatabase(seederApp);
          await seederDb.ref('c').setWithPriority(5, 3);
          await seederDb.ref('ordered/b').setWithPriority('second', 20);
          await seederDb.ref('ordered/a').setWithPriority('third', 30);
          await seederDb.ref('ordered/c').setWithPriority('first', 10);

          const registerUrl = ${JSON.stringify(`${cliDist}register/index.js`)};
          const health = await (await fetch(base + '/__pyric/health')).json();
          try {
            const child = spawn(process.execPath, ['--import', registerUrl, childScript], {
              cwd: dir,
              env: {
                ...process.env,
                PYRIC_SANDBOX: 'remote:' + base,
                PYRIC_SANDBOX_INSTANCE: health.instanceId,
                PYRIC_PROCESS_HEALTH: 'off',
              },
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            let out = '';
            let err = '';
            child.stdout.on('data', (chunk) => { out += String(chunk); });
            child.stderr.on('data', (chunk) => { err += String(chunk); });
            const [code] = await once(child, 'exit');
            assert.equal(code, 0, 'child stderr: ' + err);
            process.stdout.write(out.trim() + '\\n');
          } finally {
            await deleteApp(seederApp);
            await seederRemote.close?.();
            await mount.close();
            server.close();
          }
        `;

        const childEntry = join(directory, 'child-src.ts');
        const hostEntry = join(directory, 'host-src.ts');
        writeFileSync(childEntry, childSource);
        writeFileSync(hostEntry, hostSource);

        const childBuild = await Bun.build({ entrypoints: [childEntry], outdir: directory, target: 'node', packages: 'external', naming: 'child.mjs' });
        const hostBuild = await Bun.build({ entrypoints: [hostEntry], outdir: directory, target: 'node', packages: 'external', naming: 'host.mjs' });
        expect(childBuild.success).toBe(true);
        expect(hostBuild.success).toBe(true);

        const run = spawnSync(
          process.env.PYRIC_TEST_NODE ?? 'node',
          [join(directory, 'host.mjs'), directory, join(directory, 'child.mjs')],
          { encoding: 'utf8', timeout: 30_000 },
        );
        if (run.status !== 0) {
          throw new Error(`Hosted follow-ups scenario failed (${run.status}): ${run.stderr}\n${run.stdout}`);
        }
        const parsed = JSON.parse(run.stdout.trim()) as Record<string, unknown>;
        expect(parsed).toEqual({
          cPrio: 3,
          cExport: { '.value': 5, '.priority': 3 },
          warmPrio: 3,
          warmExport: { '.value': 5, '.priority': 3 },
          ordKeys: ['c', 'b', 'a'],
          txKeys: ['c', 'b', 'a'],
          svCount: 4,
          svAtType: 'number',
          undefError: "set failed: value argument contains undefined in property 'bad'",
          infoError: "set failed = Can't modify data under /.info/",
          svError: 'Firebase Database (12.19.0) INTERNAL ASSERT FAILED: Unexpected server value: bogus',
        });
      } finally {
        const realParent = realpathSync(cacheParent);
        if (
          existsSync(ownerMarker) &&
          !lstatSync(directory).isSymbolicLink() &&
          realpathSync(directory).startsWith(`${realParent}/`)
        ) {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    },
    45_000,
  );
});

/**
 * Dual-arm parity tests for `pyric-admin/database` `Reference#onDisconnect()`
 * (`set`, `setWithPriority`, `update`, `remove`, `cancel`) and
 * `Database#goOffline()` / `Database#goOnline()`, plus a real hosted Node
 * integration test proving child-process exit drains its admin queue.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getDatabase as getModularDatabase,
  sandbox as databaseSandbox,
} from 'pyric/database';
import { initializeSandbox, type Sandbox } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp, type PyricAdminApp } from '../../src/app/index.js';
import {
  getDatabase,
  getDatabaseWithUrl,
  ServerValue,
} from '../../src/database/index.js';
import { sharedWorkerArm } from './arms.js';

interface ArmContext {
  readonly app: PyricAdminApp;
  readonly host: Sandbox;
}

const ARMS: ReadonlyArray<{ name: string; make: () => ArmContext }> = [
  {
    name: 'in-process',
    make: () => {
      const host = initializeSandbox();
      databaseSandbox.setDefaultPolicy(getModularDatabase(host), 'allow');
      const app = initializeApp(
        { sandbox: host, projectId: 'demo-ondisconnect' },
        `ondisconnect-local-${Math.random().toString(36).slice(2)}`,
      );
      return { app, host };
    },
  },
  { name: 'remote (SharedWorker bridge)', make: () => sharedWorkerArm() },
];

const tick = (ms = 25): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function setRules(host: Sandbox, rules: { rules: Record<string, unknown> }, url?: string): void {
  databaseSandbox.setRules(getModularDatabase(host, url), rules);
}

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe.each(ARMS)('pyric-admin/database onDisconnect & goOffline/goOnline [$name]', ({ make }) => {
  test('drains set, update, and remove on goOffline(), executes only once until re-registered after goOnline(), and notifies active listeners', async () => {
    const { app } = make();
    const db = getDatabase(app);

    await db.ref('sessions/s1').set({ state: 'online', retries: 1 });
    await db.ref('sessions/s2').set({ state: 'online', note: 'keep', obsolete: true });
    await db.ref('ephemeral/lock').set({ holder: 'w1' });

    const observedS1: unknown[] = [];
    db.ref('sessions/s1').on('value', (snap) => observedS1.push(snap.val()));
    await tick();

    await db.ref('sessions/s1').onDisconnect().set({ state: 'initial-draft' });
    // Later set at same path overwrites the earlier queued set.
    await db.ref('sessions/s1').onDisconnect().set({ state: 'offline' });
    await db.ref('sessions/s2').onDisconnect().update({
      state: 'disconnected',
      obsolete: null,
      'meta/reason': 'shutdown',
    });
    await db.ref('ephemeral/lock').onDisconnect().remove();

    // Nothing runs before goOffline().
    expect((await db.ref('sessions/s1').get()).val()).toEqual({ state: 'online', retries: 1 });
    expect((await db.ref('ephemeral/lock').get()).exists()).toBe(true);

    db.goOffline();
    await tick();
    db.goOnline();
    await tick();

    expect((await db.ref('sessions/s1').get()).val()).toEqual({ state: 'offline' });
    expect((await db.ref('sessions/s2').get()).val()).toEqual({
      state: 'disconnected',
      note: 'keep',
      meta: { reason: 'shutdown' },
    });
    expect((await db.ref('ephemeral/lock').get()).exists()).toBe(false);
    expect(observedS1[observedS1.length - 1]).toEqual({ state: 'offline' });

    // A second goOffline() does NOT resurrect already-drained operations.
    await db.ref('sessions/s1').set({ state: 'back-online' });
    db.goOffline();
    await tick();
    db.goOnline();
    await tick();
    expect((await db.ref('sessions/s1').get()).val()).toEqual({ state: 'back-online' });

    // Registering a fresh operation after goOnline() drains cleanly on the next goOffline().
    await db.ref('sessions/s1').onDisconnect().set({ state: 'offline-cycle-2' });
    db.goOffline();
    await tick();
    db.goOnline();
    await tick();
    expect((await db.ref('sessions/s1').get()).val()).toEqual({ state: 'offline-cycle-2' });

    db.ref('sessions/s1').off();
  });

  test('supports exact-path, ancestor, and child-subtree cancel() semantics', async () => {
    const { app } = make();
    const db = getDatabase(app);

    await db.ref('presence').set({
      a: 'alive',
      b: 'alive',
      group: { x: 1, y: 2 },
      whole: { keepGone: 'before', stayAlive: 'before' },
    });

    await db.ref('presence/a').onDisconnect().remove();
    await db.ref('presence/a').onDisconnect().cancel();

    await db.ref('presence/group/x').onDisconnect().set(10);
    await db.ref('presence/group/y').onDisconnect().set(20);
    // Cancelling parent clears all queued descendant operations.
    await db.ref('presence/group').onDisconnect().cancel();

    await db.ref('presence/whole').onDisconnect().set({ keepGone: 'after', stayAlive: 'after' });
    // Cancelling one child preserves sibling writes in a parent set.
    await db.ref('presence/whole/stayAlive').onDisconnect().cancel();

    await db.ref('presence/b').onDisconnect().set('gone');

    db.goOffline();
    await tick();
    db.goOnline();
    await tick();

    expect((await db.ref('presence').get()).val()).toEqual({
      a: 'alive',
      b: 'gone',
      group: { x: 1, y: 2 },
      whole: { keepGone: 'after', stayAlive: 'before' },
    });
  });

  test('validates priority synchronously in setWithPriority and drops valid priorities consistently with AS1', async () => {
    const { app } = make();
    const db = getDatabase(app);
    const itemRef = db.ref('items/p1');

    expect(() => itemRef.onDisconnect().setWithPriority('v', true as unknown as number)).toThrow(/Firebase priority/);
    expect(() => itemRef.onDisconnect().setWithPriority('v', Number.NaN)).toThrow(/Firebase priority/);
    expect(() => itemRef.onDisconnect().setWithPriority('v', Number.POSITIVE_INFINITY)).toThrow(/Firebase priority/);
    expect(() => itemRef.onDisconnect().setWithPriority('v', { bad: 1 } as unknown as string)).toThrow(/Firebase priority/);
    expect(() => itemRef.onDisconnect().setWithPriority('v', undefined as unknown as null)).toThrow(/Firebase priority/);

    await itemRef.onDisconnect().setWithPriority({ label: 'dropped-prio', '.priority': 9 }, 42);
    await db.ref('items/p2').onDisconnect().setWithPriority('scalar-val', 'alpha');
    await db.ref('items/p3').onDisconnect().update({ tag: 'u', '.priority': 5 });
    await db
      .ref('items/p4')
      .onDisconnect()
      .setWithPriority('ts-prio-dropped', ServerValue.TIMESTAMP as unknown as number);

    db.goOffline();
    await tick();
    db.goOnline();
    await tick();

    const s1 = await itemRef.get();
    expect(s1.val()).toEqual({ label: 'dropped-prio' });
    expect(s1.exportVal()).toEqual({ label: 'dropped-prio' });
    expect(s1.getPriority()).toBeNull();

    const s2 = await db.ref('items/p2').get();
    expect(s2.val()).toBe('scalar-val');
    expect(s2.getPriority()).toBeNull();

    const s3 = await db.ref('items/p3').get();
    expect(s3.exportVal()).toEqual({ tag: 'u' });
    expect(s3.getPriority()).toBeNull();

    const s4 = await db.ref('items/p4').get();
    expect(s4.val()).toBe('ts-prio-dropped');
    expect(s4.getPriority()).toBeNull();
  });

  test('bypasses .read/.write: false security rules and resolves ServerValue.TIMESTAMP and increment at drain time', async () => {
    const { app, host } = make();
    const db = getDatabase(app);

    await db.ref('workers/w1').set({ state: 'running', disconnects: 2 });
    setRules(host, { rules: { '.read': false, '.write': false } });

    await db.ref('workers/w1').onDisconnect().update({
      state: 'stopped',
      stoppedAt: ServerValue.TIMESTAMP,
      disconnects: ServerValue.increment(1),
    });
    await db.ref('workers/lastExit').onDisconnect().set(ServerValue.TIMESTAMP);

    // Mutate disconnects count AFTER registration and wait slightly so drain-time
    // evaluation proves both increment and TIMESTAMP resolve when goOffline() runs!
    await db.ref('workers/w1/disconnects').set(10);
    await tick(30);
    const beforeOffline = Date.now();
    db.goOffline();
    await tick();
    const afterOffline = Date.now();
    db.goOnline();
    await tick();

    const w1 = (await db.ref('workers/w1').get()).val() as {
      state: string;
      stoppedAt: number;
      disconnects: number;
    };
    expect(w1.state).toBe('stopped');
    expect(w1.disconnects).toBe(11);
    expect(typeof w1.stoppedAt).toBe('number');
    expect(w1.stoppedAt).toBeGreaterThanOrEqual(beforeOffline);
    expect(w1.stoppedAt).toBeLessThanOrEqual(afterOffline + 50);

    const lastExit = (await db.ref('workers/lastExit').get()).val() as number;
    expect(typeof lastExit).toBe('number');
    expect(lastExit).toBeGreaterThanOrEqual(beforeOffline);
  });

  test('enforces synchronous path/payload validation, invokes onComplete callbacks, and isolates sharded Database instances', async () => {
    const { app, host } = make();
    const shardUrl = 'https://demo-ondisconnect-shard.firebaseio.com';
    const primary = getDatabase(app);
    const shard = getDatabaseWithUrl(shardUrl, app);

    // Synchronous writable-path and payload checks.
    const infoOd = primary.ref('.info/connected').onDisconnect();
    expect(() => infoOd.set(true)).toThrow(/\.info/);
    expect(() => infoOd.setWithPriority(true, 1)).toThrow(/\.info/);
    expect(() => infoOd.update({ a: 1 })).toThrow(/\.info/);
    expect(() => infoOd.remove()).toThrow(/\.info/);

    const badRef = primary.ref('validated/node');
    expect(() => badRef.onDisconnect().set(undefined)).toThrow(/undefined/);
    expect(() => badRef.onDisconnect().set({ bad: Number.NaN })).toThrow(/NaN/);
    expect(() => badRef.onDisconnect().update(null as unknown as object)).toThrow(/must be an object/);
    expect(() => badRef.onDisconnect().update({ a: 1, 'a/b': 2 })).toThrow(/ancestor/);

    // onComplete(null) invocation + error propagation when onComplete throws.
    const callbacks: string[] = [];
    await badRef.onDisconnect().set({ step: 1 }, (err) => callbacks.push(`set:${String(err)}`));
    await badRef.onDisconnect().setWithPriority({ step: 2 }, 1, (err) => callbacks.push(`swp:${String(err)}`));
    await badRef.onDisconnect().update({ extra: true }, (err) => callbacks.push(`upd:${String(err)}`));
    await badRef.onDisconnect().remove((err) => callbacks.push(`rm:${String(err)}`));
    await badRef.onDisconnect().cancel((err) => callbacks.push(`cancel:${String(err)}`));
    expect(callbacks).toEqual(['set:null', 'swp:null', 'upd:null', 'rm:null', 'cancel:null']);

    await expect(
      badRef.onDisconnect().cancel(() => {
        throw new Error('onComplete boom');
      }),
    ).rejects.toThrow('onComplete boom');

    // Per-instance isolation: shard.goOffline() drains ONLY shard's queue.
    await primary.ref('status').set('online');
    await shard.ref('status').set('online');
    await primary.ref('status').onDisconnect().set('primary-offline');
    await shard.ref('status').onDisconnect().set('shard-offline');

    shard.goOffline();
    await tick();
    shard.goOnline();
    await tick();

    expect((await shard.ref('status').get()).val()).toBe('shard-offline');
    expect((await primary.ref('status').get()).val()).toBe('online');

    primary.goOffline();
    await tick();
    primary.goOnline();
    await tick();
    expect((await primary.ref('status').get()).val()).toBe('primary-offline');

    // sandbox.reset() drops queued operations without executing them on a later goOffline().
    await primary.ref('afterReset').onDisconnect().set('stale-from-previous-session');
    await host.reset();
    primary.goOffline();
    await tick();
    primary.goOnline();
    await tick();
    expect((await primary.ref('afterReset').get()).exists()).toBe(false);
  });
});

describe('pyric-admin/database hosted child-process exit onDisconnect drain', () => {
  test(
    'drains a child Node process admin onDisconnect queue (with rules bypass and ServerValue.TIMESTAMP) when the child exits without calling goOffline()',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'pyric-admin-ondisconnect-hosted-'));
      try {
        const repoRoot = new URL('../../../../', import.meta.url).pathname;
        symlinkSync(join(repoRoot, 'node_modules'), join(directory, 'node_modules'), 'dir');

        const cliDist = new URL('../../../cli/dist/', import.meta.url).href;
        const adminDist = new URL('../../dist/', import.meta.url).href;

        const childSource = `
          import { initializeApp } from ${JSON.stringify(`${adminDist}app/index.js`)};
          import { getDatabase, getDatabaseWithUrl, ServerValue } from ${JSON.stringify(`${adminDist}database/index.js`)};

          const shardUrl = process.env.TEST_SHARD_URL;
          const app = initializeApp({ projectId: 'demo-app' });
          const db = getDatabase(app);
          const shard = getDatabaseWithUrl(shardUrl, app);

          await db.ref('presence/worker-1').set({ state: 'online' });
          await db.ref('locks/active').set({ owner: 'worker-1' });
          await db.ref('presence/worker-1').onDisconnect().update({
            state: 'exited',
            exitedAt: ServerValue.TIMESTAMP,
          });
          await db.ref('locks/active').onDisconnect().remove();
          await db.ref('presence/cancelled').onDisconnect().set('should-not-write');
          await db.ref('presence/cancelled').onDisconnect().cancel();
          await shard.ref('presence/worker-1').onDisconnect().set({ shardState: 'exited' });
          process.stdout.write('child-registered\\n');
        `;

        const hostSource = `
          import assert from 'node:assert/strict';
          import { spawn } from 'node:child_process';
          import { once } from 'node:events';
          import { realpathSync } from 'node:fs';
          import { createServer } from 'node:http';
          import { deleteApp, initializeApp } from ${JSON.stringify(`${adminDist}app/index.js`)};
          import { getDatabase, getDatabaseWithUrl } from ${JSON.stringify(`${adminDist}database/index.js`)};
          import { createBridgeMount } from ${JSON.stringify(`${cliDist}serve/bridge-mount.js`)};
          import { connectRemoteSandbox } from ${JSON.stringify(`${cliDist}remote/index.js`)};

          const dir = realpathSync(process.argv[2]);
          const childScript = process.argv[3];
          const SESSION = 'session-admin-ondisconnect-exit';
          const SHARD = 'demo-app-shard-1';
          const SHARD_URL = 'https://' + SHARD + '.firebaseio.com';
          const DENY_ALL = JSON.stringify({ rules: { '.read': false, '.write': false } });

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
          await mount.deployHostedRules('database', DENY_ALL);
          await mount.deployHostedRules('database', DENY_ALL, SHARD);

          const verifierRemote = await connectRemoteSandbox({ url: base });
          const verifierApp = initializeApp({ sandbox: verifierRemote, projectId: 'demo-app' }, 'verifier');
          const verifierDb = getDatabase(verifierApp);
          const verifierShard = getDatabaseWithUrl(SHARD_URL, verifierApp);

          const registerUrl = ${JSON.stringify(`${cliDist}register/index.js`)};
          const healthRes = await fetch(base + '/__pyric/health');
          const health = await healthRes.json();
          try {
            const beforeExit = Date.now();
            const child = spawn(process.execPath, ['--import', registerUrl, childScript], {
              cwd: dir,
              env: {
                ...process.env,
                PYRIC_SANDBOX: 'remote:' + base,
                PYRIC_SANDBOX_INSTANCE: health.instanceId,
                PYRIC_PROCESS_HEALTH: 'off',
                TEST_SHARD_URL: SHARD_URL,
              },
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            let out = '';
            let err = '';
            child.stdout.on('data', (chunk) => { out += String(chunk); });
            child.stderr.on('data', (chunk) => { err += String(chunk); });
            const [code] = await once(child, 'exit');
            assert.equal(code, 0, 'child stderr: ' + err);
            assert.equal(out.trim(), 'child-registered');

            // Poll briefly for async WS close -> drainPortRtdbDisconnects completion.
            const deadline = Date.now() + 5000;
            let workerVal = (await verifierDb.ref('presence/worker-1').get()).val();
            while (workerVal?.state !== 'exited' && Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 25));
              workerVal = (await verifierDb.ref('presence/worker-1').get()).val();
            }
            assert.equal(workerVal.state, 'exited');
            assert.equal(typeof workerVal.exitedAt, 'number');
            assert.ok(workerVal.exitedAt >= beforeExit);
            assert.equal((await verifierDb.ref('locks/active').get()).exists(), false);
            assert.equal((await verifierDb.ref('presence/cancelled').get()).exists(), false);
            assert.deepEqual((await verifierShard.ref('presence/worker-1').get()).val(), { shardState: 'exited' });
            console.log('Hosted child exit drained');
          } finally {
            await deleteApp(verifierApp);
            await verifierRemote.close?.();
            await mount.close();
            server.close();
          }
        `;

        const childEntry = join(directory, 'child-src.ts');
        const hostEntry = join(directory, 'host-src.ts');
        writeFileSync(childEntry, childSource);
        writeFileSync(hostEntry, hostSource);

        const childBuild = await Bun.build({
          entrypoints: [childEntry],
          outdir: directory,
          target: 'node',
          packages: 'external',
          naming: 'child.mjs',
        });
        const hostBuild = await Bun.build({
          entrypoints: [hostEntry],
          outdir: directory,
          target: 'node',
          packages: 'external',
          naming: 'host.mjs',
        });
        expect(childBuild.success).toBe(true);
        expect(hostBuild.success).toBe(true);

        const run = spawnSync(
          process.env.PYRIC_TEST_NODE ?? 'node',
          [join(directory, 'host.mjs'), directory, join(directory, 'child.mjs')],
          { encoding: 'utf8', timeout: 30_000 },
        );
        if (run.status !== 0) {
          throw new Error(`Hosted exit scenario failed (${run.status}): ${run.stderr}\n${run.stdout}`);
        }
        expect(run.stdout.trim()).toBe('Hosted child exit drained');
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    45_000,
  );
});

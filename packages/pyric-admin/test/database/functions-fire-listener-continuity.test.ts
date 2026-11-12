/**
 * Hosted integration test verifying that pre-existing remote `pyric-admin`
 * `on('value')`, `on('child_added')` / `on('child_changed')`, and
 * `once('child_added')` listeners (backed by `ChildWindowDiffer`) receive live
 * RTDB updates written during `functions.fire` without hanging or emitting
 * corrupted child deltas on subsequent writes.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMemoryBackend } from 'pyric/sandbox';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { getDatabase } from '../../src/database/index.js';
import { buildChildEnv, registerModuleUrl } from '../../../cli/src/cli/sandbox-runner.js';
import type { FunctionsChildEvent } from '../../../cli/src/functions/child-protocol.js';
import { spawnFunctionsChild } from '../../../cli/src/functions/spawn.js';
import { connectRemoteSandbox } from '../../../cli/src/remote/index.js';
import { createBridgeMount } from '../../../cli/src/serve/bridge-mount.js';

function makeInitPayload(projectId = 'demo-proj', sessionToken = 'tok-admin-fn-continuity') {
  return {
    rules: null,
    rulesHash: null,
    storageRules: null,
    storageRulesHash: null,
    bridgeUrl: null,
    seed: null,
    capture: false,
    hosted: true,
    permissive: true,
    projectKey: projectId,
    sessionToken,
    appOptions: { projectId },
  };
}

function makeInMemoryHostedPersistence() {
  const storageStub = {
    scoped: () => storageStub,
    reset: async () => {},
    close: () => {},
    objectFile: async () => undefined,
    uploadProgress: async () => undefined,
    appendUpload: async () => ({ received: 0, size: 0 }),
  };
  return {
    backend: createMemoryBackend(),
    storage: storageStub,
    checkpoints: {},
    state: { seed: async () => false },
    repairedObjects: [],
    sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
    close() {},
    status: () => ({ state: 'healthy' as const }),
    onFailure: () => () => {},
    markUnhealthy() {},
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Condition did not settle within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

describe('pyric-admin/database remote listener continuity across functions.fire', () => {
  test(
    'delivers live value and ChildWindowDiffer child deltas written during functions.fire without hanging once() or corrupting subsequent child diffs',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pyric-admin-fn-fire-continuity-'));
      const fnDir = join(dir, 'functions');
      mkdirSync(fnDir, { recursive: true });
      symlinkSync(
        resolvePath(import.meta.dir, '../../../conformance/node_modules'),
        join(fnDir, 'node_modules'),
        'dir',
      );
      writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: 'demo-proj' } }));
      writeFileSync(
        join(dir, 'firebase.json'),
        JSON.stringify({ functions: { source: 'functions' } }),
      );
      writeFileSync(
        join(fnDir, 'package.json'),
        JSON.stringify({ name: 'demo-continuity-fn', type: 'module', main: 'index.mjs' }),
      );
      writeFileSync(
        join(fnDir, 'index.mjs'),
        [
          "import { onValueCreated } from 'firebase-functions/v2/database';",
          "import { getApps, initializeApp } from 'firebase-admin/app';",
          "import { getDatabase } from 'firebase-admin/database';",
          "export const onOrderSubmitted = onValueCreated('/orders/{orderId}', async (event) => {",
          "  const app = getApps()[0] ?? initializeApp();",
          "  const db = getDatabase(app);",
          "  const payload = event.data.val() ?? {};",
          "  await db.ref('projections/items/a').update({ count: 2, stage: 'processed' });",
          "  await db.ref('projections/items/b').set({ count: 1, stage: String(payload.stage ?? 'created') });",
          "  await db.ref('projections/inbox/' + event.params.orderId).set({ ready: true });",
          "  return { orderId: event.params.orderId };",
          "});",
        ].join('\n'),
      );

      const mount = createBridgeMount({
        hosted: true,
        projectKey: dir,
        disableAuditLog: true,
      });
      const httpServer = http.createServer((req, res) => {
        const port = (httpServer.address() as { port: number }).port;
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
        void mount.handler(req, res, url).then((handled) => {
          if (!handled && !res.headersSent) {
            res.writeHead(404).end();
          }
        });
      });
      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
      const port = (httpServer.address() as { port: number }).port;
      const baseUrl = `http://127.0.0.1:${port}`;

      await mount.startHostedSandbox(
        makeInitPayload('demo-proj', mount.sessionToken),
        baseUrl,
        { persistence: makeInMemoryHostedPersistence() as never, record: false },
      );
      const attachment = mount.attachHost({
        servers: [httpServer],
        projectDir: dir,
        origin: () => ({ host: '127.0.0.1', port }),
      });

      const childModule = resolvePath(import.meta.dir, '../../../cli/dist/functions/child.js');
      const bgEvents: FunctionsChildEvent[] = [];
      let bgChild: ReturnType<typeof spawnFunctionsChild> | undefined;
      let remote: Awaited<ReturnType<typeof connectRemoteSandbox>> | undefined;
      try {
        bgChild = spawnFunctionsChild({
          cwd: fnDir,
          entry: join(fnDir, 'index.mjs'),
          childModuleUrl: pathToFileURL(childModule),
          env: buildChildEnv(process.env, {
            serveUrl: baseUrl,
            registerUrl: registerModuleUrl(),
            instanceId: mount.instanceId,
            sessionToken: mount.sessionToken,
          }),
          instance: 'demo-proj-default-rtdb',
          projectId: 'demo-proj',
          location: 'us-central1',
          onEvent: (ev) => bgEvents.push(ev),
        });
        await bgChild.ready;

        remote = await connectRemoteSandbox({
          url: baseUrl,
          sessionToken: mount.sessionToken,
          cwd: dir,
        });
        const app = initializeApp(
          { sandbox: remote, projectId: 'demo-proj' },
          'remote-continuity-observer',
        );
        const db = getDatabase(app);

        await db.ref('projections/items/a').set({ count: 1, stage: 'seeded' });

        const valueLog: unknown[] = [];
        const addedLog: Array<{ key: string | null; val: unknown; prev: string | null }> = [];
        const changedLog: Array<{ key: string | null; val: unknown; prev: string | null }> = [];

        const itemsRef = db.ref('projections/items');
        const orderedItems = itemsRef.orderByKey();
        itemsRef.on('value', (snap) => {
          valueLog.push(snap.val());
        });
        orderedItems.on('child_added', (snap, prev) => {
          addedLog.push({ key: snap.key, val: snap.val(), prev: prev ?? null });
        });
        orderedItems.on('child_changed', (snap, prev) => {
          changedLog.push({ key: snap.key, val: snap.val(), prev: prev ?? null });
        });

        await waitFor(() => valueLog.length >= 1 && addedLog.length >= 1);
        expect(valueLog).toEqual([{ a: { count: 1, stage: 'seeded' } }]);
        expect(addedLog).toEqual([
          { key: 'a', val: { count: 1, stage: 'seeded' }, prev: null },
        ]);
        expect(changedLog).toEqual([]);

        // Attach once('child_added') on an initially empty path before functions.fire runs;
        // ChildWindowDiffer consumes the initial empty window and waits for the live delta.
        const inboxOncePromise = db.ref('projections/inbox').once('child_added');
        await new Promise((r) => setTimeout(r, 60));

        const fireRes = await fetch(`${baseUrl}/__pyric/hosted/method`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-pyric-session-token': mount.sessionToken,
          },
          body: JSON.stringify({
            instanceId: mount.instanceId,
            projectDir: dir,
            key: 'functions.fire',
            args: {
              trigger: 'onOrderSubmitted',
              path: 'orders/ord-1',
              value: { stage: 'from-fire' },
            },
            allowProduction: false,
          }),
        });
        expect(fireRes.status).toBe(200);
        const fired = (await fireRes.json()) as { ok: boolean; summary?: string };
        expect(fired.ok).toBe(true);

        const inboxChildSnap = await Promise.race([
          inboxOncePromise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("once('child_added') hung across functions.fire")), 4_000),
          ),
        ]);
        expect(inboxChildSnap.key).toBe('ord-1');
        expect(inboxChildSnap.val()).toEqual({ ready: true });

        await waitFor(() => addedLog.length >= 2 && changedLog.length >= 1);
        expect(addedLog).toEqual([
          { key: 'a', val: { count: 1, stage: 'seeded' }, prev: null },
          { key: 'b', val: { count: 1, stage: 'from-fire' }, prev: 'a' },
        ]);
        expect(changedLog).toEqual([
          { key: 'a', val: { count: 2, stage: 'processed' }, prev: null },
        ]);
        expect(valueLog[valueLog.length - 1]).toEqual({
          a: { count: 2, stage: 'processed' },
          b: { count: 1, stage: 'from-fire' },
        });
        expect(bgEvents).toHaveLength(0);

        // Subsequent writes after functions.fire must diff cleanly against the window
        // already updated during functions.fire: updating 'b' emits child_changed (NOT a
        // duplicate/late child_added), and adding 'c' carries prev === 'b'.
        await db.ref('projections/items/b').update({ count: 5, stage: 'settled' });
        await waitFor(() => changedLog.length >= 2);
        expect(addedLog).toHaveLength(2);
        expect(changedLog).toEqual([
          { key: 'a', val: { count: 2, stage: 'processed' }, prev: null },
          { key: 'b', val: { count: 5, stage: 'settled' }, prev: 'a' },
        ]);

        await db.ref('projections/items/c').set({ count: 9, stage: 'post-fire' });
        await waitFor(() => addedLog.length >= 3);
        expect(addedLog).toEqual([
          { key: 'a', val: { count: 1, stage: 'seeded' }, prev: null },
          { key: 'b', val: { count: 1, stage: 'from-fire' }, prev: 'a' },
          { key: 'c', val: { count: 9, stage: 'post-fire' }, prev: 'b' },
        ]);
        expect(changedLog).toHaveLength(2);
        expect(valueLog[valueLog.length - 1]).toEqual({
          a: { count: 2, stage: 'processed' },
          b: { count: 5, stage: 'settled' },
          c: { count: 9, stage: 'post-fire' },
        });

        itemsRef.off();
        orderedItems.off();
      } finally {
        if (bgChild) await bgChild.stop().catch(() => {});
        remote?.close();
        await attachment.close();
        await mount.close();
        httpServer.closeAllConnections?.();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

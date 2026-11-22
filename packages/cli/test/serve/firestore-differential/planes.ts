/**
 * Execution planes for the Firestore differential runner:
 *
 * - `sandbox` (Arm A): in-process `initializeSandbox()` + `createAppForSandbox`
 *   with `pyric/firestore` and `pyric/auth`, plus `getAdminFirestore(sandbox)`
 *   cross-reads and both `exportStateBundle` -> `importStateBundle` and
 *   `bundleRecords(serializeToBuckets(sandbox.snapshot()))` ->
 *   `decodeImportBundle` + `loadSnapshot` round-trip verification.
 * - `hosted` (Arm B): real `@pyric/cli` `startServe({ hosted: true, bridge: true })`
 *   HTTP + WebSocket server under Node, driving the served `firebase/app`,
 *   `firebase/firestore`, and `firebase/auth` client over loopback HTTP
 *   (`/__pyric/init.json`) and WebSocket (`/__pyric/bridge`), plus a live
 *   `connectRemoteSandbox` WebSocket connection for `getAdminFirestore(remote)`
 *   cross-reads and `exportState` -> fresh `initializeSandbox()`
 *   `importStateBundle` round-trip verification.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FirestoreSurface, AuthSurface, PlaneSession } from './interpreter.js';
import { PROJECT_ID } from './sequence.js';
import { canonicalizeReadValue } from './value-serialize.js';

export type PlaneName = 'sandbox' | 'hosted';

export interface PlanePool {
  openSession(): Promise<PlaneSession>;
  dispose(): Promise<void>;
}

const MISSING_PROBE_DOC_PATH = 'items/i1';

const microtick = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));
const macrotick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function canonicalizeSnapshotKeys(raw: Record<string, unknown>): string[] {
  return Object.keys(raw).sort();
}

async function readViaAdminFirestore(
  adminDb: {
    doc(path: string): {
      get(): Promise<{ exists: boolean; data(): unknown }>;
    };
  },
  pathsToCheck: readonly string[],
): Promise<Record<string, unknown>> {
  const uniquePaths = [...new Set([MISSING_PROBE_DOC_PATH, ...pathsToCheck])].sort();
  const snaps = await Promise.all(
    uniquePaths.map(async (path) => ({ path, snap: await adminDb.doc(path).get() })),
  );
  const out: Record<string, unknown> = {};
  for (const { path, snap } of snaps) {
    if (snap.exists) {
      out[path] = canonicalizeReadValue(snap.data());
    }
  }
  return out;
}

export async function openSandboxPool(): Promise<PlanePool> {
  const {
    initializeSandbox,
    bundleRecords,
    serializeToBuckets,
  } = await import('pyric/sandbox');
  const { decodeImportBundle } = await import('pyric/sandbox/internal');
  const { setRules, snapshotDocuments } = await import('pyric/sandbox/firestore');
  const { getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  const { createAppForSandbox } = await import('pyric/app/internal');
  const { deleteApp } = await import('pyric/app');
  const { exportStateBundle, importStateBundle } = await import('../../../src/serve/worker/host/state-transfer.js');
  const firestore = await import('pyric/firestore');
  const auth = await import('pyric/auth');

  let seqCounter = 0;

  return {
    async openSession(): Promise<PlaneSession> {
      const sandbox = initializeSandbox();
      const app = createAppForSandbox(sandbox, { projectId: PROJECT_ID }, `fs-diff-sbx-${++seqCounter}`);
      const adminDb = getAdminFirestore(sandbox);

      return {
        firestore: firestore as unknown as FirestoreSurface,
        auth: auth as unknown as AuthSurface,
        app,
        async setRules(rulesSource: string): Promise<void> {
          setRules(sandbox, rulesSource);
          setRules(sandbox, rulesSource, 'reports');
        },
        async readAdminState(extraPaths: readonly string[]): Promise<Record<string, unknown>> {
          const directKeys = canonicalizeSnapshotKeys(snapshotDocuments(sandbox));
          return readViaAdminFirestore(adminDb, [
            ...extraPaths,
            ...directKeys,
          ]);
        },
        async verifyBundleRoundTrip(extraPaths: readonly string[]): Promise<Record<string, unknown>> {
          // 1. Portable checkpoint bundle (`exportStateBundle` -> `importStateBundle`).
          const stateBundle = await exportStateBundle(sandbox);
          const freshFromState = initializeSandbox();
          try {
            await importStateBundle(freshFromState, stateBundle);
            const restoredCheckpoint = await readViaAdminFirestore(
              getAdminFirestore(freshFromState),
              [...extraPaths, ...canonicalizeSnapshotKeys(snapshotDocuments(freshFromState))],
            );

            // 2. Record-bucket persistence bundle (`bundleRecords` -> `decodeImportBundle` + `loadSnapshot`).
            const snap = sandbox.snapshot();
            const recordBundle = bundleRecords(
              serializeToBuckets(
                snap.firestore as Record<string, Record<string, unknown>>,
                snap.services,
                Date.now(),
              ),
            );
            const freshFromRecords = initializeSandbox();
            try {
              freshFromRecords.loadSnapshot(decodeImportBundle(recordBundle));
              const restoredRecords = await readViaAdminFirestore(
                getAdminFirestore(freshFromRecords),
                [...extraPaths, ...canonicalizeSnapshotKeys(snapshotDocuments(freshFromRecords))],
              );
              if (JSON.stringify(restoredCheckpoint) !== JSON.stringify(restoredRecords)) {
                throw new Error(
                  `Sandbox checkpoint bundle disagreed with record bundle: checkpoint=${JSON.stringify(restoredCheckpoint)} records=${JSON.stringify(restoredRecords)}`,
                );
              }
              return restoredCheckpoint;
            } finally {
              freshFromRecords.dispose();
            }
          } finally {
            freshFromState.dispose();
          }
        },
        async settle(hasActiveListeners = true): Promise<void> {
          if (!hasActiveListeners) {
            return;
          }
          for (let i = 0; i < 4; i++) {
            await microtick();
          }
          await macrotick();
        },
        async close(): Promise<void> {
          await deleteApp(app);
          sandbox.dispose();
        },
      };
    },
    async dispose(): Promise<void> {
      // No shared server resources in the in-process pool.
    },
  };
}

export async function openHostedPool(): Promise<PlanePool> {
  const projectDir = mkdtempSync(join(tmpdir(), 'pyric-fs-diff-hosted-'));
  const explicitCacheDir = process.env.PYRIC_FS_DIFF_CACHE_DIR;
  if (explicitCacheDir !== undefined) {
    mkdirSync(explicitCacheDir, { recursive: true });
  }
  mkdirSync(join(projectDir, 'public'), { recursive: true });
  writeFileSync(
    join(projectDir, 'firebase.json'),
    JSON.stringify({
      hosting: { public: 'public' },
      firestore: [{ database: '(default)' }, { database: 'reports' }],
    }),
  );
  writeFileSync(
    join(projectDir, '.firebaserc'),
    JSON.stringify({ projects: { default: PROJECT_ID } }),
  );
  writeFileSync(
    join(projectDir, 'public', 'index.html'),
    '<!doctype html><html><head></head><body>diff</body></html>',
  );

  const { startServe } = await import('../../../src/cli/serve.js');
  const { silentServeLogger } = await import('../../../src/serve/server.js');
  const { connectRemoteSandbox } = await import('../../../src/remote/index.js');
  const { initializeSandbox } = await import('pyric/sandbox');
  const { snapshotDocuments } = await import('pyric/sandbox/firestore');
  const { getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  const { importStateBundle } = await import('../../../src/serve/worker/host/state-transfer.js');

  const serveOptions: Parameters<typeof startServe>[0] = {
    cwd: projectDir,
    port: 0,
    host: '127.0.0.1',
    hosted: true,
    bridge: true,
    watch: false,
    capture: false,
    disableAuditLog: true,
    logger: silentServeLogger(),
  };
  if (explicitCacheDir !== undefined) {
    serveOptions.cacheRoot = explicitCacheDir;
  }
  const runtime = await startServe(serveOptions);

  let clientApp: typeof import('../../../src/register/client/app.js');
  let clientFirestore: typeof import('../../../src/register/client/firestore.js');
  let clientAuth: typeof import('../../../src/register/client/auth.js');
  let appClient: typeof import('../../../src/serve/entries/app-client.js');
  let workerCore: typeof import('../../../src/serve/worker/client/core.js');
  let remote: Awaited<ReturnType<typeof connectRemoteSandbox>>;
  let remoteAdminDb: ReturnType<typeof getAdminFirestore>;

  try {
    // Activate the Node remote client bootstrap against the real HTTP + WebSocket
    // server BEFORE importing the served client entries.
    process.env.PYRIC_SANDBOX = `remote:${runtime.handle.url}`;
    process.env.PYRIC_LIVE_PROJECT_ROOT = projectDir;

    clientApp = await import('../../../src/register/client/app.js');
    clientFirestore = await import('../../../src/register/client/firestore.js');
    clientAuth = await import('../../../src/register/client/auth.js');
    appClient = await import('../../../src/serve/entries/app-client.js');
    workerCore = await import('../../../src/serve/worker/client/core.js');

    remote = await connectRemoteSandbox({
      url: runtime.handle.url,
      sessionToken: runtime.sessionToken,
      projectId: PROJECT_ID,
    });
    remoteAdminDb = getAdminFirestore(remote);
  } catch (err) {
    try {
      await Promise.resolve(runtime.handle.stop());
    } catch {
      // Ignore stop errors while unwinding failed pool setup.
    }
    rmSync(projectDir, { recursive: true, force: true });
    throw err;
  }

  let appSeq = 0;
  let settlePing = 0;

  return {
    async openSession(): Promise<PlaneSession> {
      const resetOutcome = (await remote.channel.op({ method: 'resetAll' })) as { errors?: string[] };
      if (Array.isArray(resetOutcome?.errors) && resetOutcome.errors.length > 0) {
        throw new Error(`Hosted resetAll reported errors: ${resetOutcome.errors.join('; ')}`);
      }

      const app = clientApp.initializeApp({ projectId: PROJECT_ID }, `fs-diff-hosted-${++appSeq}`);
      const clientPort = appClient.workerClientForApp(app).port;

      return {
        firestore: clientFirestore as unknown as FirestoreSurface,
        auth: clientAuth as unknown as AuthSurface,
        app,
        async setRules(rulesSource: string): Promise<void> {
          await remote.channel.op({ method: 'setFirestoreRules', source: rulesSource });
          await remote.channel.op({ method: 'setFirestoreRules', source: rulesSource, databaseId: 'reports' });
        },
        async readAdminState(extraPaths: readonly string[]): Promise<Record<string, unknown>> {
          const rawState = (await remote.channel.op({ method: 'admin.readState' })) as Record<string, unknown>;
          return readViaAdminFirestore(remoteAdminDb, [
            ...extraPaths,
            ...Object.keys(rawState),
          ]);
        },
        async verifyBundleRoundTrip(extraPaths: readonly string[]): Promise<Record<string, unknown>> {
          const exported = (await remote.channel.op({ method: 'exportState' })) as { bundle: string };
          const fresh = initializeSandbox();
          try {
            await importStateBundle(fresh, exported.bundle);
            return readViaAdminFirestore(
              getAdminFirestore(fresh),
              [...extraPaths, ...canonicalizeSnapshotKeys(snapshotDocuments(fresh))],
            );
          } finally {
            fresh.dispose();
          }
        },
        async settle(hasActiveListeners = true): Promise<void> {
          if (!hasActiveListeners) {
            return;
          }
          // A round-trip on the app's own WebSocket port guarantees every prior
          // event/subErr frame sent by the host to this client has been delivered.
          await workerCore.rpc(clientPort, {
            t: 'op',
            id: `settle-${++settlePing}`,
            method: 'sandbox.clock',
          } as never);
          await macrotick();
          await microtick();
        },
        async close(): Promise<void> {
          await clientApp.deleteApp(app);
          await macrotick();
        },
      };
    },
    async dispose(): Promise<void> {
      try {
        await Promise.resolve(remote.close());
      } catch {
        // Ignore close errors during worker teardown.
      }
      try {
        await Promise.resolve(runtime.handle.stop());
      } catch {
        // Ignore stop errors during worker teardown.
      }
      rmSync(projectDir, { recursive: true, force: true });
    },
  };
}

export function openPlanePool(name: PlaneName): Promise<PlanePool> {
  if (name === 'sandbox') {
    return openSandboxPool();
  }
  return openHostedPool();
}

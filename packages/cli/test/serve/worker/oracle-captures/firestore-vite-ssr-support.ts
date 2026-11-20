import 'fake-indexeddb/auto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { FirebaseFirestoreError, Timestamp, WriteResult, type Firestore as AdminFirestore } from 'pyric-admin/firestore';
import { createMemoryBackend } from 'pyric/sandbox';
import type {
  AdminFirestoreErrorLike, AdminMetaDocSnapLike, AdminMetaQueryLike, AdminMetaQuerySnapLike,
  AdminSnapshotAndReferenceMetadataSubject, AdminTimestampLike, AdminWriteResultLike,
} from '../../../../../conformance/probes/firestore-admin/firestore-admin-snapshot-and-reference-metadata.ts';
import { openStorageBackend } from '../../../../../pyric/src/storage/persistence.js';
import type { BridgeMessage } from '../../../../src/bridge/protocol.js';
import { createHostedRuntime } from '../../../../src/serve/hosted/runtime.js';

const CLI_ROOT = resolve(import.meta.dir, '../../../..');
const REPO_ROOT = resolve(CLI_ROOT, '../..');
const OBSERVATIONS_DIR = join(REPO_ROOT, 'packages/conformance/observations');
const OPEN_RTDB_RULES = { rules: { '.read': true, '.write': true } };
const cleanups: Array<() => Promise<void> | void> = [];

function readObservationBehavior(relativePath: string): Record<string, unknown> {
  return (JSON.parse(readFileSync(join(OBSERVATIONS_DIR, relativePath), 'utf8')) as { behavior: Record<string, unknown> }).behavior;
}

export function loadFirestoreWriteCrossDocBehavior(): Record<string, unknown> {
  return readObservationBehavior('firestore/firestore-rules-write-and-cross-doc-verdicts.json');
}

export function loadFirestoreAdminSnapshotMetaBehavior(): Record<string, unknown> {
  return readObservationBehavior('firestore-admin/firestore-admin-snapshot-and-reference-metadata.json');
}

export async function cleanupFirestoreViteSsrFixtures(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}

function resolvePackageDir(pkgName: string): string {
  return realpathSync(dirname(Bun.resolveSync(`${pkgName}/package.json`, CLI_ROOT)));
}

function linkWorkspacePackages(projectDir: string): void {
  const nm = join(projectDir, 'node_modules');
  mkdirSync(join(nm, '@pyric'), { recursive: true });
  symlinkSync(join(REPO_ROOT, 'packages/pyric'), join(nm, 'pyric'), 'dir');
  symlinkSync(join(REPO_ROOT, 'packages/pyric-admin'), join(nm, 'pyric-admin'), 'dir');
  symlinkSync(CLI_ROOT, join(nm, '@pyric/cli'), 'dir');
  symlinkSync(join(REPO_ROOT, 'packages/conformance'), join(nm, '@pyric/conformance'), 'dir');
  for (const ext of ['firebase', 'firebase-admin', 'vite']) {
    symlinkSync(resolvePackageDir(ext), join(nm, ext), 'dir');
  }
}

export async function openFirestoreHostedServerHost(firestoreRules: string): Promise<{ serveUrl: string }> {
  const projectDir = mkdtempSync(join(tmpdir(), 'pyric-fs-ssr-host-'));
  linkWorkspacePackages(projectDir);
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'fs-ssr-host', type: 'module', private: true }));
  cleanups.push(() => rmSync(projectDir, { recursive: true, force: true }));

  const sockets = new Map<string, { send(data: string): void }>();
  const persistence = {
    backend: createMemoryBackend(),
    storage: await openStorageBackend(`mem-fs-ssr-${Math.random()}`),
    checkpoints: {}, state: { seed: async () => false }, repairedObjects: [],
    sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
    close() {}, status: () => ({ state: 'healthy' as const }), onFailure: () => () => {}, markUnhealthy() {},
  };

  const runtime = await createHostedRuntime(
    {
      rules: firestoreRules, rulesHash: null, databaseRules: OPEN_RTDB_RULES, databaseRulesHash: null,
      databaseInstances: { defaultInstance: 'demo-oracle-default-rtdb', rules: { 'demo-oracle-default-rtdb': OPEN_RTDB_RULES }, projectId: 'demo-oracle' },
      bridgeUrl: '/__pyric/sandbox', seed: null, capture: false, hosted: true, permissive: false,
      projectKey: 'oracle-fs-ssr', appOptions: { projectId: 'demo-oracle' },
    },
    'http://127.0.0.1:4400',
    (frame) => {
      const isReply = frame.type === 'worker-message-result' || frame.type === 'worker-res' || frame.type === 'worker-snap';
      if (!isReply || typeof frame.clientSessionId !== 'string') return;
      const socket = sockets.get(frame.clientSessionId);
      if (socket !== undefined) socket.send(JSON.stringify(frame));
    },
    projectDir,
    { persistence: persistence as never, record: false },
  );

  let nextSession = 0;
  const server = Bun.serve<{ sessionId: string }>({
    hostname: '127.0.0.1', port: 0,
    fetch(req, bunServer) {
      const { pathname } = new URL(req.url);
      if (pathname === '/__pyric/health') return Response.json({ mode: 'sandbox', instanceId: runtime.instanceId, sandboxConnected: true });
      if (pathname === '/__pyric/init.json') {
        return Response.json({ hosted: true, projectKey: 'oracle-fs-ssr', bridgeUrl: '/__pyric/sandbox', instanceId: runtime.instanceId, appOptions: { projectId: 'demo-oracle' } });
      }
      nextSession += 1;
      if (bunServer.upgrade(req, { data: { sessionId: `fs-ssr-session-${nextSession}` } })) return undefined;
      return new Response('not found', { status: 404 });
    },
    websocket: {
      open(socket) { sockets.set(socket.data.sessionId, socket); },
      message(socket, raw) {
        const msg = JSON.parse(String(raw)) as BridgeMessage & { ts?: number };
        if (msg.type === 'ping') {
          let pingTs = Date.now();
          if (typeof msg.ts === 'number') pingTs = msg.ts;
          socket.send(JSON.stringify({ type: 'pong', ts: pingTs }));
          return;
        }
        if (msg.type === 'attach') {
          socket.send(JSON.stringify({ type: 'attach-ack', protocol: 1, bridgeVersion: 'test', peerConnected: true, clientSessionId: socket.data.sessionId, projectKey: 'oracle-fs-ssr', hostInstanceId: runtime.instanceId, capabilities: ['worker-port', 'worker-relay'] } satisfies BridgeMessage));
          return;
        }
        if (msg.type === 'worker-message') {
          runtime.receive({ type: 'worker-message', clientSessionId: socket.data.sessionId, message: msg.message, platform: 'node' });
          return;
        }
        if (msg.type === 'worker-op' || msg.type === 'worker-sub' || msg.type === 'worker-unsub') {
          runtime.receive({ ...msg, clientSessionId: socket.data.sessionId });
        }
      },
      close(socket) {
        sockets.delete(socket.data.sessionId);
        runtime.receive({ type: 'worker-client-disconnect', clientSessionId: socket.data.sessionId });
      },
    },
  });

  const pyricDir = join(projectDir, '.pyric');
  mkdirSync(pyricDir, { recursive: true });
  const serveUrl = `http://127.0.0.1:${server.port}`;
  writeFileSync(join(pyricDir, 'serve.json'), JSON.stringify({ url: serveUrl, mcpUrl: `${serveUrl}/__pyric/mcp`, instanceId: runtime.instanceId, pid: process.pid }));
  cleanups.push(async () => { await runtime.close(); await server.stop(true); });
  return { serveUrl };
}

export function createFirestoreViteSsrProjectDir(firestoreRules: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-fs-vite-ssr-'));
  linkWorkspacePackages(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fs-vite-ssr-fixture', type: 'module', private: true }));
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ firestore: { rules: 'firestore.rules' } }));
  writeFileSync(join(dir, 'firestore.rules'), firestoreRules);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function createSsrAdminSnapshotMetaSubject(mainDb: AdminFirestore, basePath: string): AdminSnapshotAndReferenceMetadataSubject {
  const rootCol = mainDb.collection('pyric_oracle') as ReturnType<typeof mainDb.collection> & { readonly firestore: unknown; readonly parent: { path: string } | null; isEqual(other: unknown): boolean };
  const itemsCol = mainDb.collection(`${basePath}/items`) as typeof rootCol;
  return {
    dbHandle: mainDb,
    isTimestamp: (val): val is AdminTimestampLike => val instanceof Timestamp,
    isWriteResultInstance: (val): boolean => val instanceof WriteResult,
    hasFirestoreErrorExport: typeof FirebaseFirestoreError === 'function',
    createFirestoreError: (code, message) => new FirebaseFirestoreError({ code, message }) as AdminFirestoreErrorLike,
    checkReferenceMetadataAndEquality() {
      const d1 = itemsCol.doc('d1') as ReturnType<typeof mainDb.doc> & { readonly firestore: unknown; isEqual(other: unknown): boolean };
      const d2 = itemsCol.doc('d2');
      const q1 = itemsCol.where('rank', '==', 1) as unknown as AdminMetaQueryLike;
      const q1Same = mainDb.collection(`${basePath}/items`).where('rank', '==', 1);
      const q2 = itemsCol.where('rank', '==', 2);
      let subColParentPath = '';
      if (itemsCol.parent !== null) subColParentPath = itemsCol.parent.path;
      return {
        rootColParentIsNull: rootCol.parent === null, subColParentPathMatchesBase: subColParentPath === basePath,
        colFirestoreSameAsDb: itemsCol.firestore === mainDb, docFirestoreSameAsDb: d1.firestore === mainDb, queryFirestoreSameAsDb: q1.firestore === mainDb,
        colIsEqualSame: itemsCol.isEqual(mainDb.collection(`${basePath}/items`)), colIsEqualDifferent: itemsCol.isEqual(rootCol),
        docIsEqualSame: d1.isEqual(mainDb.doc(`${basePath}/items/d1`)), docIsEqualDifferent: d1.isEqual(d2),
        queryIsEqualSame: q1.isEqual(q1Same), queryIsEqualDifferent: q1.isEqual(q2),
      };
    },
    readDoc: async (id) => (await itemsCol.doc(id).get()) as unknown as AdminMetaDocSnapLike,
    createDoc: async (id, data) => (await itemsCol.doc(id).create(data)) as unknown as AdminWriteResultLike,
    updateDoc: async (id, data) => (await itemsCol.doc(id).update(data)) as unknown as AdminWriteResultLike,
    buildRankQuery: (rank) => itemsCol.where('rank', '==', rank) as unknown as AdminMetaQueryLike,
    runRankQuery: async (rank) => (await itemsCol.where('rank', '==', rank).get()) as unknown as AdminMetaQuerySnapLike,
  };
}

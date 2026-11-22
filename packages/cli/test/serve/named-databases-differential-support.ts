/**
 * Hosted SQLite + WebSocket harness for `named-databases-differential.test.ts`.
 */
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import {
  firestoreRecordSpaceKey,
  firestoreRecordSpacePrefix,
  prepareNamedFirestorePersistence,
  readFirestoreDeclaredFromMeta,
  restoreNamedFirestorePersistence,
  stampFirestoreDeclaredOnMeta,
} from 'pyric/firestore/internal';
import type { PersistenceBackend, Sandbox } from 'pyric/sandbox';
import { CHUNK_FORMAT_VERSION } from 'pyric/sandbox/internal';
import { openStorageBackend } from '../../../pyric/src/storage/persistence.js';

import type { BridgeMessage } from '../../src/bridge/protocol.js';
import { createHostedRuntime } from '../../src/serve/hosted/runtime.js';
import { getHostedFirestore } from '../../src/serve/worker/client/websocket-connection.js';
import { BIND_HOSTED_SANDBOX_SYMBOL } from '../../src/serve/worker/hosted-checkpoint-bind.js';
import type { ClientDb } from '../../src/serve/worker/index.js';

export function createBunSqlitePersistenceBackend(sqlitePath: string): {
  backend: PersistenceBackend;
  checkpoints: Record<symbol, unknown>;
  close(): void;
} {
  const db = new Database(sqlitePath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      namespace TEXT NOT NULL,
      id TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (namespace, id)
    ) STRICT;
  `);
  let boundSandbox: Sandbox | undefined;
  const readRaw = (ns: string, id: string): unknown | null => {
    const row = db
      .prepare('SELECT payload FROM records WHERE namespace = ? AND id = ?')
      .get(ns, id) as { payload: string } | null;
    if (row === null || row === undefined) return null;
    return JSON.parse(row.payload);
  };
  const readSpace = (ns: string): Map<string, unknown> => {
    const rows = db
      .prepare('SELECT id, payload FROM records WHERE namespace = ?')
      .all(ns) as Array<{ id: string; payload: string }>;
    return new Map(rows.map((r) => [r.id, JSON.parse(r.payload)]));
  };
  const upsert = db.prepare(
    'INSERT INTO records (namespace, id, payload) VALUES (?, ?, ?) ON CONFLICT(namespace, id) DO UPDATE SET payload = excluded.payload',
  );
  const del = db.prepare('DELETE FROM records WHERE namespace = ? AND id = ?');

  const commitChanges = (
    key: string,
    changed: ReadonlyMap<string, unknown>,
    removed: readonly string[],
    serialized?: ReadonlyMap<string, string>,
  ): void => {
    if (boundSandbox === undefined || key !== 'hosted') {
      for (const [id, val] of changed) {
        upsert.run(key, id, serialized?.get(id) ?? JSON.stringify(val));
      }
      for (const id of removed) del.run(key, id);
      return;
    }
    const plan = prepareNamedFirestorePersistence(boundSandbox);
    const effectiveChanged = new Map<string, unknown>(changed);
    const effectiveSerialized = new Map<string, string>(serialized ?? []);
    if (effectiveChanged.has('meta')) {
      const rawMeta = effectiveChanged.get('meta');
      if (rawMeta !== null && typeof rawMeta === 'object' && !Array.isArray(rawMeta)) {
        const stamped = stampFirestoreDeclaredOnMeta(
          rawMeta as Record<string, unknown>,
          plan.declared,
        );
        effectiveChanged.set('meta', stamped);
        effectiveSerialized.set('meta', JSON.stringify(stamped));
      }
    } else if (plan.declaredChanged) {
      const prior = readRaw(key, 'meta');
      let baseMeta: Record<string, unknown>;
      if (prior !== null && typeof prior === 'object' && !Array.isArray(prior)) {
        baseMeta = prior as Record<string, unknown>;
      } else {
        baseMeta = { version: CHUNK_FORMAT_VERSION, savedAt: Date.now(), services: {} };
      }
      const stamped = stampFirestoreDeclaredOnMeta(baseMeta, plan.declared);
      effectiveChanged.set('meta', stamped);
      effectiveSerialized.set('meta', JSON.stringify(stamped));
    }
    for (const [id, val] of effectiveChanged) {
      upsert.run(key, id, effectiveSerialized.get(id) ?? JSON.stringify(val));
    }
    for (const id of removed) del.run(key, id);
    for (const [dbId, diff] of plan.databases) {
      const ns = firestoreRecordSpaceKey(key, dbId);
      for (const [id, val] of diff.changed) {
        upsert.run(ns, id, diff.serializedChanged.get(id) ?? JSON.stringify(val));
      }
      for (const id of diff.removed) del.run(ns, id);
    }
    plan.commit();
  };

  const backend: PersistenceBackend = {
    async getRecord(key, id) {
      return readRaw(key, id);
    },
    async listRecords(key) {
      const rows = db
        .prepare('SELECT id FROM records WHERE namespace = ? ORDER BY id')
        .all(key) as Array<{ id: string }>;
      return rows.map((r) => r.id);
    },
    async applyChanges(key, changed, removed, serialized) {
      commitChanges(key, changed, removed, serialized);
    },
    async putRecords(key, records) {
      commitChanges(key, records, []);
    },
    async deleteRecords(key, ids) {
      commitChanges(key, new Map(), ids);
    },
    async clear(key) {
      db.prepare('DELETE FROM records WHERE namespace = ?').run(key);
      const prefix = firestoreRecordSpacePrefix(key);
      db.prepare('DELETE FROM records WHERE substr(namespace, 1, ?) = ?').run(
        prefix.length,
        prefix,
      );
    },
  };

  const checkpoints: Record<symbol, unknown> = {};
  Object.defineProperty(checkpoints, BIND_HOSTED_SANDBOX_SYMBOL, {
    value: (sb: Sandbox) => {
      boundSandbox = sb;
      const declared = readFirestoreDeclaredFromMeta(readRaw('hosted', 'meta'));
      const dbRecords = new Map<string, Map<string, unknown>>();
      for (const dbId of declared) {
        dbRecords.set(dbId, readSpace(firestoreRecordSpaceKey('hosted', dbId)));
      }
      restoreNamedFirestorePersistence(sb, declared, dbRecords);
    },
    configurable: true,
  });

  return { backend, checkpoints, close: () => db.close() };
}

export async function openDifferentialHostedServer(
  dir: string,
  defaultRules: string,
): Promise<{
  runtime: Awaited<ReturnType<typeof createHostedRuntime>>;
  openClient: () => Promise<ClientDb>;
  close: () => Promise<void>;
}> {
  const sqliteStore = createBunSqlitePersistenceBackend(join(dir, 'state.sqlite'));
  const sockets = new Map<string, { send(data: string): void }>();
  const persistence = {
    backend: sqliteStore.backend,
    storage: await openStorageBackend(`hosted-diff-storage-${Math.random()}`),
    checkpoints: sqliteStore.checkpoints,
    state: { seed: async () => false },
    repairedObjects: [],
    sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
    close() {
      sqliteStore.close();
    },
    status: () => ({ state: 'healthy' as const }),
    onFailure: () => () => {},
    markUnhealthy() {},
  };
  const runtime = await createHostedRuntime(
    {
      rules: defaultRules,
      rulesHash: null,
      databaseRules: null,
      databaseRulesHash: null,
      bridgeUrl: '/__pyric/sandbox',
      seed: null,
      capture: false,
      hosted: true,
      permissive: false,
      projectKey: 'diff-project',
      sessionToken: 'diff-token',
      appOptions: { projectId: 'demo-diff' },
    },
    'http://127.0.0.1:4400',
    (frame) => {
      const forwards =
        frame.type === 'worker-message-result' ||
        frame.type === 'worker-res' ||
        frame.type === 'worker-snap';
      if (!forwards || typeof frame.clientSessionId !== 'string') return;
      sockets.get(frame.clientSessionId)?.send(JSON.stringify(frame));
    },
    dir,
    { persistence: persistence as never, record: false },
  );

  let seq = 0;
  const server = Bun.serve<{ sessionId: string }>({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, bunServer) {
      const sessionId = `sess-${++seq}`;
      if (bunServer.upgrade(req, { data: { sessionId } })) return undefined;
      return new Response('upgrade required', { status: 426 });
    },
    websocket: {
      open(ws) {
        sockets.set(ws.data.sessionId, ws);
      },
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as BridgeMessage;
        if (msg.type === 'attach') {
          ws.send(
            JSON.stringify({
              type: 'attach-ack',
              protocol: 1,
              bridgeVersion: 'test',
              peerConnected: true,
              clientSessionId: ws.data.sessionId,
              projectKey: 'diff-project',
              hostInstanceId: runtime.instanceId,
              capabilities: ['worker-port', 'worker-relay'],
            } satisfies BridgeMessage),
          );
          return;
        }
        if (msg.type === 'worker-message') {
          runtime.receive({
            type: 'worker-message',
            clientSessionId: ws.data.sessionId,
            message: msg.message,
            platform: 'node',
          });
          return;
        }
        const isRelayFrame =
          msg.type === 'worker-op' || msg.type === 'worker-sub' || msg.type === 'worker-unsub';
        if (isRelayFrame) {
          runtime.receive({
            ...msg,
            clientSessionId: ws.data.sessionId,
          });
        }
      },
      close(ws) {
        sockets.delete(ws.data.sessionId);
        runtime.receive({
          type: 'worker-client-disconnect',
          clientSessionId: ws.data.sessionId,
        });
      },
    },
  });

  const wsUrl = `ws://127.0.0.1:${server.port}/__pyric/sandbox`;
  const openClient = async (): Promise<ClientDb> => {
    let attached = false;
    const clientDb = getHostedFirestore({
      url: wsUrl,
      projectKey: 'diff-project',
      retryInitialConnection: false,
      onConnection: (st) => {
        if (st === 'attached') attached = true;
      },
    });
    const deadline = Date.now() + 4_000;
    while (!attached && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }
    if (!attached) throw new Error('Hosted WebSocket client did not attach in time');
    return clientDb;
  };

  return {
    runtime,
    openClient,
    close: async () => {
      await runtime.close();
      await server.stop(true);
      sqliteStore.close();
    },
  };
}

import { sandbox as authOps } from 'pyric/auth';
import {
  bundleRecords,
  parseBundle,
  serializeToBuckets,
  type PersistenceBackend,
} from 'pyric/sandbox';
import {
  DEFAULT_FIRESTORE_DATABASE,
  firestoreRecordSpaceKey,
  isValidFirestoreDatabaseId,
  readFirestoreDeclaredFromMeta,
  serializeNamedFirestoreDocsToBuckets,
  stampFirestoreDeclaredOnMeta,
} from 'pyric/firestore/internal';
import type { InitPayload } from '../namespace.js';
import type { MirrorablePersistenceBackend } from './firestore-persistence-backend.js';
import { ensureAuth, type HostCtx } from './host.js';

export interface DurablePersistenceEnv {
  fetch: typeof fetch;
  captureDebounceMs?: number;
}

const WORKER_WRITER_ID = 'pyric-shared-worker';

const stateSection = (name: 'firestore' | 'auth'): string => `/__pyric/state?section=${name}`;

function basePersistenceKeyOf(key: string): string {
  const idx = key.indexOf('/firestore/');
  if (idx >= 0) return key.slice(0, idx);
  return key;
}

function namedDatabaseIdFromKey(key: string): string | null {
  const idx = key.indexOf('/firestore/');
  if (idx < 0) return null;
  const candidate = key.slice(idx + '/firestore/'.length);
  if (candidate === DEFAULT_FIRESTORE_DATABASE || !isValidFirestoreDatabaseId(candidate)) {
    return null;
  }
  return candidate;
}

function parseBundleNamedDatabases(blob: string): Map<string, Map<string, unknown>> {
  const out = new Map<string, Map<string, unknown>>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob);
  } catch {
    return out;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return out;
  }
  const rawDbs = (parsed as { firestoreDatabases?: unknown }).firestoreDatabases;
  if (rawDbs === null || rawDbs === undefined || typeof rawDbs !== 'object' || Array.isArray(rawDbs)) {
    return out;
  }
  for (const [dbId, rawRecords] of Object.entries(rawDbs as Record<string, unknown>)) {
    if (dbId === DEFAULT_FIRESTORE_DATABASE || !isValidFirestoreDatabaseId(dbId)) continue;
    if (rawRecords === null || typeof rawRecords !== 'object' || Array.isArray(rawRecords)) continue;
    out.set(dbId, new Map(Object.entries(rawRecords as Record<string, unknown>)));
  }
  return out;
}

interface SeedStateShape {
  firestore?: Record<string, Record<string, unknown>>;
  firestoreDatabases?: Record<string, Record<string, Record<string, unknown>>>;
  firestoreDeclared?: string[];
  services?: Record<string, unknown>;
}

/** Add the committable server-file or seed-fixture tier to the worker's IDB store. */
export function createWorkerDurableBackend(
  idb: PersistenceBackend,
  payload: InitPayload,
  env: DurablePersistenceEnv,
): MirrorablePersistenceBackend {
  const persist = Boolean(payload.persist);
  const seed = (payload.seedState ?? null) as SeedStateShape | null;
  let fixtureRecords: Map<string, unknown> | null = null;
  const fixtureNamedRecords = new Map<string, Map<string, unknown>>();
  if (!persist && seed != null) {
    fixtureRecords = serializeToBuckets(seed.firestore ?? {}, seed.services ?? {}, 0);
    const seedDeclared = new Set<string>();
    if (Array.isArray(seed.firestoreDeclared)) {
      for (const id of seed.firestoreDeclared) {
        if (typeof id === 'string' && id !== DEFAULT_FIRESTORE_DATABASE && isValidFirestoreDatabaseId(id)) {
          seedDeclared.add(id);
        }
      }
    }
    if (seed.firestoreDatabases && typeof seed.firestoreDatabases === 'object') {
      for (const [dbId, docs] of Object.entries(seed.firestoreDatabases)) {
        if (dbId === DEFAULT_FIRESTORE_DATABASE || !isValidFirestoreDatabaseId(dbId)) continue;
        seedDeclared.add(dbId);
        fixtureNamedRecords.set(dbId, serializeNamedFirestoreDocsToBuckets(docs ?? {}));
      }
    }
    if (seedDeclared.size > 0 && fixtureRecords.has('meta')) {
      fixtureRecords.set(
        'meta',
        stampFirestoreDeclaredOnMeta(
          fixtureRecords.get('meta') as Record<string, unknown>,
          [...seedDeclared].sort(),
        ),
      );
    }
  }

  if (!persist && fixtureRecords === null) return idb;

  const trackedNamedIds = new Set<string>();
  const authHeaders: Record<string, string> = {};
  if (payload.sessionToken) {
    authHeaders['x-pyric-session-token'] = payload.sessionToken;
  }
  const writerHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'x-pyric-writer': WORKER_WRITER_ID,
    ...authHeaders,
  };

  const prime = async (baseKey: string): Promise<void> => {
    if ((await idb.listRecords(baseKey)).length > 0) return;
    if (persist) {
      let res: Response;
      try {
        res = await env.fetch(stateSection('firestore'), { headers: authHeaders });
      } catch (error) {
        console.warn('[pyric worker] --persist: the server file could not be read; reading local IndexedDB.', error);
        return;
      }
      if (res.status === 200) {
        const rawText = await res.text();
        const records = parseBundle(rawText);
        const namedDbs = parseBundleNamedDatabases(rawText);
        if (records.size > 0) await idb.putRecords(baseKey, records);
        for (const [dbId, dbRecords] of namedDbs) {
          trackedNamedIds.add(dbId);
          if (dbRecords.size > 0) {
            await idb.putRecords(firestoreRecordSpaceKey(baseKey, dbId), dbRecords);
          }
        }
      }
    } else if (fixtureRecords !== null) {
      await idb.putRecords(baseKey, fixtureRecords);
      for (const [dbId, dbRecords] of fixtureNamedRecords) {
        trackedNamedIds.add(dbId);
        if (dbRecords.size > 0) {
          await idb.putRecords(firestoreRecordSpaceKey(baseKey, dbId), dbRecords);
        }
      }
    }
  };

  let priming: Promise<void> | null = null;
  const primeOnce = (key: string): Promise<void> => {
    if (priming !== null) return priming;
    const pass = prime(basePersistenceKeyOf(key));
    priming = pass.catch(() => undefined);
    return pass;
  };

  const mirror = async (baseKey: string, extraNamedIds?: Iterable<string>): Promise<void> => {
    if (!persist) return;
    try {
      if (extraNamedIds !== undefined) {
        for (const id of extraNamedIds) trackedNamedIds.add(id);
      }
      const ids = await idb.listRecords(baseKey);
      const all = new Map<string, unknown>();
      for (const id of ids) {
        const record = await idb.getRecord(baseKey, id);
        if (record != null) all.set(id, record);
      }
      try {
        for (const declaredId of readFirestoreDeclaredFromMeta(all.get('meta'))) {
          trackedNamedIds.add(declaredId);
        }
      } catch {
        // Ignore malformed meta during best-effort mirror.
      }
      const firestoreDatabases: Record<string, Record<string, unknown>> = {};
      for (const dbId of [...trackedNamedIds].sort()) {
        const dbKey = firestoreRecordSpaceKey(baseKey, dbId);
        const dbRecordIds = await idb.listRecords(dbKey);
        if (dbRecordIds.length === 0) continue;
        const dbMap: Record<string, unknown> = {};
        for (const recId of dbRecordIds) {
          const rec = await idb.getRecord(dbKey, recId);
          if (rec != null) dbMap[recId] = rec;
        }
        if (Object.keys(dbMap).length > 0) {
          firestoreDatabases[dbId] = dbMap;
        }
      }
      let body = bundleRecords(all);
      if (Object.keys(firestoreDatabases).length > 0) {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        parsed.firestoreDatabases = firestoreDatabases;
        body = JSON.stringify(parsed);
      }
      const res = await env.fetch(stateSection('firestore'), {
        method: 'POST',
        headers: writerHeaders,
        body,
      });
      if (res.status === 423) {
        console.warn('[pyric worker] --persist: server file is held by another writer; export skipped.');
      }
    } catch {
      /* export sink offline; local IDB is unaffected. */
    }
  };

  return {
    async getRecord(key, recordId) {
      await primeOnce(key);
      return idb.getRecord(key, recordId);
    },
    async listRecords(key) {
      await primeOnce(key);
      return idb.listRecords(key);
    },
    async putRecordsWithoutMirror(key, records) {
      const namedId = namedDatabaseIdFromKey(key);
      if (namedId !== null) trackedNamedIds.add(namedId);
      await idb.putRecords(key, records);
    },
    async deleteRecordsWithoutMirror(key, recordIds) {
      const namedId = namedDatabaseIdFromKey(key);
      if (namedId !== null) trackedNamedIds.add(namedId);
      await idb.deleteRecords(key, recordIds);
    },
    async clearWithoutMirror(key) {
      await idb.clear(key);
    },
    async flushMirror(baseKey, knownNamedIds) {
      await mirror(baseKey, knownNamedIds);
    },
    async putRecords(key, records) {
      const namedId = namedDatabaseIdFromKey(key);
      if (namedId !== null) trackedNamedIds.add(namedId);
      await idb.putRecords(key, records);
      await mirror(basePersistenceKeyOf(key));
    },
    async deleteRecords(key, recordIds) {
      const namedId = namedDatabaseIdFromKey(key);
      if (namedId !== null) trackedNamedIds.add(namedId);
      await idb.deleteRecords(key, recordIds);
      await mirror(basePersistenceKeyOf(key));
    },
    async clear(key) {
      await idb.clear(key);
      if (key !== basePersistenceKeyOf(key)) return;
      trackedNamedIds.clear();
      if (!persist) return;
      try {
        await env.fetch(stateSection('firestore'), {
          method: 'POST',
          headers: writerHeaders,
          body: 'null',
        });
      } catch {
        /* export sink offline; local IDB is unaffected. */
      }
    },
  };
}

/** Mirror the auth user DB to the committable server file when persistence is enabled. */
export function setupServerAuthFlush(
  ctx: HostCtx,
  payload: InitPayload,
  env: DurablePersistenceEnv,
): () => void {
  if (!payload.persist) return () => {};
  const auth = ensureAuth(ctx);
  const debounceMs = env.captureDebounceMs ?? 400;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    const body = JSON.stringify({ users: authOps.exportUsers(auth) });
    const flushHeaders: Record<string, string> = {
      'content-type': 'application/json',
      'x-pyric-writer': WORKER_WRITER_ID,
    };
    if (payload.sessionToken) {
      flushHeaders['x-pyric-session-token'] = payload.sessionToken;
    }
    env.fetch(stateSection('auth'), {
      method: 'POST',
      headers: flushHeaders,
      body,
    }).catch(() => {});
  };

  const unsubscribe = authOps.subscribeUsers(auth, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  });

  return () => {
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}

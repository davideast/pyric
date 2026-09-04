import { sandbox as authOps } from 'pyric/auth';
import {
  bundleRecords,
  parseBundle,
  serializeToBuckets,
  type PersistenceBackend,
} from 'pyric/sandbox';
import type { InitPayload } from '../namespace.js';
import { ensureAuth, type HostCtx } from './host.js';

export interface DurablePersistenceEnv {
  fetch: typeof fetch;
  captureDebounceMs?: number;
}

const WORKER_WRITER_ID = 'pyric-shared-worker';

const stateSection = (name: 'firestore' | 'auth'): string => `/__pyric/state?section=${name}`;

/** Add the committable server-file or seed-fixture tier to the worker's IDB store. */
export function createWorkerDurableBackend(
  idb: PersistenceBackend,
  payload: InitPayload,
  env: DurablePersistenceEnv,
): PersistenceBackend {
  const persist = Boolean(payload.persist);
  const seed = (payload.seedState ?? null) as {
    firestore?: Record<string, Record<string, unknown>>;
    services?: Record<string, unknown>;
  } | null;
  const fixtureRecords = !persist && seed != null
    ? serializeToBuckets(seed.firestore ?? {}, seed.services ?? {}, 0)
    : null;

  if (!persist && fixtureRecords === null) return idb;

  const authHeaders: Record<string, string> = payload.sessionToken
    ? { 'x-pyric-session-token': payload.sessionToken }
    : {};
  const writerHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'x-pyric-writer': WORKER_WRITER_ID,
    ...authHeaders,
  };

  let primed = false;
  const primeOnce = async (key: string): Promise<void> => {
    if (primed) return;
    primed = true;
    if ((await idb.listRecords(key)).length > 0) return;
    if (persist) {
      const res = await env.fetch(stateSection('firestore'), { headers: authHeaders });
      if (res.status === 200) {
        const records = parseBundle(await res.text());
        if (records.size > 0) await idb.putRecords(key, records);
      }
    } else if (fixtureRecords !== null) {
      await idb.putRecords(key, fixtureRecords);
    }
  };

  const mirror = async (key: string): Promise<void> => {
    if (!persist) return;
    try {
      const ids = await idb.listRecords(key);
      const all = new Map<string, unknown>();
      for (const id of ids) {
        const record = await idb.getRecord(key, id);
        if (record != null) all.set(id, record);
      }
      const res = await env.fetch(stateSection('firestore'), {
        method: 'POST',
        headers: writerHeaders,
        body: bundleRecords(all),
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
    async putRecords(key, records) {
      await idb.putRecords(key, records);
      await mirror(key);
    },
    async deleteRecords(key, recordIds) {
      await idb.deleteRecords(key, recordIds);
      await mirror(key);
    },
    async clear(key) {
      await idb.clear(key);
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
      ...(payload.sessionToken ? { 'x-pyric-session-token': payload.sessionToken } : {}),
    };
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

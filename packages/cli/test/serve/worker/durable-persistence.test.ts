import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { getFirestore } from 'pyric/firestore';
import {
  bundleRecords,
  createMemoryBackend,
  deserializeFromBuckets,
  initializeSandbox,
  parseBundle,
  serializeToBuckets,
  type PersistenceBackend,
} from 'pyric/sandbox';
import type { InitPayload } from '../../../src/serve/namespace.js';
import {
  createWorkerDurableBackend,
  setupServerAuthFlush,
} from '../../../src/serve/worker/durable-persistence.js';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { OutboundMessage } from '../../../src/serve/worker/protocol.js';

const PERSIST_KEY = 'pyric-shared-worker';
const PERMISSIVE_RULES = `rules_version = '2'; service cloud.firestore {
  match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } }
}`;
const basePayload: InitPayload = {
  activityToken: 'activity-test-token',
  rules: null,
  rulesHash: null,
  storageRules: null,
  storageRulesHash: null,
  bridgeUrl: null,
  seed: null,
};

async function readBackendFirestore(
  backend: PersistenceBackend,
  key: string,
): Promise<Record<string, Record<string, unknown>>> {
  const records: [string, unknown][] = [];
  for (const id of await backend.listRecords(key)) {
    records.push([id, await backend.getRecord(key, id)]);
  }
  return deserializeFromBuckets(records).firestore;
}

async function makeCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(sandbox.withAuth(null)).setRules(PERMISSIVE_RULES);
  await sandbox.enablePersistence({
    key: `durable-persistence-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  return { db: getFirestore(sandbox), sandbox, subs: new Map() };
}

function fakePort(): PortLike & { messages: OutboundMessage[] } {
  const messages: OutboundMessage[] = [];
  return { messages, postMessage: (message) => void messages.push(message) };
}

interface FetchCall {
  url: string;
  method: string;
  body: string;
  writer: string | undefined;
}

function fakeFetch(getBody?: (url: string) => { status: number; body: string }):
  typeof fetch & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = ((url: string, init?: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  }) => {
    const method = init?.method ?? 'GET';
    calls.push({
      url: String(url),
      method,
      body: String(init?.body ?? ''),
      writer: init?.headers?.['x-pyric-writer'],
    });
    if (method === 'GET' && getBody) {
      const response = getBody(String(url));
      return Promise.resolve({
        status: response.status,
        ok: response.status < 400,
        text: () => Promise.resolve(response.body),
      } as Response);
    }
    return Promise.resolve({
      status: 204,
      ok: true,
      text: () => Promise.resolve(''),
    } as Response);
  }) as typeof fetch & { calls: FetchCall[] };
  fn.calls = calls;
  return fn;
}

const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('createWorkerDurableBackend', () => {
  it('returns the raw IDB backend in plain mode', () => {
    const idb = createMemoryBackend();
    expect(createWorkerDurableBackend(idb, basePayload, { fetch: fakeFetch() })).toBe(idb);
  });

  it('primes empty IDB from the committable server file', async () => {
    const idb = createMemoryBackend();
    const serverBundle = bundleRecords(
      serializeToBuckets({ 'todos/s1': { title: 'from-server' } }, {}, 0),
    );
    const fetchFn = fakeFetch((url) => url.includes('section=firestore')
      ? { status: 200, body: serverBundle }
      : { status: 404, body: 'null' });
    const durable = createWorkerDurableBackend(
      idb,
      { ...basePayload, persist: true },
      { fetch: fetchFn },
    );

    expect((await readBackendFirestore(durable, PERSIST_KEY))['todos/s1']).toEqual({
      title: 'from-server',
    });
    expect(fetchFn.calls.some(
      (call) => call.method === 'GET' && call.url.includes('section=firestore'),
    )).toBe(true);
    expect((await readBackendFirestore(idb, PERSIST_KEY))['todos/s1']).toEqual({
      title: 'from-server',
    });
  });

  it('keeps live local IDB instead of clobbering it from the server', async () => {
    const idb = createMemoryBackend();
    await idb.putRecords(PERSIST_KEY, serializeToBuckets({ 'todos/local': { v: 1 } }, {}, 0));
    const fetchFn = fakeFetch(() => ({
      status: 200,
      body: bundleRecords(serializeToBuckets({ 'todos/server': { v: 9 } }, {}, 0)),
    }));
    const durable = createWorkerDurableBackend(
      idb,
      { ...basePayload, persist: true },
      { fetch: fetchFn },
    );

    const firestore = await readBackendFirestore(durable, PERSIST_KEY);
    expect(firestore['todos/local']).toEqual({ v: 1 });
    expect(firestore['todos/server']).toBeUndefined();
    expect(fetchFn.calls.some((call) => call.method === 'GET')).toBe(false);
  });

  it('mirrors writes with the worker writer identity', async () => {
    const idb = createMemoryBackend();
    const fetchFn = fakeFetch();
    const durable = createWorkerDurableBackend(
      idb,
      { ...basePayload, persist: true },
      { fetch: fetchFn },
    );

    await durable.putRecords(
      PERSIST_KEY,
      serializeToBuckets({ 'todos/x': { title: 'new' } }, {}, 0),
    );
    expect((await readBackendFirestore(idb, PERSIST_KEY))['todos/x']).toEqual({ title: 'new' });
    const post = fetchFn.calls.find(
      (call) => call.method === 'POST' && call.url.includes('section=firestore'),
    );
    expect(post).toBeDefined();
    expect(deserializeFromBuckets([...parseBundle(post!.body)]).firestore['todos/x']).toEqual({
      title: 'new',
    });
    expect(post!.writer).toBe('pyric-shared-worker');
  });

  it('primes IDB once from a seedState fixture without server traffic', async () => {
    const idb = createMemoryBackend();
    const fetchFn = fakeFetch();
    const durable = createWorkerDurableBackend(
      idb,
      { ...basePayload, seedState: { firestore: { 'todos/t1': { title: 'fixture' } } } },
      { fetch: fetchFn },
    );

    expect((await readBackendFirestore(durable, PERSIST_KEY))['todos/t1']).toEqual({
      title: 'fixture',
    });
    expect((await readBackendFirestore(idb, PERSIST_KEY))['todos/t1']).toEqual({
      title: 'fixture',
    });
    expect(fetchFn.calls).toEqual([]);
  });
});

describe('setupServerAuthFlush', () => {
  it('mirrors auth users when persistence is enabled', async () => {
    const ctx = await makeCtx();
    const fetchFn = fakeFetch();
    const dispose = setupServerAuthFlush(
      ctx,
      { ...basePayload, persist: true },
      { fetch: fetchFn, captureDebounceMs: 5 },
    );

    await handleMessage(ctx, fakePort(), {
      t: 'op', id: 'c1', method: 'auth.createUser', email: 'z@b.com', password: 'pw123456',
    });
    await tick(20);

    const authPost = fetchFn.calls.find(
      (call) => call.method === 'POST' && call.url.includes('section=auth'),
    );
    expect(authPost).toBeDefined();
    const body = JSON.parse(authPost!.body) as { users: Array<{ email: string }> };
    expect(body.users.map((user) => user.email)).toContain('z@b.com');
    expect(authPost!.writer).toBe('pyric-shared-worker');
    dispose();
  });

  it('does nothing when persistence is disabled', async () => {
    const ctx = await makeCtx();
    const fetchFn = fakeFetch();
    const dispose = setupServerAuthFlush(
      ctx,
      basePayload,
      { fetch: fetchFn, captureDebounceMs: 5 },
    );
    await handleMessage(ctx, fakePort(), {
      t: 'op', id: 'c1', method: 'auth.createUser', email: 'z@b.com', password: 'pw123456',
    });
    await tick(20);
    expect(fetchFn.calls).toEqual([]);
    dispose();
  });
});

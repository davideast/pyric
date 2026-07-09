/**
 * Worker-side serve init (Phase 3c.B) — `applyServeInit` mirrors
 * `entries/runtime.ts`'s init block INSIDE the SharedWorker, so the
 * default-on worker path doesn't silently bypass serve's rules / seed /
 * authUsers / capture (capture is default-on and drives `pyric verify`).
 *
 * Same harness as host.test.ts: a REAL pyric sandbox + db, driven directly —
 * no SharedWorker runtime. `fetch` is injected so capture is asserted without
 * a network.
 */

import { describe, it, expect } from 'bun:test';
import {
  handleMessage,
  ensureAuth,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import {
  applyServeInit,
  createWorkerDurableBackend,
  setupServerAuthFlush,
  setupWorkerHotReload,
  type EventSourceLike,
} from '../../../src/serve/worker/serve-init.js';
import type { InitPayload } from '../../../src/serve/namespace.js';
import type { OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';
import { sandbox as authOps } from 'pyric/auth';
import {
  initializeSandbox,
  createMemoryBackend,
  serializeToBuckets,
  deserializeFromBuckets,
  bundleRecords,
  parseBundle,
  type PersistenceBackend,
} from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';

const PERSIST_KEY = 'pyric-shared-worker';

/** Read all of a record backend's firestore docs back into a map. */
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

const PERMISSIVE_RULES = `
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      match /{document=**} { allow read, write: if true; }
    }
  }
`;

const DENY_ALL_RULES = `
  rules_version = '2';
  service cloud.firestore {
    match /databases/{database}/documents {
      match /{document=**} { allow read, write: if false; }
    }
  }
`;

const RTDB_RULES = {
  rules: {
    '.read': true,
    '.write': true,
  },
};

async function makeCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
  getAdminFirestore(sandbox.withAuth(null)).setRules(PERMISSIVE_RULES);
  await sandbox.enablePersistence({
    key: `serve-init-${Math.random()}`,
    injectedBackend: createMemoryBackend(),
  });
  return { db: getFirestore(sandbox), sandbox, subs: new Map() };
}

function fakePort(): PortLike & { messages: OutboundMessage[] } {
  const messages: OutboundMessage[] = [];
  return { messages, postMessage: (m) => void messages.push(m) };
}

function getRes(port: { messages: OutboundMessage[] }, id: string): ResMessage {
  const res = port.messages.find((m): m is ResMessage => m.t === 'res' && m.id === id);
  if (!res) throw new Error(`no res for ${id}`);
  return res;
}

/** An injected fetch that records every call and resolves successfully. */
function recordingFetch(): typeof fetch & { calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  const fn = ((url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') });
    return Promise.resolve({ ok: true, status: 204 } as Response);
  }) as typeof fetch & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

interface FetchCall {
  url: string;
  method: string;
  body: string;
  writer: string | undefined;
}

/** A fetch fake that can answer GETs (the persist-restore prime) and records
 *  every call with method + writer header. */
function fakeFetch(getBody?: (url: string) => { status: number; body: string }):
  typeof fetch & { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fn = ((url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const method = init?.method ?? 'GET';
    calls.push({
      url: String(url),
      method,
      body: String(init?.body ?? ''),
      writer: init?.headers?.['x-pyric-writer'],
    });
    if (method === 'GET' && getBody) {
      const r = getBody(String(url));
      return Promise.resolve({ status: r.status, ok: r.status < 400, text: () => Promise.resolve(r.body) } as Response);
    }
    return Promise.resolve({ status: 204, ok: true, text: () => Promise.resolve('') } as Response);
  }) as typeof fetch & { calls: FetchCall[] };
  fn.calls = calls;
  return fn;
}

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

const basePayload: InitPayload = {
  rules: null,
  rulesHash: null,
  bridgeUrl: null,
  seed: null,
};

describe('applyServeInit — rules', () => {
  it('deploys the project rules (deny-all governs subsequent ops)', async () => {
    const ctx = await makeCtx();
    const result = applyServeInit(ctx, { ...basePayload, rules: DENY_ALL_RULES }, { fetch: recordingFetch() });
    expect(result.rulesDeployed).toBe(true);
    expect(result.rulesParseError).toBeNull();

    // A read is now denied (no signed-in user; deny-all).
    const port = fakePort();
    await handleMessage(ctx, port, { t: 'op', id: 'r1', method: 'getDoc', path: 'todos/t1' });
    const res = getRes(port, 'r1');
    expect(res.ok).toBe(false);
    expect((res as ResMessage & { ok: false }).error.code).toBe('permission-denied');
  });

  it('surfaces a parse error without throwing (defensive — server lints first)', async () => {
    const ctx = await makeCtx();
    // A malformed ruleset reaching the worker is a defensive edge (the server
    // lints before serving). applyServeInit must record it and continue, not
    // throw. pyric's setRules fails CLOSED on a parse error (safer than
    // fail-open), so we only assert the no-throw + recorded-error contract.
    const result = applyServeInit(ctx, { ...basePayload, rules: 'this is not valid rules {{' }, { fetch: recordingFetch() });
    expect(result.rulesDeployed).toBe(false);
    expect(result.rulesParseError).not.toBeNull();
  });
});

describe('applyServeInit — seed + authUsers', () => {
  it('seeds docs (admin-style, before app code)', async () => {
    const ctx = await makeCtx();
    const result = applyServeInit(
      ctx,
      { ...basePayload, seed: { 'todos/t1': { title: 'seeded', done: false } } },
      { fetch: recordingFetch() },
    );
    expect(result.seededDocs).toBe(1);

    const port = fakePort();
    await handleMessage(ctx, port, { t: 'op', id: 'g1', method: 'getDoc', path: 'todos/t1' });
    const res = getRes(port, 'g1') as ResMessage & { ok: true };
    const value = res.value as { exists: boolean; data?: { json: string } };
    expect(value.exists).toBe(true);
    expect(JSON.parse(value.data!.json).title).toBe('seeded');
  });

  it('seeds auth users (they can sign in afterward)', async () => {
    const ctx = await makeCtx();
    const result = applyServeInit(
      ctx,
      { ...basePayload, authUsers: [{ uid: 'u1', email: 'a@b.com', password: 'pw123456' }] },
      { fetch: recordingFetch() },
    );
    expect(result.seededUsers).toBe(1);
    // Exported from the live auth handle (round-trips through seedUsers).
    expect(authOps.exportUsers(ensureAuth(ctx)).map((u) => u.email)).toContain('a@b.com');

    const port = fakePort();
    await handleMessage(ctx, port, {
      t: 'op', id: 's1', method: 'auth.signInEmail', email: 'a@b.com', password: 'pw123456',
    });
    const res = getRes(port, 's1') as ResMessage & { ok: true };
    expect((res.value as { user: { uid: string } }).user.uid).toBe('u1');
  });
});

describe('applyServeInit — seed applies only into an empty home (guardrail)', () => {
  it('skips seed docs when the sandbox already has a document (restored/lived data)', async () => {
    const ctx = await makeCtx();
    // Simulate a restore that ran before applyServeInit (buildWorkerCtx calls
    // enablePersistence before applyServeInit): a doc already lives in the db.
    await handleMessage(ctx, fakePort(), { t: 'op', id: 'pre', method: 'setDoc', path: 'todos/existing', data: { title: 'lived' } });

    const result = applyServeInit(
      ctx,
      { ...basePayload, seed: { 'todos/t1': { title: 'seeded', done: false } } },
      { fetch: recordingFetch() },
    );
    expect(result.seededDocs).toBe(0);
    expect(result.seedSkipped).toBe('existing-data');

    const port = fakePort();
    await handleMessage(ctx, port, { t: 'op', id: 'g1', method: 'getDoc', path: 'todos/t1' });
    const res = getRes(port, 'g1') as ResMessage & { ok: true };
    expect((res.value as { exists: boolean }).exists).toBe(false); // fixture never applied
  });

  it('skips seeding authUsers when the sandbox already has a document', async () => {
    const ctx = await makeCtx();
    await handleMessage(ctx, fakePort(), { t: 'op', id: 'pre', method: 'setDoc', path: 'todos/existing', data: { title: 'lived' } });

    const result = applyServeInit(
      ctx,
      { ...basePayload, authUsers: [{ uid: 'u1', email: 'a@b.com', password: 'pw123456' }] },
      { fetch: recordingFetch() },
    );
    expect(result.seededUsers).toBe(0);
    expect(result.seedSkipped).toBe('existing-data');
    expect(authOps.exportUsers(ensureAuth(ctx)).map((u) => u.email)).not.toContain('a@b.com');
  });

  it('skips seed docs when the sandbox already has an auth user (no docs, users only)', async () => {
    const ctx = await makeCtx();
    authOps.seedUsers(ensureAuth(ctx), [{ uid: 'existing', email: 'x@y.com', password: 'pw123456' }]);

    const result = applyServeInit(
      ctx,
      { ...basePayload, seed: { 'todos/t1': { title: 'seeded' } } },
      { fetch: recordingFetch() },
    );
    expect(result.seededDocs).toBe(0);
    expect(result.seedSkipped).toBe('existing-data');
  });

  it('applies the seed (docs + authUsers) when the sandbox is genuinely empty', async () => {
    const ctx = await makeCtx();
    const result = applyServeInit(
      ctx,
      {
        ...basePayload,
        seed: { 'todos/t1': { title: 'seeded' } },
        authUsers: [{ uid: 'u1', email: 'a@b.com', password: 'pw123456' }],
      },
      { fetch: recordingFetch() },
    );
    expect(result.seededDocs).toBe(1);
    expect(result.seededUsers).toBe(1);
    expect(result.seedSkipped).toBeNull();
  });

  it('--persist first run: IDB already holding data (prior non-persist session) is treated as non-empty', async () => {
    // Regression for the interaction the task flagged: a --persist FIRST run
    // (no server file yet) where IDB already has data from an earlier
    // non-persist session must NOT be treated as empty.
    const sandbox = initializeSandbox();
    const { getFirestore: getAdminFirestore } = await import('pyric/sandbox/admin-firestore');
    getAdminFirestore(sandbox.withAuth(null)).setRules(PERMISSIVE_RULES);
    const idb = createMemoryBackend();
    await idb.putRecords('pyric-shared-worker', serializeToBuckets({ 'todos/carried-over': { v: 1 } }, {}, 0));
    await sandbox.enablePersistence({ key: 'pyric-shared-worker', injectedBackend: idb });
    const ctx: HostCtx = { db: getFirestore(sandbox), sandbox, subs: new Map() };

    const result = applyServeInit(
      ctx,
      { ...basePayload, seed: { 'todos/t1': { title: 'seeded' } } },
      { fetch: recordingFetch() },
    );
    expect(result.seededDocs).toBe(0);
    expect(result.seedSkipped).toBe('existing-data');
  });
});

describe('applyServeInit — capture (the verify loop)', () => {
  it('POSTs the service-shaped session fixture to /__pyric/capture, then dispose stops it', async () => {
    const ctx = await makeCtx();
    const fetchSpy = recordingFetch();
    const result = applyServeInit(
      ctx,
      { ...basePayload, rules: PERMISSIVE_RULES, databaseRules: RTDB_RULES, capture: true },
      { fetch: fetchSpy, captureDebounceMs: 5 },
    );
    expect(result.captureEnabled).toBe(true);

    // A write emits a sandbox event → debounced capture POST.
    const port = fakePort();
    await handleMessage(ctx, port, { t: 'op', id: 'w1', method: 'setDoc', path: 'todos/t1', data: { title: 'live' } });
    await handleMessage(ctx, port, { t: 'op', id: 'r1', method: 'rtdb.set', path: '/rooms/r1', value: { name: 'General' } });
    await tick(20);

    const captures = fetchSpy.calls.filter((c) => c.url === '/__pyric/capture');
    expect(captures.length).toBeGreaterThanOrEqual(1);
    const body = JSON.parse(captures.at(-1)!.body) as {
      schema: string;
      events: unknown[];
      services: {
        firestore: { rules: { source: string }; state: { documents: Record<string, unknown> } };
        rtdb: { rules: { json: unknown }; state: { tree: { rooms?: unknown } } };
      };
    };
    expect(body.schema).toBe('pyric.verify.fixture.v1');
    expect(body.services.firestore.rules.source).toContain('rules_version');
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.services.firestore.state.documents['todos/t1']).toBeDefined();
    expect(body.services.rtdb.rules.json).toEqual(RTDB_RULES);
    expect(body.services.rtdb.state.tree.rooms).toBeDefined();

    // After dispose, further writes do NOT capture.
    result.dispose();
    const before = fetchSpy.calls.length;
    await handleMessage(ctx, port, { t: 'op', id: 'w2', method: 'setDoc', path: 'todos/t2', data: { title: 'after' } });
    await tick(20);
    expect(fetchSpy.calls.length).toBe(before);
  });

  it('no capture wiring when capture is off', async () => {
    const ctx = await makeCtx();
    const fetchSpy = recordingFetch();
    const result = applyServeInit(ctx, { ...basePayload, rules: PERMISSIVE_RULES }, { fetch: fetchSpy, captureDebounceMs: 5 });
    expect(result.captureEnabled).toBe(false);
    const port = fakePort();
    await handleMessage(ctx, port, { t: 'op', id: 'w1', method: 'setDoc', path: 'todos/t1', data: { title: 'x' } });
    await tick(20);
    expect(fetchSpy.calls.length).toBe(0);
  });
});

describe('createWorkerDurableBackend — durable strategy (3c.D)', () => {
  it('plain mode returns the raw IDB backend untouched', () => {
    const idb = createMemoryBackend();
    const durable = createWorkerDurableBackend(idb, basePayload, { fetch: fakeFetch() });
    expect(durable).toBe(idb);
  });

  it('--persist: primes from the committable server file when IDB is empty', async () => {
    const idb = createMemoryBackend();
    const serverBundle = bundleRecords(
      serializeToBuckets({ 'todos/s1': { title: 'from-server' } }, {}, 0),
    );
    const f = fakeFetch((url) =>
      url.includes('section=firestore') ? { status: 200, body: serverBundle } : { status: 404, body: 'null' },
    );
    const durable = createWorkerDurableBackend(idb, { ...basePayload, persist: true }, { fetch: f });

    // A read primes from the server file, then serves from IDB.
    expect((await readBackendFirestore(durable, PERSIST_KEY))['todos/s1']).toEqual({ title: 'from-server' });
    expect(f.calls.some((c) => c.method === 'GET' && c.url.includes('section=firestore'))).toBe(true);
    // …and the records settled into IDB so subsequent reads are local.
    expect((await readBackendFirestore(idb, PERSIST_KEY))['todos/s1']).toEqual({ title: 'from-server' });
  });

  it('--persist: live local IDB wins on read (no server clobber)', async () => {
    const idb = createMemoryBackend();
    await idb.putRecords(PERSIST_KEY, serializeToBuckets({ 'todos/local': { v: 1 } }, {}, 0));
    const f = fakeFetch(() => ({
      status: 200,
      body: bundleRecords(serializeToBuckets({ 'todos/server': { v: 9 } }, {}, 0)),
    }));
    const durable = createWorkerDurableBackend(idb, { ...basePayload, persist: true }, { fetch: f });

    const fs = await readBackendFirestore(durable, PERSIST_KEY);
    expect(fs['todos/local']).toEqual({ v: 1 });
    expect(fs['todos/server']).toBeUndefined();
    expect(f.calls.some((c) => c.method === 'GET')).toBe(false); // never reached the server
  });

  it('--persist: write mirrors the records to the server file with a writer id', async () => {
    const idb = createMemoryBackend();
    const f = fakeFetch();
    const durable = createWorkerDurableBackend(idb, { ...basePayload, persist: true }, { fetch: f });

    await durable.putRecords(PERSIST_KEY, serializeToBuckets({ 'todos/x': { title: 'new' } }, {}, 0));
    expect((await readBackendFirestore(idb, PERSIST_KEY))['todos/x']).toEqual({ title: 'new' }); // IDB is live
    const post = f.calls.find((c) => c.method === 'POST' && c.url.includes('section=firestore'));
    expect(post).toBeDefined();
    expect(deserializeFromBuckets([...parseBundle(post!.body)]).firestore['todos/x']).toEqual({ title: 'new' });
    expect(post!.writer).toBe('pyric-shared-worker'); // single-writer id
  });

  it('seedState fixture primes IDB once from the bundled records (no server)', async () => {
    const idb = createMemoryBackend();
    const f = fakeFetch();
    const seedState = { firestore: { 'todos/t1': { title: 'fixture' } } };
    const durable = createWorkerDurableBackend(idb, { ...basePayload, seedState }, { fetch: f });

    expect((await readBackendFirestore(durable, PERSIST_KEY))['todos/t1']).toEqual({ title: 'fixture' });
    expect((await readBackendFirestore(idb, PERSIST_KEY))['todos/t1']).toEqual({ title: 'fixture' });
    expect(f.calls.length).toBe(0); // a fixture never touches the server file
  });
});

describe('setupServerAuthFlush — committable auth mirror (3c.D)', () => {
  it('--persist: mirrors the user DB to /__pyric/state?section=auth on a change', async () => {
    const ctx = await makeCtx();
    const f = fakeFetch();
    const dispose = setupServerAuthFlush(ctx, { ...basePayload, persist: true }, { fetch: f, captureDebounceMs: 5 });

    // Create a user → auth change → debounced auth-section flush.
    const port = fakePort();
    await handleMessage(ctx, port, {
      t: 'op', id: 'c1', method: 'auth.createUser', email: 'z@b.com', password: 'pw123456',
    });
    await tick(20);

    const authPost = f.calls.find((c) => c.method === 'POST' && c.url.includes('section=auth'));
    expect(authPost).toBeDefined();
    const body = JSON.parse(authPost!.body) as { users: Array<{ email: string }> };
    expect(body.users.map((u) => u.email)).toContain('z@b.com');
    expect(authPost!.writer).toBe('pyric-shared-worker');

    dispose();
  });

  it('is a no-op without --persist', async () => {
    const ctx = await makeCtx();
    const f = fakeFetch();
    const dispose = setupServerAuthFlush(ctx, basePayload, { fetch: f, captureDebounceMs: 5 });
    const port = fakePort();
    await handleMessage(ctx, port, {
      t: 'op', id: 'c1', method: 'auth.createUser', email: 'z@b.com', password: 'pw123456',
    });
    await tick(20);
    expect(f.calls.length).toBe(0);
    dispose();
  });
});

describe('setupWorkerHotReload — the worker owns the single SSE', () => {
  /** Fake EventSource: records its url, lets a test emit named events, tracks close. */
  class FakeES implements EventSourceLike {
    static last: FakeES | null = null;
    listeners = new Map<string, (ev: { data: string }) => void>();
    closed = false;
    constructor(public url: string) { FakeES.last = this; }
    addEventListener(type: string, fn: (ev: { data: string }) => void) { this.listeners.set(type, fn); }
    close() { this.closed = true; }
    emit(type: string, data: string) { this.listeners.get(type)?.({ data }); }
  }

  it('connects to /__pyric/events and re-deploys rules on rules-changed', async () => {
    const ctx = await makeCtx(); // permissive
    const dispose = setupWorkerHotReload(ctx, (url) => new FakeES(url));
    const es = FakeES.last!;
    expect(es.url).toBe('/__pyric/events');

    // Initially a read is allowed (permissive).
    const p1 = fakePort();
    await handleMessage(ctx, p1, { t: 'op', id: 'r1', method: 'getDoc', path: 'todos/t1' });
    expect(getRes(p1, 'r1').ok).toBe(true);

    // Hot-reload to DENY-all → subsequent reads are denied.
    es.emit('rules-changed', JSON.stringify({ rules: DENY_ALL_RULES, rulesHash: 'h2' }));
    const p2 = fakePort();
    await handleMessage(ctx, p2, { t: 'op', id: 'r2', method: 'getDoc', path: 'todos/t1' });
    const res = getRes(p2, 'r2');
    expect(res.ok).toBe(false);
    expect((res as ResMessage & { ok: false }).error.code).toBe('permission-denied');

    dispose();
    expect(es.closed).toBe(true);
  });
});

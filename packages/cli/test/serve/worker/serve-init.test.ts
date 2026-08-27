import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import {
  handleMessage,
  ensureAuth,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import {
  applyServeInit,
  buildWorkerCtx,
  hydrateEventHistory,
  setupWorkerHotReload,
  MAX_PRIMED_EVENTS,
  type EventSourceLike,
} from '../../../src/serve/worker/serve-init.js';
import type { InitPayload } from '../../../src/serve/namespace.js';
import type { OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';
import { bytesToBase64 } from '../../../src/serve/worker/protocol.js';
import { sandbox as authOps } from 'pyric/auth';
import {
  initializeSandbox,
  createMemoryBackend,
  serializeToBuckets,
} from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';

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

const DENY_ALL_STORAGE_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}`;

const OWNER_ONLY_STORAGE_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{file} {
      allow read, write: if request.auth.uid == uid;
    }
  }
}`;

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

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

const basePayload: InitPayload = {
  activityToken: 'activity-test-token',
  rules: null,
  rulesHash: null,
  storageRules: null,
  storageRulesHash: null,
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
describe('applyServeInit — storage rules', () => {
  it('deploys storage.rules at boot: a deny-all ruleset denies an upload through the worker', async () => {
    const ctx = await makeCtx();
    const result = applyServeInit(
      ctx,
      { ...basePayload, storageRules: DENY_ALL_STORAGE_RULES },
      { fetch: recordingFetch() },
    );
    expect(result.storageRulesDeployed).toBe(true);

    const port = fakePort();
    await handleMessage(ctx, port, {
      t: 'op',
      id: 's1',
      method: 'storage.putBytes',
      path: 'locked/x',
      dataB64: bytesToBase64(new TextEncoder().encode('hello')),
    });
    const res = getRes(port, 's1');
    expect(res.ok).toBe(false);
    expect((res as ResMessage & { ok: false }).error.code).toBe('storage/unauthorized');
  });

  it('an allowed op passes through when rules permit it (owner-only, acting as the owner)', async () => {
    const ctx = await makeCtx();
    const result = applyServeInit(
      ctx,
      { ...basePayload, storageRules: OWNER_ONLY_STORAGE_RULES },
      { fetch: recordingFetch() },
    );
    expect(result.storageRulesDeployed).toBe(true);

    const port = fakePort();
    await handleMessage(ctx, port, {
      t: 'op',
      id: 's2',
      method: 'storage.putBytes',
      path: 'users/ada/notes.txt',
      dataB64: bytesToBase64(new TextEncoder().encode('mine')),
      actAs: { mode: 'as', uid: 'ada' },
    });
    const res = getRes(port, 's2');
    expect(res.ok).toBe(true);
  });

  it('no storage.rules configured: matches Firestore/RTDB\'s open-by-default posture', async () => {
    const ctx = await makeCtx();
    const result = applyServeInit(ctx, { ...basePayload, storageRules: null }, { fetch: recordingFetch() });
    expect(result.storageRulesDeployed).toBe(false);

    const port = fakePort();
    await handleMessage(ctx, port, {
      t: 'op',
      id: 's3',
      method: 'storage.putBytes',
      path: 'anything/goes',
      dataB64: bytesToBase64(new TextEncoder().encode('open')),
    });
    const res = getRes(port, 's3');
    expect(res.ok).toBe(true);
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

  it('exposes an immediate capture flush that resolves only after its POST settles', async () => {
    const ctx = await makeCtx();
    let resolvePost!: (response: Response) => void;
    const pendingFetch = (() => new Promise<Response>((resolve) => {
      resolvePost = resolve;
    })) as typeof fetch;
    applyServeInit(
      ctx,
      { ...basePayload, capture: true },
      { fetch: pendingFetch, captureDebounceMs: 5 },
    );

    let settled = false;
    const flushing = ctx.captureFlush!().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolvePost({ ok: true, status: 204 } as Response);
    await flushing;
    expect(settled).toBe(true);
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

  it('connects to /__pyric/events and updates Realtime Database rules on rtdb-rules-update', async () => {
    const ctx = await makeCtx();
    const dispose = setupWorkerHotReload(ctx, (url) => new FakeES(url));
    const es = FakeES.last!;
    expect(es.url).toBe('/__pyric/events');

    es.emit('rtdb-rules-update', JSON.stringify({
      rules: { rules: { '.read': 'false', '.write': 'false' } },
      rulesHash: 'hash123',
    }));

    expect(ctx.activeRules?.database?.status).toBe('active');
    expect(ctx.activeRules?.database?.source).toEqual({ rules: { '.read': 'false', '.write': 'false' } });
    expect(ctx.rtdb).toBeDefined();

    dispose();
    expect(es.closed).toBe(true);
  });
});

// ─── Event-history hydration: survive worker death ──────────────────────────

/** A capture fixture with `n` events, optionally stamped with `capturedBy`. */
function captureFixture(n: number, capturedBy?: string): string {
  const events = Array.from({ length: n }, (_, i) => ({
    kind: 'service_mutation',
    id: `cap-${i}`,
    at: i,
  }));
  return JSON.stringify({
    schema: 'pyric.verify.fixture.v1',
    ...(capturedBy ? { capturedBy } : {}),
    events,
    services: {},
  });
}

/** A fetch that answers GET /__pyric/capture with `captureBody` (or 404 when
 *  null). Any other GET / POST resolves 204. */
function captureFetch(captureBody: string | null): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const fn = ((url: string, init?: { method?: string }) => {
    calls.push(String(url));
    if ((init?.method ?? 'GET') === 'GET' && String(url) === '/__pyric/capture') {
      return captureBody === null
        ? Promise.resolve({ status: 404, ok: false, text: () => Promise.resolve('null') } as Response)
        : Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve(captureBody) } as Response);
    }
    return Promise.resolve({ status: 204, ok: true, text: () => Promise.resolve('') } as Response);
  }) as typeof fetch & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe('hydrateEventHistory — Traffic/activity survives worker death', () => {
  it('primes eventHistory from the served capture on a fresh worker', async () => {
    const ctx = { ...(await makeCtx()), instanceId: 'inst-A' } as HostCtx;
    const primed = await hydrateEventHistory(ctx, { fetch: captureFetch(captureFixture(3, 'inst-A')) });
    expect(primed).toBe(3);
    expect(ctx.sandbox.history().map((e) => e.id)).toEqual(['cap-0', 'cap-1', 'cap-2']);
  });

  it('does NOT dispatch primed events to live onEvent subscribers (append-only)', async () => {
    const ctx = { ...(await makeCtx()), instanceId: 'inst-A' } as HostCtx;
    const seen: string[] = [];
    ctx.sandbox.onEvent((e) => void seen.push(e.id));
    await hydrateEventHistory(ctx, { fetch: captureFetch(captureFixture(3, 'inst-A')) });
    // History has them (Studio reads history-first)…
    expect(ctx.sandbox.history()).toHaveLength(3);
    // …but no live re-emission to already-attached subscribers.
    expect(seen).toEqual([]);
  });

  it('skips when history is already non-empty (empty-history guard)', async () => {
    const ctx = { ...(await makeCtx()), instanceId: 'inst-A' } as HostCtx;
    // A live write lands one real event first (client setDoc emits a request
    // event; admin writes deliberately don't).
    const port = fakePort();
    await handleMessage(ctx, port, { t: 'op', id: 'w1', method: 'setDoc', path: 'a/b', data: { x: 1 } });
    const before = ctx.sandbox.history().length;
    expect(before).toBeGreaterThan(0);
    const primed = await hydrateEventHistory(ctx, { fetch: captureFetch(captureFixture(3, 'inst-A')) });
    expect(primed).toBe(0);
    expect(ctx.sandbox.history().length).toBe(before);
  });

  it(`caps priming at the most recent ${MAX_PRIMED_EVENTS} events`, async () => {
    const ctx = { ...(await makeCtx()), instanceId: 'inst-A' } as HostCtx;
    const primed = await hydrateEventHistory(ctx, {
      fetch: captureFetch(captureFixture(MAX_PRIMED_EVENTS + 50, 'inst-A')),
    });
    expect(primed).toBe(MAX_PRIMED_EVENTS);
    const hist = ctx.sandbox.history();
    // Kept the tail (most recent), dropped the oldest 50.
    expect(hist).toHaveLength(MAX_PRIMED_EVENTS);
    expect(hist[0].id).toBe('cap-50');
    expect(hist.at(-1)!.id).toBe(`cap-${MAX_PRIMED_EVENTS + 49}`);
  });

  it('skips a capture produced by a DIFFERENT instance (identity guard)', async () => {
    const ctx = { ...(await makeCtx()), instanceId: 'inst-A' } as HostCtx;
    const primed = await hydrateEventHistory(ctx, { fetch: captureFetch(captureFixture(3, 'inst-OTHER')) });
    expect(primed).toBe(0);
    expect(ctx.sandbox.history()).toHaveLength(0);
  });

  it('primes best-effort when the capture carries no instance id (older/standalone)', async () => {
    const ctx = { ...(await makeCtx()), instanceId: 'inst-A' } as HostCtx;
    const primed = await hydrateEventHistory(ctx, { fetch: captureFetch(captureFixture(2)) });
    expect(primed).toBe(2);
  });

  it('skips cleanly on 404 (capture off / nothing captured yet)', async () => {
    const ctx = { ...(await makeCtx()), instanceId: 'inst-A' } as HostCtx;
    const primed = await hydrateEventHistory(ctx, { fetch: captureFetch(null) });
    expect(primed).toBe(0);
  });

  it('skips cleanly when fetch throws (standalone worker, no pyric dev)', async () => {
    const ctx = { ...(await makeCtx()), instanceId: 'inst-A' } as HostCtx;
    const throwing = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    const primed = await hydrateEventHistory(ctx, { fetch: throwing });
    expect(primed).toBe(0);
  });
});

describe('buildWorkerCtx — boot-time hydration + reset non-resurrection', () => {
  const initJson = (capture: boolean): string =>
    JSON.stringify({ rules: null, rulesHash: null, bridgeUrl: null, seed: null, capture });

  /** A fetch that serves BOTH /__pyric/init.json and GET /__pyric/capture. */
  function bootFetch(capture: string | null): typeof fetch {
    return ((url: string, init?: { method?: string }) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u === '/__pyric/init.json') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(initJson(true))) } as Response);
      }
      if (u === '/__pyric/capture' && method === 'GET') {
        return capture === null
          ? Promise.resolve({ status: 404, ok: false, text: () => Promise.resolve('null') } as Response)
          : Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve(capture) } as Response);
      }
      return Promise.resolve({ status: 204, ok: true, text: () => Promise.resolve(''), json: () => Promise.resolve({}) } as Response);
    }) as unknown as typeof fetch;
  }

  it('wires the plugin-level engine (payload.ai.engine) into ctx.aiEngine', async () => {
    const engine = { kind: 'openai', baseUrl: '/__pyric/ai-proxy', model: 'llama3.2' } as const;
    const aiFetch = ((url: string) => {
      if (String(url) === '/__pyric/init.json') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ rules: null, rulesHash: null, bridgeUrl: null, seed: null, ai: { engine } }),
        } as Response);
      }
      return Promise.resolve({ status: 204, ok: true, text: () => Promise.resolve(''), json: () => Promise.resolve({}) } as Response);
    }) as unknown as typeof fetch;
    const ctx = await buildWorkerCtx({ fetch: aiFetch, idb: createMemoryBackend() });
    expect(ctx.aiEngine).toEqual(engine);
  });

  it('leaves ctx.aiEngine unset when the payload carries no ai config (pyric dev)', async () => {
    const ctx = await buildWorkerCtx({ fetch: bootFetch(null), idb: createMemoryBackend() });
    expect(ctx.aiEngine).toBeUndefined();
  });

  it('a booted worker re-hydrates its own session history from the capture', async () => {
    const idb = createMemoryBackend();
    const instanceId = await (await import('../../../src/serve/worker/host.js')).getOrCreateInstanceId(idb);
    const ctx = await buildWorkerCtx({ fetch: bootFetch(captureFixture(4, instanceId)), idb });
    expect(ctx.sandbox.history().filter((e) => e.id.startsWith('cap-'))).toHaveLength(4);
  });

  /**
   * Issue #364 characterization. The REAL browser `fetch` is this-sensitive:
   * invoked as a member call (`env.fetch(...)`) it sees `this === env` and
   * throws "Illegal invocation" (verified against Chromium). Every capture /
   * hydration call site in serve-init.ts invokes it exactly that way, so in a
   * real worker the capture flush never POSTed and `hydrateEventHistory`'s GET
   * failed into its catch — a rebooted worker answered Studio's first event
   * subscription with an EMPTY history, and the Activity/Traffic first open
   * showed nothing. Plain stub fetches can't catch this; this wrapper replays
   * the browser's `this` contract.
   */
  function browserishFetch(impl: typeof fetch): typeof fetch {
    return function (this: unknown, ...args: Parameters<typeof fetch>) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError(
          "Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation",
        );
      }
      return impl(...args);
    } as typeof fetch;
  }

  it('hydrates boot history through a browser-faithful (this-sensitive) fetch — issue #364', async () => {
    const idb = createMemoryBackend();
    const instanceId = await (await import('../../../src/serve/worker/host.js')).getOrCreateInstanceId(idb);
    const ctx = await buildWorkerCtx({
      fetch: browserishFetch(bootFetch(captureFixture(4, instanceId))),
      idb,
    });
    expect(ctx.sandbox.history().filter((e) => e.id.startsWith('cap-'))).toHaveLength(4);
  });

  it('POSTs the capture through a browser-faithful (this-sensitive) fetch — issue #364', async () => {
    const posts: string[] = [];
    const impl = ((url: string, init?: { method?: string; body?: string }) => {
      const u = String(url);
      if (u === '/__pyric/init.json') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(initJson(true))) } as Response);
      }
      if (u === '/__pyric/capture' && init?.method === 'POST') {
        posts.push(String(init.body ?? ''));
        return Promise.resolve({ status: 204, ok: true, text: () => Promise.resolve('') } as Response);
      }
      return Promise.resolve({ status: 404, ok: false, text: () => Promise.resolve('null'), json: () => Promise.resolve({}) } as Response);
    }) as unknown as typeof fetch;

    const ctx = await buildWorkerCtx({
      fetch: browserishFetch(impl),
      idb: createMemoryBackend(),
      captureDebounceMs: 1,
    });
    const port = fakePort();
    await handleMessage(ctx, port, { t: 'op', id: 'w1', method: 'setDoc', path: 'notes/x', data: { v: 1 } });
    await tick(20);
    expect(posts.length).toBeGreaterThanOrEqual(1);
    expect((JSON.parse(posts.at(-1)!) as { events: { kind: string }[] }).events.some((e) => e.kind === 'write')).toBe(true);
  });

  it('does NOT resurrect pre-reset events: a post-reset capture reflects the cleared log', async () => {
    // 1. Boot, write, capture reflects the write.
    const store = { body: null as string | null };
    const captureCapturingFetch = ((url: string, init?: { method?: string; body?: string }) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u === '/__pyric/init.json') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(initJson(true))) } as Response);
      }
      if (u === '/__pyric/capture' && method === 'POST') {
        store.body = String(init?.body ?? ''); // server writes verbatim.
        return Promise.resolve({ status: 204, ok: true, text: () => Promise.resolve('') } as Response);
      }
      if (u === '/__pyric/capture' && method === 'GET') {
        return store.body === null
          ? Promise.resolve({ status: 404, ok: false, text: () => Promise.resolve('null') } as Response)
          : Promise.resolve({ status: 200, ok: true, text: () => Promise.resolve(store.body) } as Response);
      }
      return Promise.resolve({ status: 204, ok: true, text: () => Promise.resolve(''), json: () => Promise.resolve({}) } as Response);
    }) as unknown as typeof fetch;

    const idb = createMemoryBackend();
    const ctxA = await buildWorkerCtx({ fetch: captureCapturingFetch, idb, captureDebounceMs: 1 });
    const port = fakePort();
    await handleMessage(ctxA, port, { t: 'op', id: 'w1', method: 'setDoc', path: 'notes/x', data: { v: 1 } });
    await tick(10);
    // Sanity: the pre-reset capture DID hold the write event.
    expect(store.body).not.toBeNull();
    expect((JSON.parse(store.body!) as { events: { kind: string }[] }).events.some((e) => e.kind === 'write')).toBe(true);

    // reset() clears history (after the boundary) → capture flush writes the
    // cleared log. Wait out the debounce + flush.
    ctxA.sandbox.reset();
    await tick(30);
    expect(store.body).not.toBeNull();
    const afterReset = JSON.parse(store.body!) as { events: { id: string; kind: string }[] };
    // No pre-reset write event survives in the persisted capture.
    expect(afterReset.events.every((e) => e.kind !== 'write')).toBe(true);

    // 2. A cold reboot hydrates from that cleared capture → no resurrection.
    const ctxB = await buildWorkerCtx({ fetch: captureCapturingFetch, idb, captureDebounceMs: 1 });
    expect(ctxB.sandbox.history().some((e) => e.kind === 'write')).toBe(false);
  });
});

describe('applyServeInit — Realtime Database default security policy', () => {
  it('enforces default-deny when database rules are unconfigured', async () => {
    const ctx = await makeCtx();
    applyServeInit(ctx, { ...basePayload, databaseRules: null, permissive: false }, { fetch: recordingFetch() });

    const port = fakePort();
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'rtdb-write-1',
      method: 'rtdb.set',
      path: '/items/item1',
      value: { title: 'secret' },
    });

    const res = getRes(port, 'rtdb-write-1');
    expect(res.ok).toBe(false);
    expect((res as { error: { message: string } }).error.message).toContain('PERMISSION_DENIED');
  });

  it('allows open access when permissive mode is explicitly enabled', async () => {
    const ctx = await makeCtx();
    applyServeInit(ctx, { ...basePayload, databaseRules: null, permissive: true }, { fetch: recordingFetch() });

    const port = fakePort();
    await handleMessage(ctx, port, {
      t: 'op',
      id: 'rtdb-write-2',
      method: 'rtdb.set',
      path: '/items/item2',
      value: { title: 'open' },
    });

    const res = getRes(port, 'rtdb-write-2');
    expect(res.ok).toBe(true);
  });
});

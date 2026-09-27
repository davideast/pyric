/**
 * Tests for the Studio live data plane (Wave 2.5a): `worker-live.ts` + the
 * `createStudioEnvironment('local')` live-plane gating.
 *
 * The full SharedWorker connection can only be proven in a real browser (the
 * orchestrator's smoke-test). These unit tests cover the layers that DON'T need
 * a real worker:
 *   - `connectWorkerLive()` returns null when no `SharedWorker` global exists
 *     (SSR / unsupported browser / tests): the HTTP-fallback contract.
 *   - the env factory omits `live` when there's no worker / `disableLive`, and
 *     surfaces a live plane (with an `EventFeed`-shaped feed + lens controls)
 *     when a minimal `SharedWorker` is shimmed.
 *   - the env never throws in `local` mode regardless of worker availability.
 */

import { describe, it, expect, afterEach } from 'bun:test';
import {
  connectWorkerLive,
  studioWorkerConnection,
  workerEventFeed,
} from './worker-live.js';
import { createStudioEnvironment } from '../env.js';
import type { SandboxEvent } from 'pyric/sandbox';
import {
  getFirestore as workerGetFirestore,
  setLens as resetWorkerLens,
  type ClientDb,
} from '@pyric/cli/serve/worker';

/** Install a minimal SharedWorker shim whose port records postMessages but never
 *  replies, enough to exercise client construction + the live-plane shape
 *  without a real worker. Returns a restore fn. */
function shimSharedWorker(): () => void {
  const prev = (globalThis as { SharedWorker?: unknown }).SharedWorker;
  (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
    port = {
      postMessage() {},
      start() {},
      onmessage: null as unknown,
      addEventListener() {},
      close() {},
    };
    constructor(_url: unknown, _opts: unknown) {}
  };
  return () => {
    (globalThis as { SharedWorker?: unknown }).SharedWorker = prev;
  };
}

/** Force "no SharedWorker" regardless of the host environment. */
function removeSharedWorker(): () => void {
  const prev = (globalThis as { SharedWorker?: unknown }).SharedWorker;
  delete (globalThis as { SharedWorker?: unknown }).SharedWorker;
  return () => {
    (globalThis as { SharedWorker?: unknown }).SharedWorker = prev;
  };
}

describe('connectWorkerLive', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
    resetWorkerLens(undefined);
  });

  it('returns null when no SharedWorker is available (HTTP-fallback contract)', () => {
    restore = removeSharedWorker();
    expect(connectWorkerLive()).toBeNull();
  });

  it('selects the same served worker generation as the application runtime', () => {
    const values = new Map<string, string>();
    const target = studioWorkerConnection({
      document: {
        querySelector: () => ({
          getAttribute: (name) => name === 'content' ? '0123456789abcdef' : null,
        }),
      },
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => { values.set(key, value); },
      },
    });

    expect(target).toEqual({
      url: '/__pyric/sdk/worker.js',
      name: 'pyric-shared-worker:0123456789abcdef',
    });
    expect(values.get('pyric:worker-generation')).toBe('0123456789abcdef');
  });

  it('returns a live plane with feed + lens seams when SharedWorker exists', () => {
    restore = shimSharedWorker();
    const plane = connectWorkerLive();
    expect(plane).not.toBeNull();
    expect(plane!.db.__kind).toBe('client-db');
    // The feed is `{ history, subscribe }`-shaped (an EventFeed).
    expect(typeof plane!.feed.history).toBe('function');
    expect(typeof plane!.feed.subscribe).toBe('function');
    expect(plane!.feed.history()).toEqual([]);
    // Lens controls remain available on the live plane.
    expect(typeof plane!.setLens).toBe('function');
    expect(typeof plane!.getLens).toBe('function');
  });

  it('lens setter round-trips through the worker client module state', () => {
    restore = shimSharedWorker();
    const plane = connectWorkerLive()!;
    plane.setLens({ mode: 'as', uid: 'alice' });
    expect(plane.getLens()).toEqual({ mode: 'as', uid: 'alice' });
    plane.setLens({ mode: 'app-session' });
    // app-session is the default → reads back as undefined (no lens).
    expect(plane.getLens()).toBeUndefined();
  });

  it('disconnects and closes its SharedWorker port when disposed', async () => {
    const sw = controllableSharedWorker();
    restore = sw.restore;
    const plane = connectWorkerLive('worker://test')!;

    const disposed = plane.dispose();
    const disconnect = sw.port.sent.find(
      (message): message is { t: 'disconnect'; id: string } =>
        (message as { t?: string }).t === 'disconnect',
    );
    expect(disconnect).toBeDefined();

    sw.deliver({ t: 'res', id: disconnect!.id, ok: true, value: null });
    await disposed;

    expect(sw.port.closeCalls).toBe(1);
  });
});

/**
 * A controllable SharedWorker shim: its port records outbound messages and
 * exposes `deliver()` to push a worker→client message into the wired
 * `onmessage` (the real client's `wirePort` attaches it). Lets us drive the
 * event-stream protocol against the REAL worker client without a real worker.
 */
function controllableSharedWorker(): {
  restore: () => void;
  port: {
    sent: unknown[];
    onmessage: ((ev: { data: unknown }) => void) | null;
    closeCalls: number;
  };
  deliver: (msg: unknown) => void;
} {
  const prev = (globalThis as { SharedWorker?: unknown }).SharedWorker;
  const port = {
    sent: [] as unknown[],
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    closeCalls: 0,
    postMessage(msg: unknown) {
      port.sent.push(msg);
    },
    start() {},
    addEventListener() {},
    close() {
      port.closeCalls += 1;
    },
  };
  (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
    port = port;
    constructor(_url: unknown, _opts: unknown) {}
  };
  return {
    restore: () => {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = prev;
    },
    port,
    deliver: (msg) => port.onmessage?.({ data: msg }),
  };
}

function fakeWrite(id: string): SandboxEvent {
  return {
    kind: 'write',
    id,
    at: Date.now(),
    method: 'create',
    path: `users/${id}`,
    auth: null,
    priorState: null,
    nextState: {},
    requestTime: { seconds: 0, nanoseconds: 0 },
  } as SandboxEvent;
}

describe('Studio Firestore data lens', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
    resetWorkerLens(undefined);
  });

  it('pins admin before the first data-view subscription is registered', () => {
    const sw = controllableSharedWorker();
    restore = sw.restore;
    const plane = connectWorkerLive('worker://test');
    const hasNoPlane = plane === null;
    if (hasNoPlane) throw new Error('Expected the live Studio plane');
    const users = plane.firestoreApi.collection(
      plane.db as never,
      'users',
    );

    const unsubscribe = plane.firestoreApi.onSnapshot(plane.firestoreApi.query(users), () => {});
    const subscription = sw.port.sent.find(
      (message): message is { t: 'sub'; target: object; actAs?: { mode: string } } =>
        (message as { t?: string }).t === 'sub' &&
        typeof (message as { target?: unknown }).target === 'object',
    );

    expect(plane.getLens()).toEqual({ mode: 'admin' });
    expect(subscription?.actAs).toEqual({ mode: 'admin' });
    unsubscribe();
  });
});

describe('Studio Storage data lens', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
    resetWorkerLens(undefined);
  });

  it('sends the admin lens and Studio issuer on storage operations', async () => {
    const sw = controllableSharedWorker();
    restore = sw.restore;
    const plane = connectWorkerLive('worker://test')!;
    const objectRef = plane.storageApi.ref(plane.storage, 'avatars/alice.png');

    const pending = plane.storageApi.getMetadata(objectRef);
    const op = sw.port.sent.find(
      (message): message is { t: 'op'; id: string; method: string; issuer?: string; actAs?: { mode: string } } =>
        (message as { method?: string }).method === 'storage.getMetadata',
    );

    expect(op?.issuer).toBe('studio');
    expect(op?.actAs).toEqual({ mode: 'admin' });
    sw.deliver({ t: 'res', id: op!.id, ok: true, value: { fullPath: 'avatars/alice.png' } });
    await pending;
  });
});

describe('workerEventFeed (F1 live-feed adapter)', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('delivers the history backlog then live events to an early subscriber', () => {
    const sw = controllableSharedWorker();
    restore = sw.restore;
    const db: ClientDb = workerGetFirestore('worker://test');
    const feed = workerEventFeed(db);

    // Subscribe BEFORE any worker batch arrives (the useActionDigest order):
    // history() is empty at this instant.
    expect(feed.history()).toEqual([]);
    const seen: string[] = [];
    const unsub = feed.subscribe((e) => seen.push(e.id));

    // The feed opened a worker sub: grab its subId from the posted message.
    const subMsg = sw.port.sent.find(
      (m): m is { t: 'sub'; subId: string; target: string } =>
        (m as { t?: string }).t === 'sub' &&
        (m as { target?: string }).target === 'events',
    );
    expect(subMsg).toBeDefined();
    const subId = subMsg!.subId;

    // Worker delivers the initial history batch (backlog): the early
    // subscriber must receive it (not silently drop it).
    sw.deliver({ t: 'event', subId, events: [fakeWrite('h1'), fakeWrite('h2')] });
    expect(seen).toEqual(['h1', 'h2']);
    // And a late history() now reflects the backlog.
    expect(feed.history().map((e) => e.id)).toEqual(['h1', 'h2']);

    // Subsequent live events stream through + accrete into history().
    sw.deliver({ t: 'event', subId, events: [fakeWrite('l1')] });
    expect(seen).toEqual(['h1', 'h2', 'l1']);
    expect(feed.history().map((e) => e.id)).toEqual(['h1', 'h2', 'l1']);

    unsub();
    // After the last unsubscribe, the worker sub is torn down (unsub posted).
    const unsubMsg = sw.port.sent.find(
      (m) => (m as { t?: string }).t === 'unsub',
    );
    expect(unsubMsg).toBeDefined();
  });

  it('a reset session_boundary clears the running snapshot down to the boundary (issue #359 extension)', () => {
    const sw = controllableSharedWorker();
    restore = sw.restore;
    const db: ClientDb = workerGetFirestore('worker://test');
    const feed = workerEventFeed(db);
    const seen: string[] = [];
    feed.subscribe((e) => seen.push(e.id));

    const subMsg = sw.port.sent.find(
      (m): m is { t: 'sub'; subId: string; target: string } =>
        (m as { t?: string }).t === 'sub' &&
        (m as { target?: string }).target === 'events',
    );
    const subId = subMsg!.subId;

    // Accumulate a session, then the worker resets: `sandbox.reset()` emits
    // the boundary live and clears its own history. Pre-fix the feed's
    // running snapshot kept the wiped session's traffic forever — Studio's
    // Traffic pane still showed old requests after Settings → Reset.
    sw.deliver({ t: 'event', subId, events: [fakeWrite('h1'), fakeWrite('h2')] });
    sw.deliver({ t: 'event', subId, events: [fakeWrite('l1')] });
    const boundary = {
      kind: 'session_boundary',
      id: 'b1',
      at: Date.now(),
      phase: 'reset',
      priorOpCount: 3,
    } as unknown as SandboxEvent;
    sw.deliver({ t: 'event', subId, events: [boundary] });

    // Pinned decision (events/fold.ts): the live view keeps EXACTLY the
    // boundary as a "session reset" marker — nothing else survives.
    expect(feed.history().map((e) => e.id)).toEqual(['b1']);
    // Subscribers still see every delivery (the boundary included).
    expect(seen).toEqual(['h1', 'h2', 'l1', 'b1']);

    // The next session accumulates fresh on top of the marker.
    sw.deliver({ t: 'event', subId, events: [fakeWrite('n1')] });
    expect(feed.history().map((e) => e.id)).toEqual(['b1', 'n1']);
  });
});

describe('feed-driven refreshes over a history replay', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
    resetWorkerLens(undefined);
  });

  function authMutation(id: string): SandboxEvent {
    return {
      kind: 'service_mutation',
      id,
      at: Date.now(),
      service: 'auth',
      op: 'sign_in',
    } as unknown as SandboxEvent;
  }

  /** 600 events: 300 writes, then auth mutations interleaved with writes. */
  function historyBatch(): SandboxEvent[] {
    const events: SandboxEvent[] = [];
    for (let i = 0; i < 300; i++) events.push(fakeWrite(`w${i}`));
    for (let i = 0; i < 300; i++) {
      events.push(i % 3 === 0 ? authMutation(`a${i}`) : fakeWrite(`x${i}`));
    }
    return events;
  }

  function opsFor(sent: unknown[], method: string): { id: string }[] {
    return sent.filter(
      (m): m is { t: 'op'; id: string; method: string } =>
        (m as { t?: string }).t === 'op' && (m as { method?: string }).method === method,
    );
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('keeps one listRootCollections and one auth.listUsers in flight, then sends one follow-up', async () => {
    const sw = controllableSharedWorker();
    restore = sw.restore;
    const plane = connectWorkerLive('worker://test')!;

    // Two root-collection subscribers (the shell's status cluster and the Auth
    // page each hold one) and the Auth page's users subscriber. Each refreshes
    // on mount and on every event it receives.
    const refreshRoots = () => void plane.listRootCollections().catch(() => {});
    const listUsers = plane.authApi.listUsers as unknown as () => Promise<unknown>;
    const relist = () => void listUsers().catch(() => {});
    refreshRoots();
    plane.feed.subscribe(() => refreshRoots());
    refreshRoots();
    plane.feed.subscribe(() => refreshRoots());
    relist();
    plane.authApi.subscribeUsers(plane.auth, relist);

    const subMsg = sw.port.sent.find(
      (m): m is { t: 'sub'; subId: string } =>
        (m as { t?: string }).t === 'sub' && (m as { target?: string }).target === 'events',
    )!;
    sw.deliver({ t: 'event', subId: subMsg.subId, events: historyBatch() });

    expect(opsFor(sw.port.sent, 'listRootCollections')).toHaveLength(1);
    expect(opsFor(sw.port.sent, 'auth.listUsers')).toHaveLength(1);

    // The first requests resolve: one follow-up each covers every event that
    // arrived while they were in flight.
    const roots = opsFor(sw.port.sent, 'listRootCollections')[0]!;
    const users = opsFor(sw.port.sent, 'auth.listUsers')[0]!;
    sw.deliver({ t: 'res', id: roots.id, ok: true, value: { ids: ['moves'] } });
    sw.deliver({ t: 'res', id: users.id, ok: true, value: [] });
    await settle();
    expect(opsFor(sw.port.sent, 'listRootCollections')).toHaveLength(2);
    expect(opsFor(sw.port.sent, 'auth.listUsers')).toHaveLength(2);

    // The follow-ups resolve with no new events: nothing more is sent.
    const followRoots = opsFor(sw.port.sent, 'listRootCollections')[1]!;
    const followUsers = opsFor(sw.port.sent, 'auth.listUsers')[1]!;
    sw.deliver({ t: 'res', id: followRoots.id, ok: true, value: { ids: ['moves'] } });
    sw.deliver({ t: 'res', id: followUsers.id, ok: true, value: [] });
    await settle();
    expect(opsFor(sw.port.sent, 'listRootCollections')).toHaveLength(2);
    expect(opsFor(sw.port.sent, 'auth.listUsers')).toHaveLength(2);
  });

  it('delivers the follow-up result to every caller that asked while a request was in flight', async () => {
    const sw = controllableSharedWorker();
    restore = sw.restore;
    const plane = connectWorkerLive('worker://test')!;

    const first = plane.listRootCollections();
    const second = plane.listRootCollections();
    const third = plane.listRootCollections();
    const [initial] = opsFor(sw.port.sent, 'listRootCollections');
    sw.deliver({ t: 'res', id: initial!.id, ok: true, value: { ids: ['a'] } });
    expect(await first).toEqual(['a']);

    await settle();
    const [, followUp] = opsFor(sw.port.sent, 'listRootCollections');
    sw.deliver({ t: 'res', id: followUp!.id, ok: true, value: { ids: ['a', 'b'] } });
    expect(await second).toEqual(['a', 'b']);
    expect(await third).toEqual(['a', 'b']);
  });
});

describe('listDocuments (F2 phantom-inclusive browse)', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it("rides the 'admin.listDocuments' op and keeps the phantom flag", async () => {
    const sw = controllableSharedWorker();
    restore = sw.restore;
    const plane = connectWorkerLive('worker://test')!;

    const listed = plane.listDocuments('zones');
    const opMsg = sw.port.sent.find(
      (m): m is { t: 'op'; id: string; method: string; path: string } =>
        (m as { method?: string }).method === 'admin.listDocuments',
    );
    expect(opMsg).toBeDefined();
    expect(opMsg!.path).toBe('zones');

    // The host answers with full `{ path, data, phantom? }` records; the
    // plane drops `data` (browse needs ids, content reads via getDoc).
    sw.deliver({
      t: 'res',
      id: opMsg!.id,
      ok: true,
      value: [
        { path: 'zones/spawn', data: { open: true } },
        { path: 'zones/village', data: {}, phantom: true },
      ],
    });
    expect(await listed).toEqual([
      { path: 'zones/spawn', phantom: undefined },
      { path: 'zones/village', phantom: true },
    ]);
  });
});

describe("createStudioEnvironment('local') live-plane gating", () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('omits the live plane when no SharedWorker is present', () => {
    restore = removeSharedWorker();
    const env = createStudioEnvironment('local', { persistence: 'memory' });
    expect(env.mode).toBe('local');
    expect(env.live).toBeUndefined();
    // The HTTP-fallback ports are still wired.
    expect(env.projects).toBeDefined();
    expect(env.persistence).toBeDefined();
    env.dispose();
  });

  it('omits the live plane when disableLive is set, even with a SharedWorker', () => {
    restore = shimSharedWorker();
    const env = createStudioEnvironment('local', {
      persistence: 'memory',
      disableLive: true,
    });
    expect(env.live).toBeUndefined();
    env.dispose();
  });

  it('surfaces the live plane when a SharedWorker is available', () => {
    restore = shimSharedWorker();
    const env = createStudioEnvironment('local', { persistence: 'memory' });
    expect(env.live).toBeDefined();
    expect(typeof env.live!.feed.subscribe).toBe('function');
    env.dispose();
  });
});

describe('presence live-plane contract (#227)', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
    resetWorkerLens(undefined);
  });

  it('registers presence and delivers snapshots to subscribePresence', () => {
    const sw = controllableSharedWorker();
    restore = sw.restore;
    const plane = connectWorkerLive('worker://test')!;

    expect(typeof plane.presenceClientId).toBe('string');
    expect(plane.presenceClientId.length).toBeGreaterThan(0);

    // startPresence posts a presence.register op.
    const register = sw.port.sent.find(
      (m): m is { t: 'op'; method: string; clientId: string; kind: string } =>
        (m as { method?: string }).method === 'presence.register',
    );
    expect(register).toBeDefined();
    expect(register!.kind).toBe('studio');
    expect(register!.clientId).toBe(plane.presenceClientId);

    const seen: number[] = [];
    const unsub = plane.subscribePresence((snap) => seen.push(snap.clients.length));

    const subMsg = sw.port.sent.find(
      (m): m is { t: 'sub'; subId: string; target: string } =>
        (m as { t?: string }).t === 'sub' &&
        (m as { target?: string }).target === 'presence',
    );
    expect(subMsg).toBeDefined();

    sw.deliver({
      t: 'snap',
      subId: subMsg!.subId,
      value: {
        clients: [
          {
            clientId: plane.presenceClientId,
            kind: 'studio',
            route: '/',
            visibility: 'visible',
            connectedAt: 1,
            lastSeen: 1,
          },
        ],
      },
    });
    expect(seen).toEqual([1]);

    sw.deliver({
      t: 'snap',
      subId: subMsg!.subId,
      value: {
        clients: [
          {
            clientId: plane.presenceClientId,
            kind: 'studio',
            route: '/',
            visibility: 'visible',
            connectedAt: 1,
            lastSeen: 2,
          },
          {
            clientId: 'app-other',
            kind: 'app',
            route: '/shop',
            visibility: 'hidden',
            connectedAt: 2,
            lastSeen: 2,
          },
        ],
      },
    });
    expect(seen).toEqual([1, 2]);
    unsub();
    plane.dispose();
    expect(sw.port.sent.some(
      (message) => (message as { method?: string }).method === 'presence.disconnect',
    )).toBe(true);
  });
});

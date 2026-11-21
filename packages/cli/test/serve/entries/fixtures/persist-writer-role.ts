/**
 * Two in-page tabs of one project against one fake dev server's state routes,
 * each a realm that evaluated the unmodified page bundle (the runtime keeps
 * its top-level await, which needs Node's module realm). Run with a case name:
 *
 * - `uses-service`: on a project with saved state, tab A reads Firestore and
 *   changes nothing, so it has nothing to save; tab B then signs a user up.
 *   B must be refused and go read-only.
 * - `no-service`: a tab that uses no service never claims the writer role, so
 *   an app tab opened after it saves.
 * - `hidden-writer`: tab A writes and goes hidden past the 60s heartbeat window;
 *   tab B opens, claims the stale lock, and writes; when tab A wakes up and
 *   writes again, its outdated state version is refused with 409 and it drops
 *   to read-only without overwriting tab B's saved buckets (#2051).
 * - `late-service-claim`: tab L opens at version 0 without calling a service;
 *   tab W opens, writes RTDB and Auth, and closes (releasing the lock); when
 *   tab L makes its first service call later, its claim carries version 0, is
 *   refused with 409, and leaves tab W's saved state intact (#2051).
 * - `concurrent-same-tab`: a single writer tab mutates Firestore and Auth
 *   concurrently, advancing the state version sequentially without locking
 *   itself out (#2051).
 */
import assert from 'node:assert/strict';
import { createContext, SourceTextModule } from 'node:vm';
import { build } from 'esbuild';
import {
  createWriterLock,
  parseStateVersionHeader,
  STATE_VERSION_HEADER,
} from '../../../../src/serve/writer-lock.ts';

const entriesDir = new URL('../../../../src/serve/entries/', import.meta.url).pathname;

function fakeStateServer() {
  let now = 1_000;
  let mutationDelayMs = 0;
  let activeMutations = 0;
  let peakConcurrentWrites = 0;
  const lock = createWriterLock(60_000);
  const saved: Array<{ tab: string; section: string; version: number }> = [];
  const sections = new Map<string, string>();
  const respond = (status: number, body: string | null = null, extraHeaders: Record<string, string> = {}) =>
    new Response(body, {
      status,
      headers: {
        [STATE_VERSION_HEADER]: String(lock.version()),
        ...extraHeaders,
      },
    });

  function fetchFor(tab: string) {
    return async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
      const url = new URL(String(input), 'https://app.example/');
      const method = init.method ?? 'GET';
      const headerMap = (init.headers as Record<string, string> | undefined) ?? {};
      const writer = headerMap['x-pyric-writer'] ?? tab;
      const expected = parseStateVersionHeader(headerMap[STATE_VERSION_HEADER]);
      if (url.pathname === '/__pyric/init.json') {
        const savedAccounts = sections.get('auth');
        let authUsers: unknown[] = [];
        if (savedAccounts !== undefined) {
          authUsers = (JSON.parse(savedAccounts) as { users: unknown[] }).users;
        }
        return new Response(
          JSON.stringify({
            persist: true,
            permissive: true,
            sessionToken: 'token',
            stateVersion: lock.version(),
            authUsers,
          }),
          { status: 200 },
        );
      }
      if (url.pathname !== '/__pyric/state') return respond(404);
      const section = url.searchParams.get('section') ?? '';
      if (method === 'GET') {
        if (!section) {
          return respond(200, JSON.stringify({
            firestore: sections.get('firestore') ?? null,
            auth: sections.get('auth') ?? null,
          }));
        }
        const existing = sections.get(section);
        if (existing !== undefined) return respond(200, existing);
        return respond(404, 'null');
      }
      if (method === 'DELETE') {
        lock.release(writer);
        return respond(204);
      }
      activeMutations += 1;
      if (activeMutations > peakConcurrentWrites) {
        peakConcurrentWrites = activeMutations;
      }
      try {
        if (mutationDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, mutationDelayMs));
        }
        if (expected === 'invalid') return respond(400, 'invalid state version');
        if (expected !== undefined && expected !== lock.version()) {
          if (lock.holder() === writer) lock.release(writer);
          return respond(409, `saved state is at version ${lock.version()}, expected ${expected}`);
        }
        if (!lock.claim(writer, now, expected)) return respond(423);
        if (method === 'POST') {
          const nextVersion = lock.advanceVersion();
          saved.push({ tab, section, version: nextVersion });
          sections.set(section, String(init.body));
          return respond(204);
        }
        return respond(204);
      } finally {
        activeMutations -= 1;
      }
    };
  }
  return {
    lock,
    saved,
    sections,
    setMutationDelayMs: (ms: number) => {
      mutationDelayMs = ms;
    },
    maxConcurrentWrites: () => peakConcurrentWrites,
    advanceClock: (ms: number) => {
      now += ms;
    },
    fetchFor,
  };
}

const built = await build({
  stdin: {
    contents: [
      `import './page.ts';`,
      `export * as app from './app.ts';`,
      `export * as auth from './auth.ts';`,
      `export * as database from './database.ts';`,
      `export * as firestore from './firestore.ts';`,
    ].join(' '),
    resolveDir: entriesDir,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  logLevel: 'silent',
});
const firstOutput = built.outputFiles[0];
if (firstOutput === undefined) {
  throw new Error('esbuild produced no output bundle');
}
const bundle = firstOutput.text;

interface PageSdk {
  app: { initializeApp(options: object, name?: string): unknown };
  firestore: {
    getFirestore(app: unknown): unknown;
    doc(db: unknown, path: string): unknown;
    getDoc(ref: unknown): Promise<unknown>;
    setDoc(ref: unknown, data: object): Promise<void>;
  };
  database: {
    getDatabase(app: unknown): unknown;
    ref(db: unknown, path: string): unknown;
    set(ref: unknown, value: unknown): Promise<void>;
  };
  auth: {
    getAuth(app: unknown): unknown;
    createUserWithEmailAndPassword(auth: unknown, email: string, password: string): Promise<unknown>;
  };
}

async function openTab(fetchImpl: ReturnType<ReturnType<typeof fakeStateServer>['fetchFor']>) {
  const intervals: Array<() => void> = [];
  const pageListeners = new Map<string, Array<() => void>>();
  const win = {
    location: new URL('https://app.example/'),
    addEventListener: (type: string, cb: () => void) => {
      const list = pageListeners.get(type) ?? [];
      list.push(cb);
      pageListeners.set(type, list);
    },
    removeEventListener: () => {},
  };
  const context = createContext({
    console: { ...console, info: () => {}, warn: () => {} },
    TextEncoder, TextDecoder, URL, Response, Headers, AbortController, MessageEvent, crypto, performance,
    queueMicrotask, structuredClone,
    location: new URL('https://app.example/'),
    window: win,
    fetch: fetchImpl,
    __PYRIC_FORCE_INPAGE__: true,
    setTimeout, clearTimeout,
    setInterval: (callback: () => void) => intervals.push(callback),
    clearInterval: (id: number) => { intervals[id - 1] = () => {}; },
  }) as Record<string, unknown>;
  const module = new SourceTextModule(bundle, { context });
  await module.link(() => { throw new Error('Module linking failed'); });
  await module.evaluate();
  if (context.__PYRIC_PAGE_BACKEND__ instanceof Promise) {
    await context.__PYRIC_PAGE_BACKEND__;
  }
  return {
    sdk: module.namespace as unknown as PageSdk,
    tick: () => { for (const heartbeat of [...intervals]) heartbeat(); },
    close: () => { for (const handler of pageListeners.get('pagehide') ?? []) handler(); },
    readOnly: () => (context.__pyricServe as { persistReadOnly: boolean }).persistReadOnly,
  };
}

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const FLUSH_MS = 700;

const server = fakeStateServer();
const scenario = process.argv[2];

if (scenario === 'uses-service') {
  const earlier = await openTab(server.fetchFor('earlier'));
  const authEarlier = earlier.sdk.auth.getAuth(earlier.sdk.app.initializeApp({ projectId: 'writer-role' }));
  await earlier.sdk.auth.createUserWithEmailAndPassword(authEarlier, 'earlier@example.com', 'secret-pw');
  await settle(FLUSH_MS);
  earlier.close();
  await settle(50);
  assert.equal(server.lock.holder(), null);

  const tabA = await openTab(server.fetchFor('A'));
  const db = tabA.sdk.firestore.getFirestore(tabA.sdk.app.initializeApp({ projectId: 'writer-role' }));
  await tabA.sdk.firestore.getDoc(tabA.sdk.firestore.doc(db, 'notes/one')).catch(() => null);
  await settle(FLUSH_MS);
  assert.deepEqual(server.saved.filter((entry) => entry.tab === 'A'), [], 'tab A saved state without changing anything');

  const tabB = await openTab(server.fetchFor('B'));
  const authB = tabB.sdk.auth.getAuth(tabB.sdk.app.initializeApp({ projectId: 'writer-role' }));
  await tabB.sdk.auth.createUserWithEmailAndPassword(authB, 'b@example.com', 'secret-pw');
  await settle(FLUSH_MS);
  tabA.tick();
  tabB.tick();
  await settle(50);

  assert.deepEqual(server.saved.filter((entry) => entry.tab === 'B'), [], 'tab B saved state while tab A was open');
  assert.equal(tabB.readOnly(), true, 'tab B did not go read-only');
  assert.equal(tabA.readOnly(), false, 'tab A went read-only');
} else if (scenario === 'no-service') {
  const idle = await openTab(server.fetchFor('idle'));
  await settle(50);
  idle.tick();
  await settle(50);
  assert.equal(server.lock.holder(), null, 'a tab that uses no service claimed the writer role');

  const app = await openTab(server.fetchFor('app'));
  const auth = app.sdk.auth.getAuth(app.sdk.app.initializeApp({ projectId: 'writer-role-idle' }));
  await app.sdk.auth.createUserWithEmailAndPassword(auth, 'app@example.com', 'secret-pw');
  await settle(FLUSH_MS);
  idle.tick();
  app.tick();
  await settle(50);
  assert.equal(app.readOnly(), false, 'the app tab went read-only');
  assert.ok(server.saved.some((entry) => entry.tab === 'app' && entry.section === 'auth'), 'the app tab saved no accounts');
} else if (scenario === 'hidden-writer') {
  const tabA = await openTab(server.fetchFor('A'));
  const appA = tabA.sdk.app.initializeApp({
    projectId: 'hidden-writer',
    databaseURL: 'https://hidden-writer-default-rtdb.firebaseio.com',
  });
  const dbA = tabA.sdk.database.getDatabase(appA);
  await tabA.sdk.database.set(tabA.sdk.database.ref(dbA, 'items/a'), { owner: 'A' });
  await settle(FLUSH_MS);
  assert.equal(tabA.readOnly(), false);

  // Tab A is hidden for 2 minutes; Chrome throttles timers so no heartbeat runs.
  server.advanceClock(120_000);

  // Tab B opens, claims the stale lock at Tab A's saved version, writes, and even closes.
  const tabB = await openTab(server.fetchFor('B'));
  const appB = tabB.sdk.app.initializeApp({
    projectId: 'hidden-writer',
    databaseURL: 'https://hidden-writer-default-rtdb.firebaseio.com',
  });
  const dbB = tabB.sdk.database.getDatabase(appB);
  await tabB.sdk.database.set(tabB.sdk.database.ref(dbB, 'items/b'), { owner: 'B' });
  await settle(FLUSH_MS);
  assert.equal(tabB.readOnly(), false);
  tabB.close();
  await settle(50);

  // User returns to Tab A and writes: Tab A's version is outdated, so it is refused.
  const savedCountBeforeReturn = server.saved.length;
  await tabA.sdk.database.set(tabA.sdk.database.ref(dbA, 'items/a-stale'), { owner: 'A-stale' });
  await settle(FLUSH_MS);

  assert.equal(tabA.readOnly(), true, 'hidden tab A did not drop to read-only after Tab B saved newer state');
  assert.equal(server.saved.length, savedCountBeforeReturn, 'stale tab A overwrote newer state');
  assert.ok((server.sections.get('firestore') ?? '').includes('items/b'), 'Tab B RTDB bucket was overwritten');
} else if (scenario === 'late-service-claim') {
  // Tab L opens before any writes, importing the SDK bundle without calling a service yet.
  const tabL = await openTab(server.fetchFor('L'));
  await settle(50);

  // Tab W opens, writes RTDB and Auth, flushes, and closes (releasing the lock).
  const tabW = await openTab(server.fetchFor('W'));
  const appW = tabW.sdk.app.initializeApp({
    projectId: 'late-claim',
    databaseURL: 'https://late-claim-default-rtdb.firebaseio.com',
  });
  const dbW = tabW.sdk.database.getDatabase(appW);
  const authW = tabW.sdk.auth.getAuth(appW);
  await tabW.sdk.database.set(tabW.sdk.database.ref(dbW, 'items/w'), { owner: 'W' });
  await tabW.sdk.auth.createUserWithEmailAndPassword(authW, 'w@example.com', 'secret-pw');
  await settle(FLUSH_MS);
  tabW.close();
  await settle(50);
  assert.equal(server.lock.holder(), null);

  // Tab L now makes its first service call (e.g. after a login click).
  const savedCountBeforeLate = server.saved.length;
  const appL = tabL.sdk.app.initializeApp({
    projectId: 'late-claim',
    databaseURL: 'https://late-claim-default-rtdb.firebaseio.com',
  });
  const authL = tabL.sdk.auth.getAuth(appL);
  await tabL.sdk.auth.createUserWithEmailAndPassword(authL, 'late@example.com', 'secret-pw');
  await settle(FLUSH_MS);

  assert.equal(tabL.readOnly(), true, 'late-claiming tab L did not drop to read-only');
  assert.equal(server.saved.length, savedCountBeforeLate, 'late-claiming tab L reverted Tab W saved state');
  assert.ok((server.sections.get('firestore') ?? '').includes('items/w'), 'Tab W RTDB state was lost');
  assert.ok((server.sections.get('auth') ?? '').includes('w@example.com'), 'Tab W auth state was lost');
} else if (scenario === 'concurrent-same-tab') {
  server.setMutationDelayMs(20);
  const tab = await openTab(server.fetchFor('single'));
  const app = tab.sdk.app.initializeApp({
    projectId: 'single-tab',
    databaseURL: 'https://single-tab-default-rtdb.firebaseio.com',
  });
  const db = tab.sdk.database.getDatabase(app);
  const auth = tab.sdk.auth.getAuth(app);
  // Queue >= 4 overlapping state requests while the initial PUT claim is still in flight.
  await Promise.all([
    tab.sdk.database.set(tab.sdk.database.ref(db, 'notes/one'), 'first'),
    tab.sdk.auth.createUserWithEmailAndPassword(auth, 'single@example.com', 'secret-pw'),
    (async () => {
      await settle(5);
      await tab.sdk.database.set(tab.sdk.database.ref(db, 'notes/two'), 'second');
    })(),
    (async () => {
      await settle(15);
      await tab.sdk.database.set(tab.sdk.database.ref(db, 'notes/three'), 'third');
    })(),
  ]);
  await settle(FLUSH_MS);
  await tab.sdk.database.set(tab.sdk.database.ref(db, 'notes/four'), 'fourth');
  await settle(FLUSH_MS);

  assert.equal(server.maxConcurrentWrites(), 1, 'outbound state requests overlapped on the same tab');
  assert.equal(tab.readOnly(), false, 'single writer tab locked itself out on queued state flushes');
  assert.ok((server.sections.get('firestore') ?? '').includes('notes/four'), 'firestore flush missing');
  assert.ok((server.sections.get('auth') ?? '').includes('single@example.com'), 'auth flush missing');
} else {
  throw new Error(`unknown case: ${scenario}`);
}
process.exit(0);

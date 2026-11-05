/**
 * Two in-page tabs of one project against one fake dev server's state routes,
 * each a realm that evaluated the unmodified page bundle (the runtime keeps
 * its top-level await, which needs Node's module realm). Run with a case name:
 *
 * - `uses-service`: on a project with saved state, tab A reads Firestore and
 *   changes nothing, so it has nothing to save; tab B then signs a user up. B must be refused and go read-only, so it saves nothing that A's
 *   later saves (A's load-time RTDB, Storage and auth history) would revert.
 * - `no-service`: a tab that uses no service never claims the writer role, so
 *   an app tab opened after it saves.
 */
import assert from 'node:assert/strict';
import { createContext, SourceTextModule } from 'node:vm';
import { build } from 'esbuild';
import { createWriterLock } from '../../../../src/serve/writer-lock.ts';

const entriesDir = new URL('../../../../src/serve/entries/', import.meta.url).pathname;

/** The state routes of one dev server: the writer lock, and the sections each tab saved. */
function fakeStateServer() {
  const lock = createWriterLock();
  const saved: Array<{ tab: string; section: string }> = [];
  const sections = new Map<string, string>();
  const respond = (status: number, body: string | null = null) => new Response(body, { status });
  function fetchFor(tab: string) {
    return async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
      const url = new URL(String(input), 'https://app.example/');
      const method = init.method ?? 'GET';
      const writer = (init.headers as Record<string, string> | undefined)?.['x-pyric-writer'] ?? tab;
      if (url.pathname === '/__pyric/init.json') {
        // The dev server hands saved accounts back through init.json.
        const savedAccounts = sections.get('auth');
        const authUsers = savedAccounts === undefined ? [] : (JSON.parse(savedAccounts) as { users: unknown[] }).users;
        return new Response(JSON.stringify({ persist: true, sessionToken: 'token', authUsers }), { status: 200 });
      }
      if (url.pathname !== '/__pyric/state') return respond(404);
      const section = url.searchParams.get('section') ?? '';
      if (method === 'GET') return sections.has(section) ? respond(200, sections.get(section)!) : respond(404, 'null');
      if (method === 'DELETE') {
        lock.release(writer);
        return respond(204);
      }
      if (!lock.claim(writer, Date.now())) return respond(423);
      if (method === 'POST') {
        saved.push({ tab, section });
        sections.set(section, String(init.body));
      }
      return respond(204);
    };
  }
  return { lock, saved, fetchFor };
}

const bundle = (await build({
  stdin: {
    contents: `export * as app from './app.ts'; export * as auth from './auth.ts'; export * as firestore from './firestore.ts';`,
    resolveDir: entriesDir,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  logLevel: 'silent',
})).outputFiles[0]!.text;

interface PageSdk {
  app: { initializeApp(options: object, name?: string): unknown };
  firestore: {
    getFirestore(app: unknown): unknown;
    doc(db: unknown, path: string): unknown;
    getDoc(ref: unknown): Promise<unknown>;
  };
  auth: {
    getAuth(app: unknown): unknown;
    createUserWithEmailAndPassword(auth: unknown, email: string, password: string): Promise<unknown>;
  };
}

/** One tab: a realm that evaluated the page bundle, with its heartbeats run by `tick`. */
async function openTab(fetch: ReturnType<ReturnType<typeof fakeStateServer>['fetchFor']>) {
  const intervals: Array<() => void> = [];
  const context = createContext({
    console: { ...console, info: () => {}, warn: () => {} },
    TextEncoder, TextDecoder, URL, Response, AbortController, MessageEvent, crypto, performance,
    queueMicrotask, structuredClone,
    location: new URL('https://app.example/'),
    fetch,
    __PYRIC_FORCE_INPAGE__: true,
    setTimeout, clearTimeout,
    setInterval: (callback: () => void) => intervals.push(callback),
    clearInterval: (id: number) => { intervals[id - 1] = () => {}; },
  }) as Record<string, unknown>;
  const module = new SourceTextModule(bundle, { context });
  await module.link(() => { throw new Error('Module linking failed'); });
  await module.evaluate();
  return {
    sdk: module.namespace as unknown as PageSdk,
    /** Twenty seconds pass: every heartbeat fires once. */
    tick: () => { for (const heartbeat of [...intervals]) heartbeat(); },
    readOnly: () => (context.__pyricServe as { persistReadOnly: boolean }).persistReadOnly,
  };
}

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
/** Longer than the runtime's 500 ms auth flush debounce. */
const AUTH_FLUSH_MS = 700;

const server = fakeStateServer();
const scenario = process.argv[2];
if (scenario === 'uses-service') {
  // An earlier session saved state and closed, so the tabs below load it and
  // have nothing to save until they change something.
  const earlier = await openTab(server.fetchFor('earlier'));
  const authEarlier = earlier.sdk.auth.getAuth(earlier.sdk.app.initializeApp({ projectId: 'writer-role' }));
  await earlier.sdk.auth.createUserWithEmailAndPassword(authEarlier, 'earlier@example.com', 'secret-pw');
  await settle(AUTH_FLUSH_MS);
  server.lock.release(server.lock.holder() ?? '');
  assert.equal(server.lock.holder(), null);

  // Tab A reads Firestore and changes nothing, so it has nothing to save.
  const tabA = await openTab(server.fetchFor('A'));
  const db = tabA.sdk.firestore.getFirestore(tabA.sdk.app.initializeApp({ projectId: 'writer-role' }));
  // The project has no rules, so the read may be denied; either way it changes nothing.
  await tabA.sdk.firestore.getDoc(tabA.sdk.firestore.doc(db, 'notes/one')).catch(() => null);
  await settle(AUTH_FLUSH_MS);
  assert.deepEqual(server.saved.filter((entry) => entry.tab === 'A'), [], 'tab A saved state without changing anything');

  const tabB = await openTab(server.fetchFor('B'));
  const authB = tabB.sdk.auth.getAuth(tabB.sdk.app.initializeApp({ projectId: 'writer-role' }));
  await tabB.sdk.auth.createUserWithEmailAndPassword(authB, 'b@example.com', 'secret-pw');
  await settle(AUTH_FLUSH_MS);
  tabA.tick();
  tabB.tick();
  await settle();

  assert.deepEqual(server.saved.filter((entry) => entry.tab === 'B'), [], 'tab B saved state while tab A, which uses a service, was open');
  assert.equal(tabB.readOnly(), true, 'tab B did not go read-only');
  assert.equal(tabA.readOnly(), false, 'tab A went read-only');
} else if (scenario === 'no-service') {
  const idle = await openTab(server.fetchFor('idle'));
  await settle();
  idle.tick();
  await settle();
  assert.equal(server.lock.holder(), null, 'a tab that uses no service claimed the writer role');

  const app = await openTab(server.fetchFor('app'));
  const auth = app.sdk.auth.getAuth(app.sdk.app.initializeApp({ projectId: 'writer-role-idle' }));
  await app.sdk.auth.createUserWithEmailAndPassword(auth, 'app@example.com', 'secret-pw');
  await settle(AUTH_FLUSH_MS);
  idle.tick();
  app.tick();
  await settle();
  assert.equal(app.readOnly(), false, 'the app tab went read-only');
  assert.ok(server.saved.some((entry) => entry.tab === 'app' && entry.section === 'auth'), 'the app tab saved no accounts');
} else {
  throw new Error(`unknown case: ${scenario}`);
}
process.exit(0);

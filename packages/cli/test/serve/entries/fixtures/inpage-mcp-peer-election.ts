/**
 * Browser VM-realm runner for in-page MCP bridge peer election (#2053, #2051).
 *
 * Evaluates the unmodified `entries/page.ts` + SDK bundles inside isolated
 * `node:vm` `SourceTextModule` realms (required for top-level await) against a
 * live `startServe` origin started by `inpage-mcp-peer-election.test.ts`.
 */
import assert from 'node:assert/strict';
import { createContext, runInContext, SourceTextModule } from 'node:vm';
import { build } from 'esbuild';

const entriesDir = new URL('../../../../src/serve/entries/', import.meta.url).pathname;

const appBuilt = await build({
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
const appFirst = appBuilt.outputFiles[0];
if (appFirst === undefined) throw new Error('esbuild produced no app bundle');
const appBundle = appFirst.text;

const blankBuilt = await build({
  stdin: {
    contents: `import './page.ts'; export const blank = true;`,
    resolveDir: entriesDir,
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  logLevel: 'silent',
});
const blankFirst = blankBuilt.outputFiles[0];
if (blankFirst === undefined) throw new Error('esbuild produced no blank bundle');
const noFirebaseBundle = blankFirst.text;

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  label: string,
  check: () => Promise<boolean> | boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await settle(50);
  }
}

interface RealmDiagnostics {
  bridgeConnected: boolean;
  persistReadOnly: boolean;
}

interface PageSdk {
  app: { initializeApp(options: object, name?: string): unknown };
  firestore: {
    getFirestore(app: unknown): unknown;
    doc(db: unknown, path: string): unknown;
    setDoc(ref: unknown, data: object): Promise<void>;
    onSnapshot(ref: unknown, cb: (snap: { exists(): boolean; data(): unknown }) => void): () => void;
  };
  database: {
    getDatabase(app: unknown): unknown;
    ref(db: unknown, path: string): unknown;
    set(ref: unknown, value: unknown): Promise<void>;
  };
}

async function openRealm(baseUrl: string, code: string) {
  const intervals: Array<() => void> = [];
  const listeners = new Map<string, Array<() => void>>();
  const win = {
    location: new URL(baseUrl),
    addEventListener: (type: string, cb: () => void) => {
      const list = listeners.get(type) ?? [];
      list.push(cb);
      listeners.set(type, list);
    },
    removeEventListener: () => {},
  };
  const context = createContext({
    console: { ...console, info: () => {}, warn: () => {} },
    TextEncoder, TextDecoder, URL, Response, Headers, Request, AbortController,
    MessageEvent, WebSocket, crypto, performance,
    queueMicrotask, structuredClone,
    location: new URL(baseUrl),
    window: win,
    fetch: (input: string | URL | Request, init?: RequestInit) => {
      let resolved: string | URL | Request = input;
      if (typeof input === 'string' || input instanceof URL) {
        resolved = new URL(String(input), baseUrl);
      }
      return fetch(resolved, init);
    },
    __PYRIC_FORCE_INPAGE__: true,
    setTimeout, clearTimeout,
    setInterval: (cb: () => void) => intervals.push(cb),
    clearInterval: (id: number) => { intervals[id - 1] = () => {}; },
  }) as Record<string, unknown>;
  const mod = new SourceTextModule(code, { context });
  await mod.link(() => { throw new Error('Module link failed'); });
  await mod.evaluate();
  if (context.__PYRIC_PAGE_BACKEND__ instanceof Promise) {
    await context.__PYRIC_PAGE_BACKEND__;
  }
  return {
    sdk: mod.namespace as unknown as PageSdk,
    plainObject: <T extends object>(value: T): T =>
      runInContext(`(${JSON.stringify(value)})`, context) as T,
    diagnostics: () => context.__pyricServe as RealmDiagnostics,
    closePage: () => {
      for (const cb of listeners.get('pagehide') ?? []) cb();
    },
  };
}

async function callMcpTool(
  baseUrl: string,
  sessionToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const baseHeaders: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-pyric-session-token': sessionToken,
  };
  const initRes = await fetch(`${baseUrl}/__pyric/mcp`, {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'inpage-peer-test', version: '1.0' },
      },
    }),
  });
  const mcpId = initRes.headers.get('mcp-session-id');
  const callHeaders: Record<string, string> = { ...baseHeaders };
  if (mcpId !== null) callHeaders['mcp-session-id'] = mcpId;
  const res = await fetch(`${baseUrl}/__pyric/mcp`, {
    method: 'POST',
    headers: callHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  return res.text();
}

const scenario = process.argv[2];
const baseUrl = process.argv[3];
const sessionToken = process.argv[4] ?? '';
if (!scenario || !baseUrl) {
  throw new Error('Usage: inpage-mcp-peer-election.ts <scenario> <baseUrl> <sessionToken>');
}

if (scenario === 'persist-app-then-blank-and-readonly') {
  const appTab = await openRealm(baseUrl, appBundle);
  const fbApp = appTab.sdk.app.initializeApp(appTab.plainObject({ projectId: 'peer-persist' }));
  const fsDb = appTab.sdk.firestore.getFirestore(fbApp);
  let seenInAppTab: unknown = null;
  appTab.sdk.firestore.onSnapshot(appTab.sdk.firestore.doc(fsDb, 'notes/from-agent'), (snap) => {
    seenInAppTab = snap.exists() ? snap.data() : null;
  });
  await waitFor('appTab bridgeConnected', () => appTab.diagnostics().bridgeConnected);
  await waitFor('server sandboxConnected', async () => {
    const health = (await (await fetch(`${baseUrl}/__pyric/health`)).json()) as { sandboxConnected?: boolean };
    return health.sandboxConnected === true;
  });

  // 1. Open a page without Firebase after the app tab.
  const blankTab = await openRealm(baseUrl, noFirebaseBundle);
  // 2. Open a second Firebase tab, which gets 423 on writer claim and goes read-only.
  const readOnlyTab = await openRealm(baseUrl, appBundle);
  const roApp = readOnlyTab.sdk.app.initializeApp(readOnlyTab.plainObject({ projectId: 'peer-persist' }));
  readOnlyTab.sdk.firestore.getFirestore(roApp);
  await waitFor('readOnlyTab persistReadOnly', () => readOnlyTab.diagnostics().persistReadOnly);
  await settle(200);

  assert.equal(blankTab.diagnostics().bridgeConnected, false, 'non-Firebase page registered with MCP bridge');
  assert.equal(readOnlyTab.diagnostics().bridgeConnected, false, 'read-only tab registered with MCP bridge');
  assert.equal(appTab.diagnostics().bridgeConnected, true, 'writer app tab disconnected from MCP bridge');

  const docOut = await callMcpTool(baseUrl, sessionToken, 'firestore_create_document', {
    path: 'notes/from-agent',
    data: { text: 'written-by-mcp' },
  });
  const userOut = await callMcpTool(baseUrl, sessionToken, 'auth_create_user', {
    email: 'mcp-agent@example.com',
    password: 'secret-password',
  });
  assert.ok(!docOut.includes('"isError":true'), `MCP doc write failed: ${docOut}`);
  assert.ok(!userOut.includes('"isError":true'), `MCP user write failed: ${userOut}`);

  await waitFor('appTab sees MCP write', () => seenInAppTab !== null);
  assert.equal(JSON.stringify(seenInAppTab), JSON.stringify({ text: 'written-by-mcp' }));

  await waitFor('saved state contains MCP writes', async () => {
    const res = await fetch(`${baseUrl}/__pyric/state`, {
      headers: { 'x-pyric-session-token': sessionToken },
    });
    if (res.status !== 200) return false;
    const text = await res.text();
    return text.includes('written-by-mcp') && text.includes('mcp-agent@example.com');
  });

  readOnlyTab.closePage();
  blankTab.closePage();
  appTab.closePage();
} else if (scenario === 'ephemeral-app-then-blank') {
  const appTab = await openRealm(baseUrl, appBundle);
  const fbApp = appTab.sdk.app.initializeApp(appTab.plainObject({ projectId: 'peer-ephemeral' }));
  const fsDb = appTab.sdk.firestore.getFirestore(fbApp);
  let seenInAppTab: unknown = null;
  appTab.sdk.firestore.onSnapshot(appTab.sdk.firestore.doc(fsDb, 'notes/ephemeral'), (snap) => {
    seenInAppTab = snap.exists() ? snap.data() : null;
  });
  await waitFor('ephemeral appTab bridgeConnected', () => appTab.diagnostics().bridgeConnected);

  const blankTab = await openRealm(baseUrl, noFirebaseBundle);
  await settle(250);
  assert.equal(blankTab.diagnostics().bridgeConnected, false, 'non-Firebase page connected in ephemeral mode');

  const docOut = await callMcpTool(baseUrl, sessionToken, 'firestore_create_document', {
    path: 'notes/ephemeral',
    data: { text: 'ephemeral-mcp' },
  });
  assert.ok(!docOut.includes('"isError":true'), `MCP doc write failed: ${docOut}`);
  await waitFor('ephemeral appTab sees MCP write', () => seenInAppTab !== null);
  assert.equal(JSON.stringify(seenInAppTab), JSON.stringify({ text: 'ephemeral-mcp' }));

  blankTab.closePage();
  appTab.closePage();
} else if (scenario === 'writer-demotion-disconnects-bridge') {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { startServe } = await import('../../../../dist/cli/serve.js');
  const { silentServeLogger } = await import('../../../../dist/serve/server.js');
  const dir = mkdtempSync(join(tmpdir(), 'pyric-2053-demote-'));
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify({ hosting: { public: 'public' } }));
  mkdirSync(join(dir, 'public'));
  writeFileSync(join(dir, 'public', 'index.html'), '<!doctype html><html><body></body></html>');
  const realDateNow = Date.now;
  let fakeNow = realDateNow();
  Date.now = () => fakeNow;
  const srv = await startServe({
    cwd: dir,
    port: 0,
    host: '127.0.0.1',
    cacheRoot: join(dir, '.cache'),
    persist: true,
    bridge: true,
    permissive: true,
    disableAuditLog: true,
    logger: silentServeLogger(),
  });
  try {
    const localUrl = srv.handle.url;
    const localToken = srv.sessionToken;
    const tabA = await openRealm(localUrl, appBundle);
    const appA = tabA.sdk.app.initializeApp(tabA.plainObject({
      projectId: 'peer-demote',
      databaseURL: 'https://peer-demote-default-rtdb.firebaseio.com',
    }));
    const dbA = tabA.sdk.database.getDatabase(appA);
    await tabA.sdk.database.set(tabA.sdk.database.ref(dbA, 'items/a'), 'A');
    await waitFor('tabA bridgeConnected', () => tabA.diagnostics().bridgeConnected);
    await settle(700);

    // Advance clock past the 60s writer-lock window while Tab A is hidden.
    fakeNow += 65_000;

    // Tab B opens, takes over writer role + MCP bridge peer, and saves newer state.
    const tabB = await openRealm(localUrl, appBundle);
    const appB = tabB.sdk.app.initializeApp(tabB.plainObject({
      projectId: 'peer-demote',
      databaseURL: 'https://peer-demote-default-rtdb.firebaseio.com',
    }));
    const fsB = tabB.sdk.firestore.getFirestore(appB);
    let seenInTabB: unknown = null;
    tabB.sdk.firestore.onSnapshot(tabB.sdk.firestore.doc(fsB, 'notes/after-handoff'), (snap) => {
      seenInTabB = snap.exists() ? snap.data() : null;
    });
    await tabB.sdk.firestore.setDoc(
      tabB.sdk.firestore.doc(fsB, 'notes/from-b'),
      tabB.plainObject({ text: 'B' }),
    );
    await waitFor('tabB bridgeConnected', () => tabB.diagnostics().bridgeConnected);
    await settle(700);

    // Tab A wakes up and attempts a write: gets 409, drops read-only, and disconnects its bridge peer.
    await tabA.sdk.database.set(tabA.sdk.database.ref(dbA, 'items/a-stale'), 'A-stale');
    await waitFor('tabA demoted read-only', () => tabA.diagnostics().persistReadOnly);
    assert.equal(tabA.diagnostics().bridgeConnected, false, 'demoted tabA stayed connected to bridge');

    const docOut = await callMcpTool(localUrl, localToken, 'firestore_create_document', {
      path: 'notes/after-handoff',
      data: { text: 'routed-to-tab-b' },
    });
    assert.ok(!docOut.includes('"isError":true'), `MCP write after handoff failed: ${docOut}`);
    await waitFor('tabB sees MCP write', () => seenInTabB !== null);
    assert.equal(JSON.stringify(seenInTabB), JSON.stringify({ text: 'routed-to-tab-b' }));

    tabB.closePage();
    tabA.closePage();
  } finally {
    Date.now = realDateNow;
    await Promise.race([srv.handle.stop(), settle(2_000)]);
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  throw new Error(`unknown scenario: ${scenario}`);
}
process.exit(0);

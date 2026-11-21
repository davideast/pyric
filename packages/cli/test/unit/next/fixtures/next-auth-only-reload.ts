/**
 * VM-realm browser harness for a Next.js auth-only client page (#2046).
 *
 * Bundles an app module that imports only `firebase/app` and `firebase/auth`
 * mapped through `getClientAliases('sandbox')` with `NEXT_PUBLIC_PYRIC_WORKER_INIT`
 * defined and NO injected `entries/page.ts` script, matching `withPyric` under
 * Webpack and Turbopack.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createContext, SourceTextModule } from 'node:vm';
import { build } from 'esbuild';
import { getClientAliases } from '../../../../dist/next/client-aliases.js';

const cliDir = new URL('../../../../', import.meta.url).pathname;
const req = createRequire(join(cliDir, 'package.json'));
const { JSDOM } = req('jsdom') as typeof import('jsdom');

const baseUrl = process.argv[2];
const sessionToken = process.argv[3] ?? '';
const workerInitJson = process.argv[4] ?? '{}';
if (!baseUrl) {
  throw new Error('Usage: next-auth-only-reload.ts <baseUrl> <sessionToken> <workerInitJson>');
}

const aliases = getClientAliases('sandbox');
const built = await build({
  stdin: {
    contents: [
      `import { initializeApp } from 'firebase/app';`,
      `import {`,
      `  getAuth,`,
      `  createUserWithEmailAndPassword,`,
      `  onAuthStateChanged,`,
      `  signOut,`,
      `  signInWithEmailAndPassword,`,
      `} from 'firebase/auth';`,
      `export {`,
      `  initializeApp,`,
      `  getAuth,`,
      `  createUserWithEmailAndPassword,`,
      `  onAuthStateChanged,`,
      `  signOut,`,
      `  signInWithEmailAndPassword,`,
      `};`,
    ].join('\n'),
    resolveDir: cliDir,
  },
  alias: aliases,
  define: {
    'process.env.NEXT_PUBLIC_PYRIC_WORKER_INIT': JSON.stringify(workerInitJson),
  },
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'browser',
  logLevel: 'silent',
});
const firstOut = built.outputFiles[0];
if (firstOut === undefined) throw new Error('esbuild produced no bundle');
const clientBundle = firstOut.text;

const sharedLocalStorage = new Map<string, string>();
function createStorage(backing: Map<string, string>) {
  return {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => { backing.set(key, String(value)); },
    removeItem: (key: string) => { backing.delete(key); },
    clear: () => { backing.clear(); },
  };
}

interface NextAuthSdk {
  initializeApp(options: object): unknown;
  getAuth(app: unknown): unknown;
  createUserWithEmailAndPassword(
    auth: unknown,
    email: string,
    password: string,
  ): Promise<{ user: { uid: string } }>;
  onAuthStateChanged(
    auth: unknown,
    cb: (user: { uid: string } | null) => void,
  ): () => void;
  signOut(auth: unknown): Promise<void>;
  signInWithEmailAndPassword(
    auth: unknown,
    email: string,
    password: string,
  ): Promise<{ user: { uid: string } }>;
}

async function openNextClientPage() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: baseUrl,
  });
  const ls = createStorage(sharedLocalStorage);
  const ss = createStorage(new Map<string, string>());
  const intervals: Array<() => void> = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit) => {
    let resolved: string | URL | Request = input;
    if (typeof input === 'string' || input instanceof URL) {
      resolved = new URL(String(input), baseUrl);
    }
    return fetch(resolved, init);
  };
  Object.defineProperty(dom.window, 'localStorage', { value: ls, configurable: true });
  Object.defineProperty(dom.window, 'sessionStorage', { value: ss, configurable: true });
  Object.defineProperty(dom.window, 'fetch', { value: fetchImpl, configurable: true });

  const context = createContext({
    console: { ...console, info: () => {}, warn: () => {} },
    TextEncoder, TextDecoder, URL, Response, Headers, Request, AbortController,
    MessageEvent, CustomEvent: dom.window.CustomEvent, HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    crypto, performance, queueMicrotask, structuredClone,
    window: dom.window,
    document: dom.window.document,
    location: new URL(baseUrl),
    localStorage: ls,
    sessionStorage: ss,
    fetch: fetchImpl,
    __PYRIC_FORCE_INPAGE__: true,
    setTimeout, clearTimeout,
    setInterval: (cb: () => void) => intervals.push(cb),
    clearInterval: (id: number) => { intervals[id - 1] = () => {}; },
  }) as Record<string, unknown>;

  const mod = new SourceTextModule(clientBundle, { context });
  await mod.link(() => { throw new Error('Module link failed'); });
  await mod.evaluate();
  return {
    sdk: mod.namespace as unknown as NextAuthSdk,
    close: () => {
      dom.window.dispatchEvent(new dom.window.Event('pagehide'));
      dom.window.close();
    },
  };
}

const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

// 1. First load: sign up user on auth-only Next.js client page.
const page1 = await openNextClientPage();
const app1 = page1.sdk.initializeApp({ projectId: 'next-auth-only' });
const auth1 = page1.sdk.getAuth(app1);
const cred = await page1.sdk.createUserWithEmailAndPassword(auth1, 'next-user@example.com', 'secret-pw');
const uid = cred.user.uid;

// Wait for debounced auth flush (500ms) + session flush to hit `/__pyric/state`.
const deadline = Date.now() + 10_000;
for (;;) {
  const authRes = await fetch(`${baseUrl}/__pyric/state?section=auth`, {
    headers: { 'x-pyric-session-token': sessionToken },
  });
  if (authRes.status === 200) break;
  if (Date.now() > deadline) throw new Error('Timed out waiting for Next.js auth section save');
  await settle(100);
}
page1.close();
await settle(100);

// 2. Reload: open a fresh page realm sharing localStorage; session + account survive.
const page2 = await openNextClientPage();
const app2 = page2.sdk.initializeApp({ projectId: 'next-auth-only' });
const auth2 = page2.sdk.getAuth(app2);
const restoredUid = await new Promise<string | null>((resolve) => {
  const unsub = page2.sdk.onAuthStateChanged(auth2, (user) => {
    unsub();
    resolve(user ? user.uid : null);
  });
});
assert.equal(restoredUid, uid, 'Reloaded Next.js auth-only page lost the signed-in user');

// 3. Sign out and sign back in with the saved password.
await page2.sdk.signOut(auth2);
const relogin = await page2.sdk.signInWithEmailAndPassword(auth2, 'next-user@example.com', 'secret-pw');
assert.equal(relogin.user.uid, uid, 'Sign-in after reload returned a different uid');
page2.close();
process.exit(0);

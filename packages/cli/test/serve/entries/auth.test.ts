import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('firebase/auth entry dependency boundary', () => {
  it('registers handles through the active-auth coordinator', () => {
    const source = readFileSync(
      join(import.meta.dir, '../../../src/serve/entries/auth.ts'),
      'utf8',
    );

    expect(source).toContain("from './active-auth.js'");
  });

  it('has no top-level await in its module graph and excludes runtime.js', async () => {
    const esbuild = await import('esbuild');
    const authEntry = join(import.meta.dir, '../../../src/serve/entries/auth.ts');

    const result = await esbuild.build({
      entryPoints: [authEntry],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      external: ['pyric', 'pyric/*'],
      supported: { 'top-level-await': false },
      metafile: true,
    });

    expect(result.outputFiles.length).toBeGreaterThan(0);
    const runtimeInputs = Object.keys(result.metafile.inputs).filter(
      (path) => path.includes('entries/runtime.ts') || path.includes('entries/runtime.js'),
    );
    expect(runtimeInputs).toEqual([]);
  });

  it('evaluates cleanly in a Service Worker realm without DOM or top-level await errors', async () => {
    const { createContext, SourceTextModule } = await import('node:vm');
    const esbuild = await import('esbuild');
    const authEntry = join(import.meta.dir, '../../../src/serve/entries/auth.ts');
    const appEntry = join(import.meta.dir, '../../../src/serve/entries/app.ts');

    const bundle = await esbuild.build({
      stdin: {
        contents: `
          export * as app from '${appEntry}';
          export * as auth from '${authEntry}';
        `,
        resolveDir: join(import.meta.dir, '../../../src/serve/entries'),
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      supported: { 'top-level-await': false },
    });

    const globals = {
      console,
      TextEncoder,
      TextDecoder,
      URL,
      AbortController,
      MessageEvent,
      crypto,
      performance,
      queueMicrotask,
      location: new URL('https://app.example/sw.js'),
      ServiceWorkerGlobalScope: class {},
      registration: { scope: '/' },
      clients: {},
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    };
    const context = createContext(globals);
    const module = new SourceTextModule(bundle.outputFiles[0]!.text, { context });
    await module.link(() => { throw new Error('Module linking failed'); });
    await module.evaluate();

    const exports = module.namespace as {
      app: typeof import('../../../src/serve/entries/app.js');
      auth: typeof import('../../../src/serve/entries/auth.js');
    };

    expect(typeof exports.auth.getAuth).toBe('function');
    expect(typeof exports.auth.onAuthStateChanged).toBe('function');

    const appInstance = exports.app.initializeApp({ projectId: 'sw-test-project' }, 'sw-app');
    const authHandle = exports.auth.getAuth(appInstance);
    expect(authHandle).toBeDefined();
    expect(authHandle.app).toBe(appInstance);
  });

  it('supports in-page authentication operations', async () => {
    const { createContext, SourceTextModule } = await import('node:vm');
    const esbuild = await import('esbuild');
    const authEntry = join(import.meta.dir, '../../../src/serve/entries/auth.ts');
    const appEntry = join(import.meta.dir, '../../../src/serve/entries/app.ts');

    const bundle = await esbuild.build({
      stdin: {
        contents: `
          export * as app from '${appEntry}';
          export * as auth from '${authEntry}';
        `,
        resolveDir: join(import.meta.dir, '../../../src/serve/entries'),
      },
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      supported: { 'top-level-await': false },
    });

    const timers = new Set<ReturnType<typeof setTimeout>>();
    try {
      const globals = {
        console,
        TextEncoder,
        TextDecoder,
        URL,
        AbortController,
        MessageEvent,
        crypto,
        performance,
        queueMicrotask,
        structuredClone,
        location: new URL('https://app.example/'),
        __PYRIC_FORCE_INPAGE__: true,
        setTimeout: (cb: () => void, ms: number) => {
          const t = setTimeout(cb, ms);
          timers.add(t);
          return t;
        },
        clearTimeout: (t: ReturnType<typeof setTimeout>) => {
          timers.delete(t);
          clearTimeout(t);
        },
        setInterval,
        clearInterval,
      };
      const context = createContext(globals);
      const module = new SourceTextModule(bundle.outputFiles[0]!.text, { context });
      await module.link(() => { throw new Error('Module linking failed'); });
      await module.evaluate();

      const exports = module.namespace as {
        app: typeof import('../../../src/serve/entries/app.js');
        auth: typeof import('../../../src/serve/entries/auth.js');
      };

      const appInstance = exports.app.initializeApp({ projectId: 'inpage-auth-test' }, 'inpage-auth-test');
      const authHandle = exports.auth.getAuth(appInstance);

      let observedUser: { email?: string | null } | null = null;
      let notifications = 0;
      const unsubscribe = exports.auth.onAuthStateChanged(authHandle, (user) => {
        observedUser = user as { email?: string | null } | null;
        notifications++;
      });

      const userCred = await exports.auth.createUserWithEmailAndPassword(
        authHandle,
        'user@example.com',
        'password123',
      );
      expect(userCred.user.email).toBe('user@example.com');
      expect(userCred.user.uid).toBeDefined();

      await exports.auth.signOut(authHandle);
      expect(observedUser).toBeNull();
      expect(notifications).toBeGreaterThanOrEqual(2);

      const anonCred = await exports.auth.signInAnonymously(authHandle);
      expect(anonCred.user.isAnonymous).toBe(true);

      unsubscribe();
      await exports.auth.signOut(authHandle);
    } finally {
      for (const t of timers) clearTimeout(t);
    }
  });

  it('mounts the auth helper dialog and runtime chip in window/DOM environments', async () => {
    const { createContext, SourceTextModule } = await import('node:vm');
    const { JSDOM } = await import('jsdom');
    const esbuild = await import('esbuild');
    const initEntry = join(import.meta.dir, '../../../src/serve/entries/init.ts');

    const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
      url: 'http://localhost:3000',
    });

    const bundle = await esbuild.build({
      entryPoints: [initEntry],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
    });

    const timers = new Set<ReturnType<typeof setTimeout>>();
    try {
      const context = createContext({
        console,
        TextEncoder,
        TextDecoder,
        URL,
        AbortController,
        MessageEvent,
        crypto,
        performance,
        queueMicrotask,
        location: dom.window.location,
        window: dom.window,
        document: dom.window.document,
        HTMLElement: dom.window.HTMLElement,
        CustomEvent: dom.window.CustomEvent,
        MutationObserver: dom.window.MutationObserver,
        localStorage: dom.window.localStorage,
        fetch: () => Promise.resolve(new Response(JSON.stringify({}))),
        __PYRIC_WORKER_INIT__: null,
        __PYRIC_FORCE_INPAGE__: true,
        setTimeout: (cb: () => void, ms: number) => {
          const t = setTimeout(cb, ms);
          timers.add(t);
          return t;
        },
        clearTimeout: (t: ReturnType<typeof setTimeout>) => {
          timers.delete(t);
          clearTimeout(t);
        },
        setInterval,
        clearInterval,
      });

      const module = new SourceTextModule(bundle.outputFiles[0]!.text, { context });
      await module.link(() => { throw new Error('Module linking failed'); });
      await module.evaluate();

      const dialog = dom.window.document.querySelector('dialog');
      expect(dialog).not.toBeNull();
      expect(dom.window.document.body.children.length).toBeGreaterThan(0);
    } finally {
      for (const t of timers) clearTimeout(t);
      dom.window.close();
    }
  });
});

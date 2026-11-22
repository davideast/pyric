import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deleteApp, getApps } from '../../src/app/index.js';
import { createAppForSandbox, resetAppRegistryForTests } from '../../src/app/internal.js';
import type { FirebaseApp } from '../../src/app/types.js';
import {
  CustomProvider,
  getToken,
  initializeAppCheck,
  onTokenChanged,
  type AppCheckTokenResult,
} from '../../src/app-check/index.js';
import { initializeSandbox } from '../../src/sandbox/index.js';

const APP_ID = '1:123456789012:web:0a1b2c3d4e5f60718293a4';
const OPTIONS = { apiKey: 'demo-key', projectId: 'demo-app-check-observers', appId: APP_ID };

const apps: FirebaseApp[] = [];
const sandboxes: Array<ReturnType<typeof initializeSandbox>> = [];
let appSeq = 0;

function freshApp(label: string, sandbox = initializeSandbox()): {
  app: FirebaseApp;
  sandbox: ReturnType<typeof initializeSandbox>;
} {
  appSeq += 1;
  sandboxes.push(sandbox);
  const app = createAppForSandbox(sandbox, OPTIONS, `${label}-${appSeq}`);
  apps.push(app);
  return { app, sandbox };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolveDone) => {
    setTimeout(resolveDone, 0);
  });
}

afterEach(async () => {
  delete (globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown }).FIREBASE_APPCHECK_DEBUG_TOKEN;
  const pendingApps = apps.splice(0);
  await Promise.all(
    pendingApps.map((app) =>
      deleteApp(app).catch((err: unknown) => {
        if ((err as { code?: string })?.code !== 'app/app-deleted') throw err;
      }),
    ),
  );
  await Promise.all(getApps().map((app) => deleteApp(app)));
  await resetAppRegistryForTests();
  let sandbox = sandboxes.pop();
  while (sandbox !== undefined) {
    sandbox.dispose();
    sandbox = sandboxes.pop();
  }
});

describe('#1908: onTokenChanged binds observer next and error to the observer as this', () => {
  it('calls a class observer next() and error() with the observer instance as this', async () => {
    class TokenRecorder {
      readonly seen: string[] = [];
      readonly errors: string[] = [];

      next(result: AppCheckTokenResult): void {
        this.seen.push(result.token);
      }

      error(err: Error): void {
        this.errors.push(err.message);
      }
    }

    let counter = 0;
    const { app } = freshApp('class-next');
    const appCheck = initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: async () => {
          counter += 1;
          return { token: `token-${counter}`, expireTimeMillis: Date.now() + 3_600_000 };
        },
      }),
      isTokenAutoRefreshEnabled: false,
    });

    const liveObserver = new TokenRecorder();
    const offLive = onTokenChanged(appCheck, liveObserver);
    await getToken(appCheck);
    await getToken(appCheck, true);
    await flushMicrotasks();
    expect(liveObserver.seen).toEqual(['token-1', 'token-2']);
    expect(liveObserver.errors).toEqual([]);

    // Late observer attached to a cached token also receives `this` bound.
    const lateObserver = new TokenRecorder();
    const offLate = onTokenChanged(appCheck, lateObserver);
    await flushMicrotasks();
    expect(lateObserver.seen).toEqual(['token-2']);
    offLive();
    offLate();

    // Error observer method runs with `this` bound when a cold token request fails.
    const { app: failApp } = freshApp('class-error');
    const failAppCheck = initializeAppCheck(failApp, {
      provider: new CustomProvider({
        getToken: async () => {
          throw new Error('attestation rejected');
        },
      }),
      isTokenAutoRefreshEnabled: false,
    });
    const errorObserver = new TokenRecorder();
    const offError = onTokenChanged(failAppCheck, errorObserver);
    await expect(getToken(failAppCheck)).rejects.toThrow('attestation rejected');
    await flushMicrotasks();
    expect(errorObserver.seen).toEqual([]);
    expect(errorObserver.errors).toEqual(['attestation rejected']);
    offError();
  });

  it('uses explicit onError argument when an observer object omits error()', async () => {
    const { app } = freshApp('partial-observer-fallback');
    const appCheck = initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: async () => {
          throw new Error('provider down');
        },
      }),
      isTokenAutoRefreshEnabled: false,
    });
    const receivedErrors: string[] = [];
    const seenTokens: string[] = [];
    const observer = {
      tokens: seenTokens,
      next(result: AppCheckTokenResult) {
        this.tokens.push(result.token);
      },
    };
    const off = onTokenChanged(appCheck, observer, (err) => {
      receivedErrors.push(err.message);
    });
    await expect(getToken(appCheck)).rejects.toThrow('provider down');
    await flushMicrotasks();
    expect(seenTokens).toEqual([]);
    expect(receivedErrors).toEqual(['provider down']);
    off();
  });
});

describe('#1909: throwing token listeners are isolated and do not crash Node', () => {
  it('delivers tokens and errors to sibling listeners when one listener throws', async () => {
    const { app } = freshApp('isolate-next');
    const appCheck = initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: async () => ({ token: 'safe-token', expireTimeMillis: Date.now() + 3_600_000 }),
      }),
      isTokenAutoRefreshEnabled: false,
    });

    const delivered: string[] = [];
    const offA = onTokenChanged(appCheck, () => {
      throw new Error('boom from listener A');
    });
    const offB = onTokenChanged(appCheck, (res) => {
      delivered.push(res.token);
    });
    await getToken(appCheck);
    await flushMicrotasks();
    expect(delivered).toEqual(['safe-token']);

    // Late throwing listener on a cached token must also stay isolated.
    const lateDelivered: string[] = [];
    const offLateThrow = onTokenChanged(appCheck, () => {
      throw new Error('boom from late listener');
    });
    const offLateOk = onTokenChanged(appCheck, (res) => {
      lateDelivered.push(res.token);
    });
    await flushMicrotasks();
    expect(lateDelivered).toEqual(['safe-token']);
    offA();
    offB();
    offLateThrow();
    offLateOk();

    // Error callback that throws must not block sibling error callbacks.
    const { app: errApp } = freshApp('isolate-error');
    const errAppCheck = initializeAppCheck(errApp, {
      provider: new CustomProvider({
        getToken: async () => {
          throw new Error('exchange failure');
        },
      }),
      isTokenAutoRefreshEnabled: false,
    });
    const seenErrors: string[] = [];
    const offErrA = onTokenChanged(
      errAppCheck,
      () => {},
      () => {
        throw new Error('boom from error handler');
      },
    );
    const offErrB = onTokenChanged(
      errAppCheck,
      () => {},
      (err) => {
        seenErrors.push(err.message);
      },
    );
    await expect(getToken(errAppCheck)).rejects.toThrow('exchange failure');
    await flushMicrotasks();
    expect(seenErrors).toEqual(['exchange failure']);
    offErrA();
    offErrB();
  });

  it('keeps a real Node process alive with exit code 0 when token listeners throw', () => {
    const pyricRoot = resolve(import.meta.dir, '../..');
    const appUrl = pathToFileURL(join(pyricRoot, 'dist/app/index.js')).href;
    const acUrl = pathToFileURL(join(pyricRoot, 'dist/app-check/index.js')).href;
    const script = `
      import { initializeApp, deleteApp } from ${JSON.stringify(appUrl)};
      import { initializeAppCheck, CustomProvider, getToken, onTokenChanged } from ${JSON.stringify(acUrl)};

      const seen = [];
      const errs = [];
      const app1 = initializeApp({ apiKey: 'k', projectId: 'p', appId: '1:1:web:1' }, 'node-next');
      const ac1 = initializeAppCheck(app1, {
        provider: new CustomProvider({
          getToken: async () => ({ token: 'tok-live', expireTimeMillis: Date.now() + 3600000 }),
        }),
        isTokenAutoRefreshEnabled: false,
      });
      onTokenChanged(ac1, () => { throw new Error('bad next listener'); });
      onTokenChanged(ac1, (r) => { seen.push(r.token); });
      await getToken(ac1);
      onTokenChanged(ac1, () => { throw new Error('bad cached listener'); });
      onTokenChanged(ac1, (r) => { seen.push('cached:' + r.token); });
      await new Promise((r) => setTimeout(r, 20));

      const app2 = initializeApp({ apiKey: 'k', projectId: 'p', appId: '1:1:web:1' }, 'node-err');
      const ac2 = initializeAppCheck(app2, {
        provider: new CustomProvider({
          getToken: async () => { throw new Error('upstream err'); },
        }),
        isTokenAutoRefreshEnabled: false,
      });
      onTokenChanged(ac2, () => {}, () => { throw new Error('bad error listener'); });
      onTokenChanged(ac2, () => {}, (e) => { errs.push(e.message); });
      await getToken(ac2).catch(() => {});
      await new Promise((r) => setTimeout(r, 20));
      await deleteApp(app1);
      await deleteApp(app2);
      console.log('RESULT ' + JSON.stringify({ seen, errs }));
    `;
    const run = spawnSync('node', ['--input-type=module', '-e', script], {
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
    const line = run.stdout.split('\n').find((entry) => entry.startsWith('RESULT '));
    expect(line).toBeDefined();
    const report = JSON.parse((line ?? '').slice('RESULT '.length)) as {
      seen: string[];
      errs: string[];
    };
    expect(report).toEqual({
      seen: ['tok-live', 'cached:tok-live'],
      errs: ['upstream err'],
    });
  });
});

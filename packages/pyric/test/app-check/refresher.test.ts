import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { deleteApp, getApps, initializeApp } from '../../src/app/index.js';
import { bindAppRegistryRefusal, clientSdkRefusal, createAppForSandbox, resetAppRegistryForTests } from '../../src/app/internal.js';
import type { FirebaseApp } from '../../src/app/types.js';
import {
  CustomProvider,
  ReCaptchaV3Provider,
  getLimitedUseToken,
  getToken,
  initializeAppCheck,
  onTokenChanged,
  setTokenAutoRefreshEnabled,
  type AppCheckTokenResult,
} from '../../src/app-check/index.js';
import {
  TOKEN_REFRESH_BUFFER_MILLIS,
  TOKEN_REFRESH_MAX_RETRY_WAIT_MILLIS,
  TOKEN_REFRESH_MIN_RETRY_WAIT_MILLIS,
  computeNextRefreshDelayMillis,
  issuedAtTimeMillisOf,
} from '../../src/app-check/refresher.js';
import { getAI, getGenerativeModel } from '../../src/ai/index.js';
import { getClock, initializeSandbox } from '../../src/sandbox/index.js';
import { encodeJson } from '../../src/sandbox/internal/sandbox-jwt.js';

const APP_ID = '1:123456789012:web:0a1b2c3d4e5f60718293a4';
const OPTIONS = { apiKey: 'demo-key', projectId: 'demo-app-check-refresher', appId: APP_ID };

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

function waitMs(ms: number): Promise<void> {
  return new Promise((resolveDone) => {
    setTimeout(resolveDone, ms);
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

describe('#1656: sandbox App Check token refresher and schedule formula', () => {
  it('computes refresh delay at 50% TTL + 5 minutes, capped at 5 minutes before expiry', () => {
    const base = 1_700_000_000_000;
    const min = 60 * 1000;
    expect(computeNextRefreshDelayMillis(null, base)).toBe(0);
    // 60m TTL -> 30m + 5m = 35m (earlier than 60m - 5m = 55m)
    expect(
      computeNextRefreshDelayMillis(
        { issuedAtTimeMillis: base, expireTimeMillis: base + 60 * min },
        base,
      ),
    ).toBe(35 * min);
    // 30m TTL -> 15m + 5m = 20m (earlier than 30m - 5m = 25m)
    expect(
      computeNextRefreshDelayMillis(
        { issuedAtTimeMillis: base, expireTimeMillis: base + 30 * min },
        base,
      ),
    ).toBe(20 * min);
    // 12m TTL -> midpoint+5m is 11m, clamped to expire-5m = 7m
    expect(
      computeNextRefreshDelayMillis(
        { issuedAtTimeMillis: base, expireTimeMillis: base + 12 * min },
        base,
      ),
    ).toBe(7 * min);
    // 4m TTL -> already inside 5m pre-expiry window -> 0ms
    expect(
      computeNextRefreshDelayMillis(
        { issuedAtTimeMillis: base, expireTimeMillis: base + 4 * min },
        base,
      ),
    ).toBe(0);
    expect(TOKEN_REFRESH_BUFFER_MILLIS).toBe(5 * min);
    expect(TOKEN_REFRESH_MIN_RETRY_WAIT_MILLIS).toBe(30 * 1000);
    expect(TOKEN_REFRESH_MAX_RETRY_WAIT_MILLIS).toBe(16 * min);
  });

  it('extracts JWT iat without relying on the Node Buffer global (browser fallback)', () => {
    const issuedSec = 1_700_000_000;
    const nowMillis = (issuedSec + 120) * 1000;
    const jwt = `${encodeJson({ alg: 'RS256' })}.${encodeJson({ iat: issuedSec })}.sig`;

    const savedBuffer = (globalThis as { Buffer?: unknown }).Buffer;
    delete (globalThis as { Buffer?: unknown }).Buffer;
    try {
      expect(issuedAtTimeMillisOf(jwt, nowMillis)).toBe(issuedSec * 1000);
      expect(issuedAtTimeMillisOf('opaque-token', nowMillis)).toBe(nowMillis);
      expect(issuedAtTimeMillisOf('a.!!!.c', nowMillis)).toBe(nowMillis);
    } finally {
      (globalThis as { Buffer?: unknown }).Buffer = savedBuffer;
    }
  });

  it('calls the CustomProvider right away and refreshes proactively on the sandbox clock when isTokenAutoRefreshEnabled is true', async () => {
    const startMillis = Date.UTC(2026, 6, 1, 12, 0, 0);
    const sandbox = initializeSandbox();
    const clock = getClock(sandbox);
    clock.set(startMillis);

    let providerCalls = 0;
    const { app } = freshApp('auto-refresh-clock', sandbox);
    const appCheck = initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: async () => {
          providerCalls += 1;
          return {
            token: `auto-tok-${providerCalls}`,
            expireTimeMillis: clock.now() + 60 * 60 * 1000,
          };
        },
      }),
      isTokenAutoRefreshEnabled: true,
    });

    const seen: string[] = [];
    const unsubscribe = onTokenChanged(appCheck, (res) => {
      seen.push(res.token);
    });

    await waitMs(25);
    expect(providerCalls).toBe(1);
    expect(seen).toEqual(['auto-tok-1']);

    // At 34 minutes (1 minute before the 35-minute refresh mark), no refresh yet.
    clock.advance(34 * 60 * 1000);
    await waitMs(25);
    expect(providerCalls).toBe(1);

    // At 35 minutes, proactive refresh fires and delivers the second token.
    clock.advance(1 * 60 * 1000);
    await waitMs(25);
    expect(providerCalls).toBe(2);
    expect(seen).toEqual(['auto-tok-1', 'auto-tok-2']);

    unsubscribe();
  });

  it('fetches once immediately without a user listener when isTokenAutoRefreshEnabled is true, and respects toggle and unsubscribe', async () => {
    const sandbox = initializeSandbox();
    const clock = getClock(sandbox);
    clock.set(Date.UTC(2026, 6, 1, 12, 0, 0));

    let initCalls = 0;
    const { app: eagerApp } = freshApp('auto-eager', sandbox);
    initializeAppCheck(eagerApp, {
      provider: new CustomProvider({
        getToken: async () => {
          initCalls += 1;
          return { token: `eager-${initCalls}`, expireTimeMillis: clock.now() + 60 * 60 * 1000 };
        },
      }),
      isTokenAutoRefreshEnabled: true,
    });
    await waitMs(25);
    expect(initCalls).toBe(1);

    // Starting with auto-refresh false makes 0 provider calls until toggled on.
    let lazyCalls = 0;
    const { app: lazyApp } = freshApp('auto-lazy', sandbox);
    const lazyCheck = initializeAppCheck(lazyApp, {
      provider: new CustomProvider({
        getToken: async () => {
          lazyCalls += 1;
          return { token: `lazy-${lazyCalls}`, expireTimeMillis: clock.now() + 60 * 60 * 1000 };
        },
      }),
      isTokenAutoRefreshEnabled: false,
    });
    const lazySeen: string[] = [];
    const unsub = onTokenChanged(lazyCheck, (res) => lazySeen.push(res.token));
    await waitMs(25);
    expect(lazyCalls).toBe(0);

    setTokenAutoRefreshEnabled(lazyCheck, true);
    await waitMs(25);
    expect(lazyCalls).toBe(1);
    expect(lazySeen).toEqual(['lazy-1']);

    // Unsubscribing the only listener stops proactive refreshes.
    unsub();
    clock.advance(40 * 60 * 1000);
    await waitMs(25);
    expect(lazyCalls).toBe(1);
  });

  it('retries with exponential backoff (30s..16m) after rejection and resets to 30s after success', async () => {
    const sandbox = initializeSandbox();
    const clock = getClock(sandbox);
    clock.set(Date.UTC(2026, 6, 1, 12, 0, 0));

    let attempts = 0;
    let shouldFail = true;
    const errors: string[] = [];
    const tokens: string[] = [];

    const { app } = freshApp('auto-backoff', sandbox);
    const appCheck = initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: async () => {
          attempts += 1;
          if (shouldFail) {
            throw new Error(`fail-${attempts}`);
          }
          return {
            token: `recovered-${attempts}`,
            expireTimeMillis: clock.now() + 60 * 60 * 1000,
          };
        },
      }),
      isTokenAutoRefreshEnabled: true,
    });
    const unsub = onTokenChanged(
      appCheck,
      (res) => tokens.push(res.token),
      (err) => errors.push(err.message),
    );

    // Attempt 1 runs immediately and fails -> schedules 30s retry.
    await waitMs(25);
    expect(attempts).toBe(1);
    expect(errors).toEqual(['fail-1']);

    // 29s is too early for the first retry.
    clock.advance(29_000);
    await waitMs(25);
    expect(attempts).toBe(1);

    // At 30s attempt 2 fails -> doubles backoff to 60s.
    clock.advance(1_000);
    await waitMs(25);
    expect(attempts).toBe(2);
    expect(errors).toEqual(['fail-1', 'fail-2']);

    // 59s is too early for attempt 3 (wait is 60s).
    clock.advance(59_000);
    await waitMs(25);
    expect(attempts).toBe(2);

    // At 60s attempt 3 fails -> doubles backoff to 120s.
    clock.advance(1_000);
    await waitMs(25);
    expect(attempts).toBe(3);

    // Advance through 120s -> 240s -> 480s -> 960s cap.
    for (const expectedWaitSeconds of [120, 240, 480, 960, 960]) {
      const before = attempts;
      clock.advance((expectedWaitSeconds - 1) * 1000);
      await waitMs(20);
      expect(attempts).toBe(before);
      clock.advance(1_000);
      await waitMs(20);
      expect(attempts).toBe(before + 1);
    }

    // Recover on the next retry (capped at 960s).
    shouldFail = false;
    clock.advance(960 * 1000);
    await waitMs(25);
    expect(tokens).toEqual([`recovered-${attempts}`]);

    // After a success, the next forced failure resets backoff to 30s.
    shouldFail = true;
    clock.advance(35 * 60 * 1000);
    await waitMs(25);
    const afterProactiveFail = attempts;
    // Retry must fire after 30s, not 960s.
    clock.advance(30_000);
    await waitMs(25);
    expect(attempts).toBe(afterProactiveFail + 1);

    unsub();
  });

  it('does not start a refresher when provider.initialize throws or automaticDataCollectionEnabled is false', async () => {
    const { app: blockedApp } = freshApp('blocked-dc');
    const badApp = initializeApp(OPTIONS, {
      name: 'blocked-auto-refresh',
      automaticDataCollectionEnabled: false,
    });
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let calls = 0;
      initializeAppCheck(badApp, {
        provider: new CustomProvider({
          getToken: async () => {
            calls += 1;
            return { token: 'never', expireTimeMillis: Date.now() + 3_600_000 };
          },
        }),
        isTokenAutoRefreshEnabled: true,
      });
      await waitMs(25);
      expect(calls).toBe(0);
    } finally {
      warnSpy.mockRestore();
      await deleteApp(badApp);
    }

    expect(() =>
      initializeAppCheck(blockedApp, {
        provider: new ReCaptchaV3Provider('site-key'),
        isTokenAutoRefreshEnabled: true,
      }),
    ).toThrow(ReferenceError);
  });

  it('stops auto-refresh after deleteApp(app)', async () => {
    const sandbox = initializeSandbox();
    const clock = getClock(sandbox);
    clock.set(Date.UTC(2026, 6, 1, 12, 0, 0));
    let calls = 0;
    const { app } = freshApp('delete-stop', sandbox);
    initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: async () => {
          calls += 1;
          return { token: `tok-${calls}`, expireTimeMillis: clock.now() + 60 * 60 * 1000 };
        },
      }),
      isTokenAutoRefreshEnabled: true,
    });
    await waitMs(25);
    expect(calls).toBe(1);

    await deleteApp(app);
    clock.advance(45 * 60 * 1000);
    await waitMs(25);
    expect(calls).toBe(1);
  });

  it('keeps cached token and notifies next({ token, internalError }) when forced refresh fails while a valid token is cached', async () => {
    const sandbox = initializeSandbox();
    const clock = getClock(sandbox);
    clock.set(Date.UTC(2026, 6, 1, 12, 0, 0));

    let shouldFail = false;
    const refreshError = new Error('transient refresh failure');
    const { app } = freshApp('forced-refresh-fail', sandbox);
    const appCheck = initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: async () => {
          if (shouldFail) throw refreshError;
          return { token: 'cached-valid-tok', expireTimeMillis: clock.now() + 60 * 60 * 1000 };
        },
      }),
      isTokenAutoRefreshEnabled: false,
    });

    const nextEvents: Array<AppCheckTokenResult & { internalError?: unknown }> = [];
    const errorEvents: Error[] = [];
    const unsub = onTokenChanged(
      appCheck,
      (res) => nextEvents.push(res as AppCheckTokenResult & { internalError?: unknown }),
      (err) => errorEvents.push(err),
    );

    const first = await getToken(appCheck);
    expect(first).toEqual({ token: 'cached-valid-tok' });
    await flushMicrotasks();
    expect(nextEvents).toEqual([{ token: 'cached-valid-tok' }]);

    // Forced refresh rejects the caller, keeps cached token, and notifies observers via `next` (not `error`).
    shouldFail = true;
    await expect(getToken(appCheck, true)).rejects.toBe(refreshError);
    await flushMicrotasks();
    expect(errorEvents).toEqual([]);
    expect(nextEvents).toHaveLength(2);
    expect(nextEvents[1]).toEqual({ token: 'cached-valid-tok', internalError: refreshError });

    // Non-forced getToken still returns the cached valid token.
    expect(await getToken(appCheck)).toEqual({ token: 'cached-valid-tok' });

    // Once the cached token expires, a failure sends to `error` handler instead of `next`.
    clock.advance(61 * 60 * 1000);
    await expect(getToken(appCheck)).rejects.toBe(refreshError);
    await flushMicrotasks();
    expect(errorEvents).toEqual([refreshError]);
    unsub();
  });

  it('logs production warning when the placeholder token path runs on provider rejection', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { app } = freshApp('placeholder-warning');
      initializeAppCheck(app, {
        provider: new CustomProvider({
          getToken: async () => {
            throw new Error('custom provider offline');
          },
        }),
        isTokenAutoRefreshEnabled: false,
      });
      const model = getGenerativeModel(getAI(app), { model: 'gemini-flash-lite-latest' });
      await expect(model.generateContent('hello')).rejects.toThrow();
      const warnings = warnSpy.mock.calls.map((args) => args.map(String).join(' '));
      expect(warnings).toContain('Unable to obtain a valid App Check token: custom provider offline');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not trigger a refused sandbox getter on remote/SSR apps (falls back to Date.now())', async () => {
    await resetAppRegistryForTests();
    bindAppRegistryRefusal(() => clientSdkRefusal('remote:http://127.0.0.1:5000'));
    const app = initializeApp(OPTIONS, 'ssr-refused-sandbox');
    let calls = 0;
    const appCheck = initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: async () => {
          calls += 1;
          return { token: `ssr-tok-${calls}`, expireTimeMillis: Date.now() + 3_600_000 };
        },
      }),
      isTokenAutoRefreshEnabled: false,
    });
    const seen: string[] = [];
    const unsub = onTokenChanged(appCheck, (res) => seen.push(res.token));
    expect(await getToken(appCheck)).toEqual({ token: 'ssr-tok-1' });
    expect(await getLimitedUseToken(appCheck)).toEqual({ token: 'ssr-tok-2' });
    await flushMicrotasks();
    expect(seen).toEqual(['ssr-tok-1']);
    unsub();
    await deleteApp(app);
  });
});

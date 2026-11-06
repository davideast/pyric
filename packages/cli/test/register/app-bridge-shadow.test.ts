/**
 * Production AI mode attaches the real `firebase/app-check` and `firebase/ai`
 * to a shadow Firebase app that `shadowedAppRegistry` creates beside each
 * Pyric app. Creating it must never break Pyric's `initializeApp`, but when it
 * fails, `initializeAppCheck` names that cause instead of the Firebase SDK's
 * missing-container error (#1293).
 *
 * No real app path makes the SDK's `initializeApp` throw for an app Pyric
 * accepted, so the failure is injected. bun's `mock.module` is process-wide
 * and retroactive, so the mock passes every call through to the real SDK and
 * throws only while `failShadow` is set, and it lives in its own file.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';
import * as sdkApp from 'firebase/app';

const realExports = { ...sdkApp };
const realInitializeApp = sdkApp.initializeApp;
const SHADOW_FAILURE = new Error('injected: the Firebase SDK refused these options');
let failShadow = false;

mock.module('firebase/app', () => ({
  ...realExports,
  initializeApp: (...args: Parameters<typeof realInitializeApp>) => {
    if (failShadow) throw SHADOW_FAILURE;
    return realInitializeApp(...args);
  },
}));

const { shadowAppOf, shadowedAppRegistry } = await import('../../src/register/app-bridge-shadow.js');
const bridge = await import('../../src/register/app-bridge-app-check.js');
const { CustomProvider } = await import('firebase/app-check');

const OPTIONS = { apiKey: 'demo-api-key', appId: '1:123456789012:web:0a1b2c3d4e5f60718293a4', projectId: 'demo-shadow' };

type PyricLikeApp = { name: string; options: typeof OPTIONS; automaticDataCollectionEnabled: boolean };

/** A minimal Pyric-shaped registry, so this suite binds no sandbox. */
function pyricLikeRegistry() {
  const apps = new Map<string, PyricLikeApp>();
  return shadowedAppRegistry({
    initializeApp: (options, name) => {
      const app = { name: String(name), options: options as typeof OPTIONS, automaticDataCollectionEnabled: false };
      apps.set(app.name, app);
      return app as never;
    },
    getApp: (name) => apps.get(name ?? '[DEFAULT]') as never,
    getApps: () => [...apps.values()] as never,
    deleteApp: async (app) => {
      apps.delete(app.name);
    },
  });
}

const provider = () => new CustomProvider({ getToken: async () => ({ token: 'sandbox-token', expireTimeMillis: Date.now() + 3_600_000 }) });

function thrown(operation: () => unknown): unknown {
  try {
    operation();
  } catch (error) {
    return error;
  }
  return undefined;
}

let appSeq = 0;
const nextName = () => `shadow-test-${++appSeq}`;

afterEach(async () => {
  failShadow = false;
  await Promise.all(sdkApp.getApps().map((app) => sdkApp.deleteApp(app)));
});

describe('shadow app creation failure in production AI mode', () => {
  it('still returns the Pyric app from initializeApp', () => {
    failShadow = true;
    const name = nextName();
    const app = pyricLikeRegistry().initializeApp(OPTIONS, name);
    expect(app.name).toBe(name);
    expect('container' in app).toBe(false);
  });

  it('makes initializeAppCheck throw an error that names the cause, with the original as cause', () => {
    failShadow = true;
    const name = nextName();
    const app = pyricLikeRegistry().initializeApp(OPTIONS, name);
    const error = thrown(() => bridge.initializeAppCheck(app, { provider: provider() })) as Error & { cause?: unknown };
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe(
      `Pyric could not create the Firebase app that firebase/app-check and firebase/ai attach to in production AI mode, for app "${name}": ${SHADOW_FAILURE.message}.`,
    );
    expect(error.cause).toBe(SHADOW_FAILURE);
  });

  it('returns the shadow once a later attempt succeeds', () => {
    const registry = pyricLikeRegistry();
    const name = nextName();
    failShadow = true;
    const app = registry.initializeApp(OPTIONS, name);
    expect(thrown(() => shadowAppOf(app))).toBeInstanceOf(Error);
    failShadow = false;
    registry.getApp(name);
    const shadow = shadowAppOf(app);
    expect(shadow).not.toBe(app);
    expect(shadow).toBe(sdkApp.getApp(name));
    expect(thrown(() => bridge.initializeAppCheck(app, { provider: provider(), isTokenAutoRefreshEnabled: false }))).toBeUndefined();
  });

  it('forgets the failure when the app is deleted', async () => {
    const registry = pyricLikeRegistry();
    const name = nextName();
    failShadow = true;
    const app = registry.initializeApp(OPTIONS, name);
    await registry.deleteApp(app);
    expect(shadowAppOf(app)).toBe(app);
  });

  it('records failures from the served firebase/app entry where the register bridge reads them', async () => {
    const served = await import('../../src/serve/entries/app-ai-passthrough.js');
    // Pyric allows one Firebase configuration per runtime; other suites in this process bind theirs.
    const { resetAppRegistryForTests } = await import('pyric/app/internal');
    await resetAppRegistryForTests();
    failShadow = true;
    const name = nextName();
    const app = served.initializeApp(OPTIONS, name);
    try {
      const error = thrown(() => bridge.initializeAppCheck(app, { provider: provider() })) as Error & { cause?: unknown };
      expect(error.message).toContain(`for app "${name}": ${SHADOW_FAILURE.message}`);
      expect(error.cause).toBe(SHADOW_FAILURE);
    } finally {
      await served.deleteApp(app);
      await resetAppRegistryForTests();
    }
  });

  it('returns an app with nothing recorded unchanged, as before', () => {
    const passedDirectly = { name: nextName() };
    expect(shadowAppOf(passedDirectly)).toBe(passedDirectly);
  });
});

import { afterEach, describe, expect, it } from 'bun:test';
import {
  FirebaseError,
  deleteApp,
  getApps,
  initializeApp,
  type FirebaseApp,
} from '../../src/app/index.js';
import { createAppForSandbox, resetAppRegistryForTests } from '../../src/app/internal.js';
import {
  CustomProvider,
  ReCaptchaV3Provider,
  getLimitedUseToken,
  getToken,
  initializeAppCheck,
  onTokenChanged,
} from '../../src/app-check/index.js';
import { AIError, getAI, getGenerativeModel } from '../../src/ai/index.js';
import { initializeSandbox } from '../../src/sandbox/index.js';
import { mintAppCheckToken } from '../../src/sandbox/internal/app-check-token.js';

const OPTIONS = {
  apiKey: 'fake-api-key',
  projectId: 'demo-app-check-parity',
  appId: '1:123456789012:web:abcdef0123456789',
};
const MODEL = 'gemini-flash-lite-latest';

const sandboxes: Array<ReturnType<typeof initializeSandbox>> = [];

afterEach(async () => {
  delete (globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown }).FIREBASE_APPCHECK_DEBUG_TOKEN;
  await Promise.all(getApps().map((app) => deleteApp(app)));
  await resetAppRegistryForTests();
  let sandbox = sandboxes.pop();
  while (sandbox !== undefined) {
    sandbox.dispose();
    sandbox = sandboxes.pop();
  }
});

describe('initializeAppCheck on deleted FirebaseApp (#1911)', () => {
  it('throws app/app-deleted on deleted registry apps regardless of isTokenAutoRefreshEnabled', async () => {
    for (const autoRefresh of [undefined, false, true]) {
      const app = initializeApp(OPTIONS, `del-reg-${String(autoRefresh)}`);
      await deleteApp(app);
      let caught: unknown;
      try {
        initializeAppCheck(app, {
          provider: new CustomProvider({
            getToken: async () => ({ token: 'unused', expireTimeMillis: Date.now() + 60_000 }),
          }),
          isTokenAutoRefreshEnabled: autoRefresh,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(FirebaseError);
      expect((caught as FirebaseError).code).toBe('app/app-deleted');
    }
  });

  it('throws app/app-deleted on deleted createAppForSandbox handles and preserves same-options vs different-options upstream parity', async () => {
    const sandbox = initializeSandbox();
    sandboxes.push(sandbox);

    const makeProvider = () =>
      new CustomProvider({
        getToken: async () => ({ token: 'tok', expireTimeMillis: Date.now() + 60_000 }),
      });

    // Uninitialized before deleteApp -> throws app/app-deleted
    const coldDeleted = createAppForSandbox(sandbox, OPTIONS, 'cold-deleted');
    await deleteApp(coldDeleted);
    expect(() =>
      initializeAppCheck(coldDeleted, { provider: makeProvider() }),
    ).toThrow(expect.objectContaining({ code: 'app/app-deleted' }));

    // Initialized before deleteApp: same options returns existing handle; different options throws app/app-deleted
    const warmDeleted: FirebaseApp = createAppForSandbox(sandbox, OPTIONS, 'warm-deleted');
    const existingHandle = initializeAppCheck(warmDeleted, {
      provider: makeProvider(),
      isTokenAutoRefreshEnabled: false,
    });
    await deleteApp(warmDeleted);

    expect(
      initializeAppCheck(warmDeleted, {
        provider: makeProvider(),
        isTokenAutoRefreshEnabled: false,
      }),
    ).toBe(existingHandle);

    expect(() =>
      initializeAppCheck(warmDeleted, {
        provider: makeProvider(),
        isTokenAutoRefreshEnabled: true,
      }),
    ).toThrow(expect.objectContaining({ code: 'app/app-deleted' }));

    expect(() =>
      initializeAppCheck(warmDeleted, {
        provider: new ReCaptchaV3Provider('other-site-key'),
      }),
    ).toThrow(expect.objectContaining({ code: 'app/app-deleted' }));
  });
});

describe('CustomProvider synchronous return and synchronous throw (#1913)', () => {
  it('awaits a plain synchronous token object off-stack across getToken, getLimitedUseToken, observers, and AI Logic', async () => {
    const mintedA = await mintAppCheckToken(
      { appId: OPTIONS.appId, projectId: OPTIONS.projectId },
      3600,
    );
    const mintedB = await mintAppCheckToken(
      { appId: OPTIONS.appId, projectId: OPTIONS.projectId },
      300,
    );

    let callIndex = 0;
    let invokedSynchronously = false;
    const app = initializeApp(OPTIONS, 'sync-return-app');
    const appCheck = initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: (() => {
          invokedSynchronously = true;
          callIndex += 1;
          return callIndex === 1 ? mintedA : mintedB;
        }) as unknown as () => Promise<{ token: string; expireTimeMillis: number }>,
      }),
      isTokenAutoRefreshEnabled: false,
    });

    const observedTokens: string[] = [];
    const unsubscribe = onTokenChanged(appCheck, (result) => {
      observedTokens.push(result.token);
    });

    const pendingToken = getToken(appCheck);
    expect(invokedSynchronously).toBe(false);

    const first = await pendingToken;
    expect(invokedSynchronously).toBe(true);
    expect(first).toEqual({ token: mintedA.token });

    const limited = await getLimitedUseToken(appCheck);
    expect(limited).toEqual({ token: mintedB.token });

    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(observedTokens).toEqual([mintedA.token]);
    unsubscribe();

    // AI Logic accepts the synchronously returned valid sandbox App Check token.
    const model = getGenerativeModel(getAI(app), { model: MODEL });
    const aiReply = await model.generateContent('hello');
    expect(aiReply.response.candidates?.length).toBeGreaterThan(0);

    const limitedModel = getGenerativeModel(
      getAI(app, { useLimitedUseAppCheckTokens: true }),
      { model: MODEL },
    );
    const limitedReply = await limitedModel.generateContent('hello limited');
    expect(limitedReply.response.candidates?.length).toBeGreaterThan(0);
  });

  it('routes synchronous throws from CustomProvider.getToken to callers, onTokenChanged error observers, and AI Logic', async () => {
    const validMinted = await mintAppCheckToken(
      { appId: OPTIONS.appId, projectId: OPTIONS.projectId },
      3600,
    );
    let shouldThrow = true;
    const app = initializeApp(OPTIONS, 'sync-throw-app');
    const appCheck = initializeAppCheck(app, {
      provider: new CustomProvider({
        getToken: (() => {
          if (shouldThrow) {
            throw new Error('sync provider boom');
          }
          return validMinted;
        }) as unknown as () => Promise<{ token: string; expireTimeMillis: number }>,
      }),
      isTokenAutoRefreshEnabled: false,
    });

    const observedErrors: string[] = [];
    const observedNext: string[] = [];
    const unsubscribe = onTokenChanged(
      appCheck,
      (res) => observedNext.push(res.token),
      (err) => observedErrors.push(err.message),
    );

    await expect(getToken(appCheck)).rejects.toThrow('sync provider boom');
    await expect(getLimitedUseToken(appCheck)).rejects.toThrow('sync provider boom');
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(observedErrors).toEqual(['sync provider boom']);
    expect(observedNext).toEqual([]);

    // Regular AI model falls back to placeholder and receives 401 gate refusal; limited-use wraps as AIError('error').
    const regularModel = getGenerativeModel(getAI(app), { model: MODEL });
    let gateErr: unknown;
    try {
      await regularModel.generateContent('ping');
    } catch (e) {
      gateErr = e;
    }
    expect(gateErr).toBeInstanceOf(AIError);
    expect((gateErr as AIError).customErrorData?.status).toBe(401);

    const limitedModel = getGenerativeModel(
      getAI(app, { useLimitedUseAppCheckTokens: true }),
      { model: MODEL },
    );
    let limitedErr: unknown;
    try {
      await limitedModel.generateContent('ping');
    } catch (e) {
      limitedErr = e;
    }
    expect(limitedErr).toBeInstanceOf(AIError);
    expect((limitedErr as AIError).code).toBe('error');
    expect((limitedErr as AIError).message).toContain('sync provider boom');

    // inFlight was cleared on failure, so once the provider recovers, getToken succeeds.
    shouldThrow = false;
    const recovered = await getToken(appCheck);
    expect(recovered).toEqual({ token: validMinted.token });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(observedNext).toEqual([validMinted.token]);
    unsubscribe();
  });
});

/**
 * The reCAPTCHA providers where there is no `document`, as in a Node process,
 * a server-rendered module, or this test runner (#1643). Upstream
 * `initializeAppCheck` throws `ReferenceError: document is not defined` from
 * the provider's `initialize`, debug token or not, after the app is set up.
 * Row `app-check#recaptcha-providers-without-document` holds the same claim
 * for the climb lane; this file guards it in the default run.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { initializeApp } from '../../src/app/index.js';
import { CustomProvider, getToken, initializeAppCheck, ReCaptchaEnterpriseProvider, ReCaptchaV3Provider } from '../../src/app-check/index.js';
import { NEVER_SETTLES_WARNING, resetNeverSettlesWarningForTests } from '../../src/app-check/never-settles-warning.js';

type TestGlobal = { FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown; document?: unknown };
const testGlobal = globalThis as TestGlobal;

const OPTIONS = { apiKey: 'demo-api-key', appId: '1:123456789012:web:0a1b2c3d4e5f60718293a4', projectId: 'demo-recaptcha' };
const PROVIDERS = [
  { name: 'ReCaptchaV3Provider', make: (siteKey: string) => new ReCaptchaV3Provider(siteKey) },
  { name: 'ReCaptchaEnterpriseProvider', make: (siteKey: string) => new ReCaptchaEnterpriseProvider(siteKey) },
];

let appSeq = 0;
const freshApp = () => initializeApp(OPTIONS, `recaptcha-without-document-${++appSeq}`);

/** Initializes App Check with a reCAPTCHA provider, catching the throw as a shared firebase.ts might, and returns the handle. */
function caughtThenInitialized(provider: (siteKey: string) => ReCaptchaV3Provider | ReCaptchaEnterpriseProvider) {
  const app = freshApp();
  expect(() => initializeAppCheck(app, { provider: provider('site-key') })).toThrow();
  return initializeAppCheck(app, { provider: provider('site-key') });
}

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  resetNeverSettlesWarningForTests();
  warn = spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  delete testGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN;
  delete testGlobal.document;
});

describe('initializeAppCheck with a reCAPTCHA provider and no document', () => {
  for (const { name, make } of PROVIDERS) {
    it(`${name} throws ReferenceError: document is not defined`, () => {
      expect(testGlobal.document).toBeUndefined();
      expect(() => initializeAppCheck(freshApp(), { provider: make('site-key') })).toThrow(new ReferenceError('document is not defined'));
    });

    it(`${name} throws under the debug token too`, () => {
      testGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
      expect(() => initializeAppCheck(freshApp(), { provider: make('site-key') })).toThrow(new ReferenceError('document is not defined'));
    });

    it(`${name} leaves the app initialized: same options return the handle, others are refused`, () => {
      const app = freshApp();
      expect(() => initializeAppCheck(app, { provider: make('site-key') })).toThrow(ReferenceError);
      expect(initializeAppCheck(app, { provider: make('site-key') }).app).toBe(app);
      expect(() => initializeAppCheck(app, { provider: make('another-site-key') })).toThrow(
        expect.objectContaining({ code: 'appCheck/already-initialized' }),
      );
    });
  }

  it('a CustomProvider initializes', () => {
    const provider = new CustomProvider({ getToken: async () => ({ token: 't', expireTimeMillis: Date.now() + 60_000 }) });
    expect(initializeAppCheck(freshApp(), { provider }).app).toBeDefined();
  });

  it('a reCAPTCHA provider initializes where there is a document', () => {
    testGlobal.document = {};
    expect(initializeAppCheck(freshApp(), { provider: new ReCaptchaV3Provider('site-key') }).app).toBeDefined();
  });
});

describe('a token for a reCAPTCHA provider with no document, which production never settles', () => {
  it('mints a token and warns once per process', async () => {
    const first = caughtThenInitialized(PROVIDERS[0]!.make);
    expect((await getToken(first, true)).token.split('.')).toHaveLength(3);
    await getToken(first, true);
    await getToken(caughtThenInitialized(PROVIDERS[1]!.make), true);
    expect(warn.mock.calls).toEqual([[NEVER_SETTLES_WARNING]]);
  });

  it('does not warn under the debug token, where production exchanges it', async () => {
    testGlobal.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    await getToken(caughtThenInitialized(PROVIDERS[0]!.make));
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn for a CustomProvider', async () => {
    const provider = new CustomProvider({ getToken: async () => ({ token: 't', expireTimeMillis: Date.now() + 60_000 }) });
    await getToken(initializeAppCheck(freshApp(), { provider }));
    expect(warn).not.toHaveBeenCalled();
  });
});

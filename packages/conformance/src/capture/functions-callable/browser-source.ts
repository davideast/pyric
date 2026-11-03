/**
 * The page program for the functions-callable client captures, modeled on
 * `capture/app-check/browser-source.ts`. It runs the installed
 * `firebase/functions` (with `firebase/auth` and `firebase/app-check` where a
 * scenario needs them) in headless Chromium and returns raw facts to the Node
 * runner, which reduces them to shapes before anything is written. Function
 * reports carry claim names, never token values. The App Check debug token
 * arrives through `self.FIREBASE_APPCHECK_DEBUG_TOKEN`, set by an init script
 * before this bundle loads.
 *
 * The local suite bundles the same source against `pyric/functions`, so both
 * sides of a client row ran one program.
 */
export const CALLABLE_BROWSER_SOURCE = String.raw`
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithCustomToken, signOut } from 'firebase/auth';
import { CustomProvider, initializeAppCheck } from 'firebase/app-check';
import { getFunctions, httpsCallable, httpsCallableFromURL } from 'firebase/functions';

const HTTPS_ERROR_CODES = [
  'ok', 'cancelled', 'unknown', 'invalid-argument', 'deadline-exceeded', 'not-found', 'already-exists',
  'permission-denied', 'unauthenticated', 'resource-exhausted', 'failed-precondition', 'aborted',
  'out-of-range', 'unimplemented', 'internal', 'unavailable', 'data-loss',
];

let appCount = 0;
const newApp = (config, withAppCheck) => {
  const app = initializeApp(config, 'callable-' + appCount++);
  if (withAppCheck) {
    initializeAppCheck(app, {
      provider: new CustomProvider({ getToken: async () => { throw new Error('debug mode must not call the provider'); } }),
      isTokenAutoRefreshEnabled: false,
    });
  }
  return app;
};

const typeOf = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  return typeof value;
};
const errorFacts = (error) => ({
  threw: true,
  isError: error instanceof Error,
  name: error?.name ?? null,
  code: error?.code ?? null,
  message: String(error?.message ?? error),
  details: error?.details ?? null,
  customDataKeys: error?.customData ? Object.keys(error.customData).sort() : [],
});
const settle = async (operation) => {
  try {
    const value = await operation();
    return { threw: false, value };
  } catch (error) {
    return errorFacts(error);
  }
};
const callFacts = (callable, data) => settle(async () => {
  const result = await callable(data);
  return { resultKeys: Object.keys(result).sort(), dataType: typeOf(result.data), data: result.data };
});

globalThis.functionsCallableProbes = {
  async encoding(config, input) {
    const echo = httpsCallable(getFunctions(newApp(config, false), input.region), 'pyricCallableEcho');
    const sent = await callFacts(echo, { when: new Date('2026-01-02T03:04:05.006Z'), big: 9007199254740993, list: [1, null] });
    const nan = await callFacts(echo, { value: Number.NaN });
    const infinity = await callFacts(echo, { value: Number.POSITIVE_INFINITY });
    const undefinedData = await callFacts(echo, undefined);
    const returned = {};
    for (const value of ['undefined', 'null', 'date', 'large-integer', 'nested', 'nan', 'infinity']) {
      returned[value] = await callFacts(echo, { mode: 'return', value });
    }
    return { sent, nan, infinity, undefinedData, returned };
  },

  async errors(config, input) {
    const functions = getFunctions(newApp(config, false), input.region);
    const echo = httpsCallable(functions, 'pyricCallableEcho');
    const codes = {};
    for (const code of HTTPS_ERROR_CODES) {
      codes[code] = await callFacts(echo, { mode: 'throw', code, message: 'pyric ' + code, details: { code, n: 1 } });
    }
    return {
      codes,
      withoutDetails: await callFacts(echo, { mode: 'throw', code: 'not-found', message: 'no details' }),
      throwPlain: await callFacts(echo, { mode: 'throw-plain' }),
      throwString: await callFacts(echo, { mode: 'throw-string' }),
      enforcedWithoutAppCheck: await callFacts(httpsCallable(functions, 'pyricCallableEnforced'), {}),
      missingFunction: await callFacts(httpsCallable(functions, 'pyricCallableMissing'), {}),
      isFunctionsErrorName: (await callFacts(echo, { mode: 'throw', code: 'aborted', message: 'x' })).name,
    };
  },

  async fromUrl(config, input) {
    const functions = getFunctions(newApp(config, false), input.region);
    const out = {};
    for (const [via, url] of Object.entries(input.urls ?? {})) {
      out[via] = await callFacts(httpsCallableFromURL(functions, url), { via });
    }
    return out;
  },

  async customDomain(config, input) {
    const functions = getFunctions(newApp(config, false), input.customDomain);
    return { call: await callFacts(httpsCallable(functions, 'pyricCallableEcho'), { via: 'custom-domain' }) };
  },

  async limitedUse(config, input) {
    const functions = getFunctions(newApp(config, true), input.region);
    const limited = httpsCallable(functions, 'pyricCallableConsume', { limitedUseAppCheckTokens: true });
    const cached = httpsCallable(functions, 'pyricCallableConsume');
    return {
      limitedFirst: await callFacts(limited, {}),
      limitedSecond: await callFacts(limited, {}),
      cachedFirst: await callFacts(cached, {}),
      cachedSecond: await callFacts(cached, {}),
      enforced: await callFacts(httpsCallable(functions, 'pyricCallableEnforced'), {}),
    };
  },

  async stream(config, input) {
    const functions = getFunctions(newApp(config, false), input.region);
    const streaming = httpsCallable(functions, 'pyricCallableStream');
    const collect = (data) => settle(async () => {
      const { stream, data: result } = await streaming.stream(data);
      const chunks = [];
      const streamOutcome = await settle(async () => {
        for await (const chunk of stream) chunks.push(chunk);
      });
      return { chunks, streamOutcome, result: await settle(() => result) };
    });
    return {
      chunks: await collect({ pauseMs: 2500 }),
      failing: await collect({ mode: 'throw' }),
      nonStreaming: await callFacts(streaming, {}),
    };
  },

  async signedIn(config, input) {
    const app = newApp(config, false);
    const functions = getFunctions(app, input.region);
    const auth = getAuth(app);
    await signInWithCustomToken(auth, input.customToken);
    const v2 = await callFacts(httpsCallable(functions, 'pyricCallableEcho'), {});
    const v1 = await callFacts(httpsCallable(functions, 'pyricCallableV1'), {});
    await signOut(auth);
    const signedOut = await callFacts(httpsCallable(functions, 'pyricCallableEcho'), {});
    return { v2, v1, signedOut };
  },
};
`;
